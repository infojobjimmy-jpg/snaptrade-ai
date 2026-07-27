'use strict';

const express = require('express');
const path    = require('path');
const axios   = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

// Per-call Anthropic budgets — two calls must fit inside Railway's 60s proxy cut
const FIRST_PASS_TIMEOUT  = 28000; // ms
const SECOND_PASS_TIMEOUT = 22000; // ms
const HANDLER_BUDGET_MS   = 56000; // total handler budget

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// System prompts
// ─────────────────────────────────────────────────────────────

const SWING_SYSTEM_PROMPT = `Tu es un analyste technique senior qui lit des screenshots de graphiques de trading (forex, crypto, indices, actions).

Avant de conclure, fais TOUJOURS ce raisonnement en 4 étapes dans le champ "reasoning" (en français québécois, 4-6 phrases, une par étape):

1. QUALITÉ DE L'IMAGE: l'échelle de prix est-elle lisible? Le timeframe est-il visible? Si l'image est floue, trop petite, ou coupée, dis-le explicitement et baisse ta confiance en conséquence.
2. STRUCTURE DE TENDANCE: identifie si le prix fait des sommets/creux ascendants (haussier), descendants (baissier), ou latéral (range). Base-toi uniquement sur ce qui est visible dans l'image, n'invente rien.
3. NIVEAUX CLÉS: identifie les zones de support/résistance les plus évidentes visuellement (touchées au moins 2 fois) et l'endroit où le prix se trouve actuellement par rapport à ces zones.
4. SIGNAL RÉCENT: décris le pattern de chandelles le plus récent et significatif (cassure, rejet de mèche, engulfing, range serré, etc.) qui justifie la direction choisie.

RÈGLES DE CONFIANCE:
- Si l'échelle de prix n'est PAS lisible: mets entry/tp1/tp2/sl à null, et la confiance ne doit jamais dépasser 40.
- Si l'image est claire mais la structure est ambiguë (range serré, pas de tendance nette): confiance entre 40 et 60.
- Confiance au-dessus de 70 seulement si la tendance ET les niveaux ET le signal récent sont tous clairement alignés dans la même direction.
- Ne jamais donner une confiance de 90+ — l'analyse est basée sur une seule image statique, pas des données live.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ou après, sans backticks markdown:
{
  "symbol_guess": "string ou null si illisible",
  "direction": "buy" ou "sell",
  "confidence": nombre entre 0 et 100,
  "entry": nombre ou null,
  "tp1": nombre ou null,
  "tp2": nombre ou null,
  "sl": nombre ou null,
  "rr_ratio": "string ex: 1.5:1" ou null,
  "reasoning": "les 4 étapes condensées en 4-6 phrases"
}`;

const SCALP_SYSTEM_PROMPT = `Tu es un analyste technique qui lit des screenshots de graphiques de trading en contexte de SCALPING (timeframe M1-M5, horizon de quelques minutes seulement).

Le scalping sur une simple photo statique est intrinsèquement plus incertain qu'une analyse swing — pas de flux live, mouvements rapides, bruit élevé. Sois encore plus conservateur sur la confiance qu'en mode swing.

Avant de conclure, fais ce raisonnement en 4 étapes dans le champ "reasoning" (français québécois, 4-6 phrases courtes):
1. QUALITÉ/TIMEFRAME: l'échelle de prix est-elle lisible? Le timeframe visible confirme-t-il bien M1-M5? Si le timeframe semble plus haut (M15+), dis-le et baisse la confiance.
2. MOMENTUM IMMÉDIAT: décris uniquement les 3-5 dernières bougies (pas toute la structure) — direction, taille des bougies, mèches.
3. NIVEAU LE PLUS PROCHE: identifie le support ou résistance le plus proche du prix actuel — c'est ce qui compte pour un scalp.
4. DÉCLENCHEUR: quel pattern immédiat (cassure de range serré, rejet de mèche, micro-range) justifie une entrée MAINTENANT.

RÈGLES SPÉCIFIQUES AU SCALP:
- Les niveaux TP1/TP2/SL doivent être SERRÉS — de l'ordre de quelques points/pips par rapport à l'entry.
- Confiance maximale absolue: 65.
- Si le timeframe ne semble pas être M1-M5, mets confiance sous 35.
- Si le graphique est en range/chop, confiance sous 40.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ou après:
{
  "symbol_guess": "string ou null",
  "direction": "buy" ou "sell",
  "confidence": nombre 0-100,
  "entry": nombre ou null,
  "tp1": nombre ou null,
  "tp2": nombre ou null,
  "sl": nombre ou null,
  "rr_ratio": "string ex: 1.5:1" ou null,
  "reasoning": "les 4 étapes condensées en 4-6 phrases courtes"
}`;

const SECOND_PASS_SYSTEM_PROMPT = `Tu es un analyste technique. Tu viens d'analyser ce graphique visuellement. Tu reçois maintenant des DONNÉES DE MARCHÉ RÉELLES pour ce symbole.

RÈGLES POUR LES NIVEAUX (utilise les données réelles, pas l'estimation visuelle):
- entry: prix de clôture réel fourni
- Pour BUY  → sl = entry - 1.5×ATR | tp1 = entry + 1.5×ATR | tp2 = entry + 3×ATR
- Pour SELL → sl = entry + 1.5×ATR | tp1 = entry - 1.5×ATR | tp2 = entry - 3×ATR
- rr_ratio: toujours "2:1" (basé sur tp2 vs sl)
- Ajuste la direction si les indicateurs la contredisent (ex: RSI>70 → plutôt sell; prix sous SMA20 ET SMA50 → tendance baissière).
- Ajuste la confiance: +5 si RSI et SMAs confirment la direction, -5 si divergence.

Dans "reasoning", intègre les vrais chiffres (prix actuel, RSI, position par rapport aux SMAs, niveaux swing).

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ou après:
{
  "symbol_guess": "string ou null",
  "direction": "buy" ou "sell",
  "confidence": nombre 0-100,
  "entry": nombre ou null,
  "tp1": nombre ou null,
  "tp2": nombre ou null,
  "sl": nombre ou null,
  "rr_ratio": "2:1" ou null,
  "reasoning": "analyse en 3-4 phrases intégrant les vrais indicateurs"
}`;

// ─────────────────────────────────────────────────────────────
// Market data helpers
// ─────────────────────────────────────────────────────────────

const SYMBOL_MAP = {
  // Gold
  'GOLD': 'XAU/USD', 'XAUUSD': 'XAU/USD', 'XAU': 'XAU/USD',
  // Silver
  'SILVER': 'XAG/USD', 'XAGUSD': 'XAG/USD',
  // Major forex
  'EURUSD': 'EUR/USD', 'GBPUSD': 'GBP/USD', 'USDJPY': 'USD/JPY',
  'USDCHF': 'USD/CHF', 'AUDUSD': 'AUD/USD', 'NZDUSD': 'NZD/USD',
  'USDCAD': 'USD/CAD', 'EURGBP': 'EUR/GBP', 'EURJPY': 'EUR/JPY',
  'GBPJPY': 'GBP/JPY',
  // Crypto
  'BTCUSD': 'BTC/USD', 'BITCOIN': 'BTC/USD', 'BTC': 'BTC/USD',
  'ETHUSD': 'ETH/USD', 'ETHEREUM': 'ETH/USD', 'ETH': 'ETH/USD',
  'SOLUSD': 'SOL/USD', 'SOL': 'SOL/USD',
  // Indices
  'NASDAQ': 'NDX', 'NAS100': 'NDX', 'NASDAQ100': 'NDX',
  'SP500': 'SPX', 'S&P500': 'SPX', 'SPX500': 'SPX',
  'US30': 'DJI', 'DOW': 'DJI', 'DOWJONES': 'DJI',
  'DAX': 'DAX', 'DAX40': 'DAX',
  'FTSE': 'FTSE', 'FTSE100': 'FTSE',
  'US100': 'NDX', 'US500': 'SPX',
};

// Commodity futures → Yahoo Finance tickers (Twelve Data free plan does NOT support these)
const YAHOO_COMMODITY_MAP = {
  // Brent crude
  'XBRUSD': 'BZ=F', 'XBR': 'BZ=F', 'BRENT': 'BZ=F', 'BRENTUSD': 'BZ=F', 'UKOIL': 'BZ=F',
  // WTI crude
  'XTIUSD': 'CL=F', 'XTI': 'CL=F', 'WTI': 'CL=F', 'WTIUSD': 'CL=F', 'USOIL': 'CL=F', 'CRUDEOIL': 'CL=F',
  // Natural gas
  'XNGUSD': 'NG=F', 'XNG': 'NG=F', 'NATGAS': 'NG=F', 'NATURALGAS': 'NG=F',
};

function normalizeSymbol(raw) {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (SYMBOL_MAP[s]) return SYMBOL_MAP[s];
  // Already has slash (e.g. "EUR/USD") — pass through
  if (s.includes('/')) return s;
  // 6-char alpha → try forex pair split
  if (/^[A-Z]{6}$/.test(s)) return s.slice(0, 3) + '/' + s.slice(3);
  return s;
}

function modeToInterval(mode) {
  return mode === 'scalp' ? '5min' : '1h';
}

function modeToYahooInterval(mode) {
  return mode === 'scalp' ? '5m' : '1h';
}

async function fetchMarketData(symbol, interval) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return null;

  const url = 'https://api.twelvedata.com/time_series';
  const resp = await axios.get(url, {
    params: { symbol: normalized, interval, outputsize: 60, apikey: key },
    timeout: 8000,
  });

  const data = resp.data;
  if (data.status === 'error' || !Array.isArray(data.values) || data.values.length < 15) {
    const msg = data.message || 'no values';
    const planLimit = msg.toLowerCase().includes('grow') || msg.toLowerCase().includes('venture') || msg.toLowerCase().includes('plan');
    console.warn(`[market] Twelve Data ${planLimit ? '(PLAN LIMIT — upgrade required)' : 'error'} for ${normalized}: ${msg}`);
    return null;
  }

  // Twelve Data returns newest first — reverse for chronological order
  const candles = data.values.slice().reverse().map(c => ({
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close),
    dt:    c.datetime,
  }));

  return { symbol: normalized, interval, candles };
}

async function fetchYahooFinance(yahooTicker, yahooInterval) {
  const range = '5d'; // 5 days covers 60+ hourly or 390+ 5-min bars
  const resp = await axios.get(
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooTicker),
    {
      params: { interval: yahooInterval, range },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 8000,
    }
  );

  const result = resp.data?.chart?.result?.[0];
  if (!result) {
    console.warn(`[market] Yahoo Finance: no result for ${yahooTicker}`);
    return null;
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!timestamps || !quote?.close) {
    console.warn(`[market] Yahoo Finance: incomplete OHLC for ${yahooTicker}`);
    return null;
  }

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close[i];
    if (close == null) continue;
    candles.push({
      open:  quote.open[i]  ?? close,
      high:  quote.high[i]  ?? close,
      low:   quote.low[i]   ?? close,
      close,
      dt: new Date(timestamps[i] * 1000).toISOString(),
    });
  }

  if (candles.length < 15) {
    console.warn(`[market] Yahoo Finance: only ${candles.length} candles for ${yahooTicker} — need 15+`);
    return null;
  }

  // Yahoo Finance already returns chronological order (oldest first)
  return { symbol: yahooTicker, interval: yahooInterval, candles };
}

function calculateIndicators(candles) {
  const n       = candles.length;
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);

  const currentPrice = closes[n - 1];

  // SMA
  const sma = (arr, period) => arr.length >= period
    ? arr.slice(-period).reduce((a, b) => a + b, 0) / period
    : null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);

  // RSI(14) — Wilder's smoothing
  let rsi = null;
  if (n >= 15) {
    const deltas = closes.slice(1).map((c, i) => c - closes[i]);
    const gains  = deltas.map(d => Math.max(d, 0));
    const losses = deltas.map(d => Math.max(-d, 0));
    let ag = gains.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    let al = losses.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    for (let i = 14; i < deltas.length; i++) {
      ag = (ag * 13 + gains[i]) / 14;
      al = (al * 13 + losses[i]) / 14;
    }
    rsi = al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
  }

  // ATR(14) — Wilder's smoothing
  let atr = null;
  if (n >= 15) {
    const trs = candles.slice(1).map((c, i) => Math.max(
      c.high - c.low,
      Math.abs(c.high - candles[i].close),
      Math.abs(c.low  - candles[i].close)
    ));
    let atrVal = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    for (let i = 14; i < trs.length; i++) atrVal = (atrVal * 13 + trs[i]) / 14;
    atr = parseFloat(atrVal.toPrecision(6));
  }

  // Swing high/low over last 20 candles
  const slice20H = highs.slice(-20);
  const slice20L = lows.slice(-20);
  const swingHigh = parseFloat(Math.max(...slice20H).toPrecision(8));
  const swingLow  = parseFloat(Math.min(...slice20L).toPrecision(8));

  return {
    currentPrice: parseFloat(currentPrice.toPrecision(8)),
    sma20: sma20 !== null ? parseFloat(sma20.toPrecision(8)) : null,
    sma50: sma50 !== null ? parseFloat(sma50.toPrecision(8)) : null,
    rsi,
    atr,
    swingHigh,
    swingLow,
  };
}

function buildMarketDataText(symbol, interval, ind, firstDirection) {
  const fmt = v => (v != null ? v : 'N/A');
  return [
    `DONNÉES DE MARCHÉ RÉELLES — ${symbol} (${interval}):`,
    `Prix de clôture actuel : ${fmt(ind.currentPrice)}`,
    `RSI(14)               : ${fmt(ind.rsi)}`,
    `SMA(20)               : ${fmt(ind.sma20)}`,
    `SMA(50)               : ${fmt(ind.sma50)}`,
    `ATR(14)               : ${fmt(ind.atr)}`,
    `Swing High 20 bougies : ${fmt(ind.swingHigh)}`,
    `Swing Low  20 bougies : ${fmt(ind.swingLow)}`,
    ``,
    `Analyse visuelle initiale : direction=${firstDirection}`,
    ``,
    `Finalise l'analyse en utilisant ces vrais chiffres. Applique les règles ATR pour entry/tp1/tp2/sl.`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// JSON helpers
// ─────────────────────────────────────────────────────────────

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return JSON.parse(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) return JSON.parse(brace[0]);
  throw new Error('No valid JSON found in Claude response');
}

function validateSignal(data) {
  if (!['buy', 'sell'].includes(data.direction))
    throw new Error(`Invalid direction: ${data.direction}`);
  if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 100)
    throw new Error(`Invalid confidence: ${data.confidence}`);
  return {
    symbol_guess: data.symbol_guess ?? null,
    direction:    data.direction,
    confidence:   Math.round(data.confidence),
    entry:        data.entry    ?? null,
    tp1:          data.tp1      ?? null,
    tp2:          data.tp2      ?? null,
    sl:           data.sl       ?? null,
    rr_ratio:     data.rr_ratio != null ? data.rr_ratio : null,
    reasoning:    typeof data.reasoning === 'string' ? data.reasoning : '',
  };
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/analyze-chart', async (req, res) => {
  const handlerStart = Date.now();
  const elapsed      = () => `${Date.now() - handlerStart}ms`;
  const remaining    = () => HANDLER_BUDGET_MS - (Date.now() - handlerStart);

  try {
    const { image_base64, media_type, mode, symbol_override } = req.body;

    if (!image_base64 || typeof image_base64 !== 'string')
      return res.status(400).json({ error: 'Champ image_base64 manquant ou invalide.' });
    if (!media_type || typeof media_type !== 'string')
      return res.status(400).json({ error: 'Champ media_type manquant ou invalide.' });

    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowed.includes(media_type))
      return res.status(400).json({ error: `Type non supporté. Acceptés : ${allowed.join(', ')}` });

    const activeMode   = mode === 'scalp' ? 'scalp' : 'swing';
    const firstPrompt  = activeMode === 'scalp' ? SCALP_SYSTEM_PROMPT : SWING_SYSTEM_PROMPT;
    const imagePayload = { type: 'image', source: { type: 'base64', media_type, data: image_base64 } };
    const imageSizeKB  = Math.round(image_base64.length * 0.75 / 1024);

    console.log(`[analyze] START — ${imageSizeKB}KB, mode=${activeMode}`);

    // ── Pass 1: Vision analysis ──────────────────────────────
    const pass1Msg = await client.messages.create(
      {
        model: 'claude-opus-4-8',
        max_tokens: 1200,
        system: firstPrompt,
        messages: [{ role: 'user', content: [imagePayload, { type: 'text', text: 'Analyse ce graphique et retourne le JSON du signal.' }] }],
      },
      { timeout: FIRST_PASS_TIMEOUT, maxRetries: 0 }
    );
    const pass1Signal = validateSignal(extractJSON(pass1Msg.content[0]?.text ?? ''));
    console.log(`[analyze] Pass1 done — ${elapsed()} — symbol=${pass1Signal.symbol_guess}, dir=${pass1Signal.direction}`);

    // ── Market data fetch ────────────────────────────────────
    let dataSource  = 'vision_only';
    let indicators  = null;
    let marketSym   = null;
    let finalSignal = pass1Signal;

    const rawSymbol   = ((symbol_override?.trim() || pass1Signal.symbol_guess) ?? '').toUpperCase().replace(/\s+/g, '');
    const yahooTicker = rawSymbol ? YAHOO_COMMODITY_MAP[rawSymbol] : null;
    const hasTwelve   = !!process.env.TWELVE_DATA_API_KEY;

    if (!rawSymbol) {
      console.log('[analyze] No symbol detected — vision_only');
    } else if (remaining() <= 12000) {
      console.warn(`[analyze] Insufficient time (${remaining()}ms) for market data — vision_only`);
    } else if (!yahooTicker && !hasTwelve) {
      console.log(`[analyze] No market data key configured — vision_only`);
    } else {
      try {
        let marketData  = null;
        let fetchInterval;

        if (yahooTicker) {
          fetchInterval = modeToYahooInterval(activeMode);
          console.log(`[analyze] Commodity detected: ${rawSymbol} → Yahoo Finance ${yahooTicker} (${fetchInterval})`);
          marketData = await fetchYahooFinance(yahooTicker, fetchInterval);
        } else {
          fetchInterval = modeToInterval(activeMode);
          const normalized = normalizeSymbol(rawSymbol);
          console.log(`[analyze] Fetching Twelve Data: ${rawSymbol} → ${normalized} (${fetchInterval})`);
          marketData = await fetchMarketData(rawSymbol, fetchInterval);
        }

        if (!marketData) {
          console.warn(`[analyze] No market data returned for ${rawSymbol} — vision_only`);
        } else {
          indicators = calculateIndicators(marketData.candles);
          marketSym  = marketData.symbol;
          console.log(`[analyze] Market data OK — ${marketSym} (${fetchInterval}), price=${indicators.currentPrice}, RSI=${indicators.rsi}, ATR=${indicators.atr}`);

          // ── Pass 2: Finalize with real data ─────────────────
          if (remaining() > 8000) {
            const dataText = buildMarketDataText(marketSym, fetchInterval, indicators, pass1Signal.direction);
            const pass2Msg = await client.messages.create(
              {
                model: 'claude-opus-4-8',
                max_tokens: 1000,
                system: SECOND_PASS_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: [imagePayload, { type: 'text', text: dataText }] }],
              },
              { timeout: Math.min(SECOND_PASS_TIMEOUT, remaining() - 2000), maxRetries: 0 }
            );
            finalSignal = validateSignal(extractJSON(pass2Msg.content[0]?.text ?? ''));
            dataSource  = 'vision_plus_market_data';
            console.log(`[analyze] Pass2 done — ${elapsed()} — entry=${finalSignal.entry}, sl=${finalSignal.sl}, tp1=${finalSignal.tp1}`);
          } else {
            console.warn(`[analyze] Not enough time for pass2 (${remaining()}ms left) — vision_only`);
          }
        }
      } catch (mktErr) {
        console.warn(`[analyze] Market data failed (${elapsed()}):`, mktErr.message);
        // Fall through — vision_only result already set
      }
    }

    console.log(`[analyze] DONE — ${elapsed()}, data_source=${dataSource}`);
    return res.json({
      ...finalSignal,
      mode:        activeMode,
      data_source: dataSource,
      indicators:  indicators,
    });

  } catch (err) {
    console.error(`[analyze] ERROR at ${elapsed()}:`, err.name, err.message);
    if (res.headersSent) return;

    if (err.name === 'APITimeoutError' || err.name === 'AbortError' || err.code === 'ETIMEDOUT')
      return res.status(504).json({ error: `Délai dépassé. Réessayez dans un instant.` });
    if (err.status === 401)
      return res.status(500).json({ error: 'Clé API Anthropic invalide.' });
    if (err.status === 429)
      return res.status(429).json({ error: 'Limite de débit atteinte. Attendez quelques secondes.' });
    if (err instanceof SyntaxError || err.message?.includes('JSON'))
      return res.status(502).json({ error: 'Réponse IA invalide. Réessayez.' });

    return res.status(500).json({ error: err.message || 'Erreur serveur interne.' });
  }
});

// Global error handler — ensures body-parser errors return JSON
app.use((err, req, res, _next) => {
  console.error('[Express Error]', err.status, err.message);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 413
      ? 'Image trop volumineuse (max ~35MB).'
      : (err.message || 'Erreur serveur.'),
  });
});

const server = app.listen(PORT, () => {
  console.log(`SnapTrade AI running on http://localhost:${PORT}`);
});

server.timeout          = 120000;
server.keepAliveTimeout = 120000;
server.headersTimeout   = 125000;
