'use strict';

const express      = require('express');
const path         = require('path');
const crypto       = require('crypto');
const axios        = require('axios');
const Anthropic    = require('@anthropic-ai/sdk');
const rateLimit    = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// Volatile ledger for the paper-trading confirmation flow. It is intentionally
// isolated from every broker/FIX connector: no live order can leave this app.
const paperOrders = [];
const PAPER_ORDER_LIMIT = 250;
const PAPER_PLATFORMS = new Set(['snaptrade-paper', 'mt5-demo', 'ctrader-demo']);

// Plateformes routées vers le pont EA MT5 (exécution réelle sur un terminal)
const BRIDGE_PLATFORMS = new Set(['mt5-demo', 'mt5-live']);

// Règles de gestion de position appliquées par l'EA. Snapshot copié dans
// chaque ordre pour que l'EA sache quoi faire même si on change ça plus tard.
const ORDER_RULES = {
  position_count:       1,          // une seule position par signal
  entry_tolerance_r:    0.25,       // marché si le prix est à < 25 % de la distance entry↔SL, sinon ordre limite
  pending_expiry_min:   60,
  be_at_tp1:            true,       // SL remonte au break-even quand le prix touche TP1
  be_buffer_points:     2,          // + quelques points au-delà de l'entry (spread/commission)
  trailing:             true,       // après le BE, le SL suit le prix
  trail_atr_mult:       1.5,        // distance de trailing = 1.5 × ATR (sinon = distance TP1 si ATR absent)
  trail_min_step_points: 5,
  hard_tp:              'tp2',      // plafond : TP posé à TP2, le trailing travaille en dessous
};

// Trust Railway's reverse proxy so req.ip reflects the real client IP
app.set('trust proxy', 1);

// Per-call Anthropic budgets — two calls must fit inside Railway's 60s proxy cut
const FIRST_PASS_TIMEOUT  = 28000; // ms
const SECOND_PASS_TIMEOUT = 22000; // ms
const HANDLER_BUDGET_MS   = 56000; // total handler budget

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!supabase) console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — scan history disabled');

// ─────────────────────────────────────────────────────────────
// Telemetry helpers — events log + live presence
// Toutes les écritures sont fire-and-forget : jamais bloquantes.
// ─────────────────────────────────────────────────────────────

function clientMeta(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip  = fwd || req.ip || req.socket?.remoteAddress || null;
  const rawCountry = req.headers['cf-ipcountry']
                  || req.headers['x-vercel-ip-country']
                  || req.headers['x-geo-country']
                  || null;
  const country = rawCountry && !['XX', 'T1'].includes(rawCountry) ? rawCountry : null;
  const ua = (req.headers['user-agent'] || '').slice(0, 400) || null;
  return { ip, country, ua };
}

// Même métadonnées, mais nommées comme les colonnes de la table `scans`
function clientMetaCols(req) {
  const { ip, country, ua } = clientMeta(req);
  return { ip, country, user_agent: ua };
}

function logEvent(type, req, extra = {}) {
  if (!supabase) return;
  const { ip, country, ua } = clientMeta(req);
  supabase.from('events').insert({
    type,
    whop_user_id: extra.whop_user_id || req.whopUserId || (req.body && req.body.whop_user_id) || null,
    whop_plan:    extra.whop_plan   || req.whopPlan   || null,
    ip,
    country,
    user_agent: ua,
    path: extra.path || req.originalUrl || null,
    meta: extra.meta || null,
  }).then(
    ({ error }) => { if (error) console.error('[events] insert error:', error.message); },
    (err)       => console.error('[events] exception:', err.message)
  );
}

// Whop plan IDs — map plan_xxx → tier name (4 plans under 1 SnapTrade AI product)
const WHOP_PLANS = {
  essai:     process.env.WHOP_PLAN_ID_ESSAI,
  fondateur: process.env.WHOP_PLAN_ID_FONDATEUR,
  standard:  process.env.WHOP_PLAN_ID_STANDARD,
  pro:       process.env.WHOP_PLAN_ID_PRO,
};
// Whop checkout links (used in 403 error messages)
const WHOP_UPGRADE_URL = process.env.WHOP_UPGRADE_URL || 'https://whop.com/snaptrade-ai';

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

// ══════════════════════════════════════════════════════════════
//  SUIVI DES RÉSULTATS DE SIGNAUX (Phase 3 — additif)
//  Vérifie périodiquement si TP1/TP2/SL a été touché depuis chaque
//  scan, en rejouant les bougies réelles depuis created_at (pas
//  juste le prix actuel — capture les hits intra-période aussi).
// ══════════════════════════════════════════════════════════════
const OUTCOME_MIN_AGE_MS   = 60 * 60 * 1000;       // laisse au moins 1h avant de vérifier
const OUTCOME_EXPIRY_MS    = 7 * 24 * 60 * 60 * 1000; // abandonne après 7 jours sans résultat
const OUTCOME_CHECK_MS     = 60 * 60 * 1000;       // vérifie toutes les heures

function resolveOutcomeSymbol(scan) {
  const raw = ((scan.symbol_override || scan.symbol_guess) ?? '').toString().toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  const yahooTicker = YAHOO_COMMODITY_MAP[raw];
  if (yahooTicker) return { kind: 'yahoo', ticker: yahooTicker, interval: modeToYahooInterval(scan.mode) };
  const normalized = normalizeSymbol(raw);
  if (!normalized) return null;
  return { kind: 'twelvedata', ticker: normalized, interval: modeToInterval(scan.mode) };
}

async function fetchCandlesSince(resolved, sinceISO) {
  const data = resolved.kind === 'yahoo'
    ? await fetchYahooFinance(resolved.ticker, resolved.interval)
    : await fetchMarketData(resolved.ticker, resolved.interval);
  if (!data) return null;
  const since = new Date(sinceISO).getTime();
  return data.candles.filter(c => new Date(c.dt).getTime() >= since);
}

// Rejoue les bougies dans l'ordre chronologique et retourne le PREMIER
// niveau touché (SL prioritaire si touché la même bougie qu'un TP —
// hypothèse prudente, ne surestime jamais la performance).
function determineOutcome(scan, candles) {
  const { direction, entry, sl, tp1, tp2 } = scan;
  if (!direction || entry == null || sl == null) return null;
  const isBuy = direction.toUpperCase() === 'BUY';

  for (const c of candles) {
    const slHit  = isBuy ? c.low  <= sl  : c.high >= sl;
    const tp2Hit = tp2 != null && (isBuy ? c.high >= tp2 : c.low <= tp2);
    const tp1Hit = tp1 != null && (isBuy ? c.high >= tp1 : c.low <= tp1);

    if (slHit) return { outcome: 'sl', hit_price: sl, hit_at: c.dt };
    if (tp2Hit) return { outcome: 'tp2', hit_price: tp2, hit_at: c.dt };
    if (tp1Hit) return { outcome: 'tp1', hit_price: tp1, hit_at: c.dt };
  }
  return null; // rien touché encore dans cette fenêtre
}

async function checkPendingOutcomes() {
  if (!supabase) return;
  try {
    const cutoffFresh  = new Date(Date.now() - OUTCOME_MIN_AGE_MS).toISOString();
    const cutoffExpiry = new Date(Date.now() - OUTCOME_EXPIRY_MS).toISOString();

    const { data: scans, error } = await supabase
      .from('scans')
      .select('id, symbol_guess, symbol_override, direction, entry, sl, tp1, tp2, mode, created_at, signal_outcomes(outcome, checked_count)')
      .not('entry', 'is', null)
      .not('sl', 'is', null)
      .lte('created_at', cutoffFresh)
      .limit(50);

    if (error) { console.error('[outcomes] fetch scans error:', error.message); return; }
    if (!scans?.length) return;

    let checked = 0, resolved = 0;
    for (const scan of scans) {
      const existing = Array.isArray(scan.signal_outcomes) ? scan.signal_outcomes[0] : scan.signal_outcomes;
      if (existing && existing.outcome !== 'pending') continue; // déjà résolu

      if (scan.created_at <= cutoffExpiry) {
        await supabase.from('signal_outcomes').upsert({
          scan_id: scan.id, outcome: 'expired',
          checked_count: (existing?.checked_count || 0) + 1, last_checked_at: new Date().toISOString(),
        }, { onConflict: 'scan_id' });
        continue;
      }

      const resolvedSym = resolveOutcomeSymbol(scan);
      if (!resolvedSym) continue;

      checked++;
      try {
        const candles = await fetchCandlesSince(resolvedSym, scan.created_at);
        if (!candles?.length) continue;

        const result = determineOutcome(scan, candles);
        const hoursAfter = result ? (new Date(result.hit_at) - new Date(scan.created_at)) / 3600000 : null;

        await supabase.from('signal_outcomes').upsert({
          scan_id: scan.id,
          outcome: result ? result.outcome : 'pending',
          hit_price: result ? result.hit_price : null,
          hit_at: result ? result.hit_at : null,
          hours_after: hoursAfter,
          checked_count: (existing?.checked_count || 0) + 1,
          last_checked_at: new Date().toISOString(),
        }, { onConflict: 'scan_id' });

        if (result) resolved++;
      } catch (e) {
        console.warn(`[outcomes] check failed for scan ${scan.id}:`, e.message);
      }
    }
    if (checked > 0) console.log(`[outcomes] Vérifié ${checked} signaux, ${resolved} résolus cette passe.`);
  } catch (e) {
    console.error('[outcomes] checkPendingOutcomes exception:', e.message);
  }
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
// Position sizing
// ─────────────────────────────────────────────────────────────

function getContractInfo(symbol) {
  if (!symbol) return { contractSize: 100000, type: 'forex' };
  const s = symbol.toUpperCase().replace(/[\s/=\-]/g, '');
  // Gold (XAU/USD, GC=F)
  if (/XAU|GCF|^GOLD$/.test(s))  return { contractSize: 100,    type: 'gold (100 oz/lot)' };
  // Silver (XAG/USD, SI=F)
  if (/XAG|SIF|^SILVER$/.test(s)) return { contractSize: 5000,   type: 'silver (5000 oz/lot)' };
  // Oil & natural gas (Yahoo: BZ=F→BZF, CL=F→CLF, NG=F→NGF; MT5: XBR, XTI, XNG)
  if (/^(BZF|CLF|NGF)$|XBR|XTI|XNG|BRENT|WTI|UKOIL|USOIL|NATGAS|CRUDE/.test(s))
    return { contractSize: 1000, type: 'oil/gas (1000 barrels/lot)' };
  // Crypto (no standard lot — 1 unit per lot)
  if (/^(BTC|ETH|SOL|XRP|ADA|DOT|LINK|AVAX|DOGE|MATIC|UNI|LTC|BCH|ATOM)/.test(s))
    return { contractSize: 1, type: 'crypto (1 unit/lot)' };
  // Indices ($1/point generic — varies greatly by broker)
  if (/NDX|SPX|DJI|DAX|FTSE|NAS100|US30|US500|US100|CAC40|NIKKEI|VIX/.test(s))
    return { contractSize: 1, type: 'index ($1/point estimate)' };
  // Default: forex (EUR/USD, GBP/USD, etc.)
  return { contractSize: 100000, type: 'forex (100k units/lot)' };
}

function calculateLotSize(accountBalance, riskPercent, entry, sl, symbol) {
  const balance  = parseFloat(accountBalance);
  const risk     = parseFloat(riskPercent);
  const entryNum = parseFloat(entry);
  const slNum    = parseFloat(sl);

  if (!isFinite(balance) || balance <= 0)           return null;
  if (!isFinite(risk)    || risk <= 0 || risk > 100) return null;
  if (!isFinite(entryNum) || !isFinite(slNum))       return null;

  const slDistance = Math.abs(entryNum - slNum);
  if (slDistance === 0) return null;

  const { contractSize, type } = getContractInfo(symbol);
  const riskAmount  = balance * (risk / 100);
  const rawLotSize  = riskAmount / (slDistance * contractSize);
  const lotSize     = Math.max(0.01, Math.round(rawLotSize * 100) / 100);

  console.log(`[sizing] symbol=${symbol} → ${type} | contractSize=${contractSize} | slDist=${slDistance} | riskAmt=${riskAmount.toFixed(2)} → ${lotSize} lots`);

  return {
    lot_size:          lotSize,
    risk_amount:       parseFloat(riskAmount.toFixed(2)),
    lot_size_is_estimate: true,
  };
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

function validatePaperOrder(body) {
  const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
  const direction = typeof body.direction === 'string' ? body.direction.toLowerCase() : '';
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  const whopUserId = typeof body.whop_user_id === 'string' ? body.whop_user_id.trim() : '';
  const numbers = ['entry', 'tp1', 'tp2', 'sl', 'lot_size'].reduce((acc, key) => {
    acc[key] = Number(body[key]);
    return acc;
  }, {});

  if (!whopUserId) throw new Error('ID membre Whop requis.');
  if (!PAPER_PLATFORMS.has(platform)) throw new Error('Plateforme de démonstration invalide.');
  if (!['buy', 'sell'].includes(direction)) throw new Error('Direction invalide.');
  if (!symbol || symbol.length > 30 || !/^[A-Z0-9/_.=-]+$/.test(symbol))
    throw new Error('Symbole invalide.');
  if (Object.values(numbers).some(value => !Number.isFinite(value) || value <= 0))
    throw new Error('Entry, TP1, TP2, SL et lot doivent être des nombres positifs.');
  if (numbers.lot_size > 100) throw new Error('Lot de démonstration trop élevé.');

  const levelsAreValid = direction === 'buy'
    ? numbers.sl < numbers.entry && numbers.tp1 > numbers.entry && numbers.tp2 >= numbers.tp1
    : numbers.sl > numbers.entry && numbers.tp1 < numbers.entry && numbers.tp2 <= numbers.tp1;
  if (!levelsAreValid) throw new Error('Les niveaux Entry, TP et SL ne correspondent pas à la direction du signal.');

  return { platform, direction, symbol, whopUserId, ...numbers };
}

// ─────────────────────────────────────────────────────────────
// Supabase helpers
// ─────────────────────────────────────────────────────────────

async function saveScan(row) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('scans').insert(row);
    if (error) console.error('[supabase] Insert scan error:', error.message);
    else       console.log('[supabase] Scan saved for user:', row.whop_user_id || 'anonymous');
  } catch (err) {
    console.error('[supabase] saveScan exception:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Whop membership check
// ─────────────────────────────────────────────────────────────

async function getWhopPlan(whopUserId) {
  const key = process.env.WHOP_API_KEY;
  if (!key) return 'dev'; // no key configured — allow all (local dev)

  // If no plan IDs are configured yet, gating is not yet active — allow through
  const anyPlanConfigured = Object.values(WHOP_PLANS).some(Boolean);
  if (!anyPlanConfigured) return 'dev';

  try {
    const resp = await axios.get('https://api.whop.com/api/v2/memberships', {
      params: { user_id: whopUserId, per: 50 },
      headers: { Authorization: `Bearer ${key}` },
      timeout: 6000,
    });

    const memberships = resp.data?.data || [];
    // Build reverse map: plan_xxx → tier name
    const planMap = {};
    for (const [tier, planId] of Object.entries(WHOP_PLANS)) {
      if (planId) planMap[planId] = tier;
    }

    // Priority: pro > fondateur > standard > essai
    // Accept active + trialing (free trial) — check valid:true instead of filtering by status
    const priority = ['pro', 'fondateur', 'standard', 'essai'];
    const foundTiers = new Set();
    for (const m of memberships) {
      if (!m.valid) continue; // skip expired/cancelled
      const planId = m.plan; // e.g. "plan_xxx"
      if (planMap[planId]) foundTiers.add(planMap[planId]);
    }
    for (const p of priority) {
      if (foundTiers.has(p)) return p;
    }
    return null;
  } catch (err) {
    console.error('[whop] Membership check error:', err.message);
    return null; // fail closed on network error
  }
}

// ─────────────────────────────────────────────────────────────
// Quota management (Supabase user_quotas table)
// ─────────────────────────────────────────────────────────────

async function checkAndIncrementQuota(whopUserId, plan) {
  if (!supabase) return { allowed: true }; // no DB = no quota enforcement

  const now = new Date();

  // Upsert quota row
  let { data: quota, error: fetchErr } = await supabase
    .from('user_quotas')
    .select('*')
    .eq('whop_user_id', whopUserId)
    .single();

  if (fetchErr && fetchErr.code === 'PGRST116') {
    // First time this user — create row
    const { data: newRow, error: insErr } = await supabase
      .from('user_quotas')
      .insert({ whop_user_id: whopUserId, plan, period_start: now })
      .select()
      .single();
    if (insErr) { console.error('[quota] Insert error:', insErr.message); return { allowed: true }; }
    quota = newRow;
  } else if (fetchErr) {
    console.error('[quota] Fetch error:', fetchErr.message);
    return { allowed: true }; // fail open on unexpected DB error
  }

  // Sync plan if it changed (e.g. user upgraded)
  if (quota.plan !== plan) {
    await supabase.from('user_quotas').update({ plan, updated_at: now }).eq('whop_user_id', whopUserId);
    quota.plan = plan;
  }

  // Monthly reset for standard plan
  const periodStart = new Date(quota.period_start);
  const monthsPassed = (now.getFullYear() - periodStart.getFullYear()) * 12 + (now.getMonth() - periodStart.getMonth());
  if (monthsPassed >= 1 && plan === 'standard') {
    await supabase.from('user_quotas')
      .update({ scans_used_this_month: 0, period_start: now, updated_at: now })
      .eq('whop_user_id', whopUserId);
    quota.scans_used_this_month = 0;
  }

  // Quota checks
  if (plan === 'essai' && quota.scans_used_lifetime >= 5) {
    return { allowed: false, reason: 'quota_essai' };
  }
  if (plan === 'standard' && quota.scans_used_this_month >= 300) {
    return { allowed: false, reason: 'quota_standard' };
  }
  // pro and fondateur: unlimited (rate limit still applies via IP middleware)

  // Increment counters atomically
  const { error: updErr } = await supabase.from('user_quotas').update({
    scans_used_this_month: (quota.scans_used_this_month || 0) + 1,
    scans_used_lifetime:   (quota.scans_used_lifetime   || 0) + 1,
    updated_at: now,
  }).eq('whop_user_id', whopUserId);
  if (updErr) console.error('[quota] Increment error:', updErr.message);

  return { allowed: true };
}

// ─────────────────────────────────────────────────────────────
// Whop gating middleware
// ─────────────────────────────────────────────────────────────

async function whopGating(req, res, next) {
  const whopUserId = (req.body?.whop_user_id || '').toString().trim();

  if (!whopUserId) {
    logEvent('auth_fail', req, { meta: { reason: 'missing_whop_id' } });
    return res.status(401).json({ error: 'ID membre Whop requis. Entre ton ID dans le champ en haut du formulaire.' });
  }

  const plan = await getWhopPlan(whopUserId);

  if (plan === null) {
    logEvent('auth_fail', req, { whop_user_id: whopUserId, meta: { reason: 'no_active_sub' } });
    return res.status(403).json({
      error: `Aucun abonnement SnapTrade AI actif trouvé. Obtiens l'accès sur ${WHOP_UPGRADE_URL}`,
    });
  }

  const quota = await checkAndIncrementQuota(whopUserId, plan);

  if (!quota.allowed) {
    logEvent('quota_block', req, { whop_user_id: whopUserId, whop_plan: plan, meta: { reason: quota.reason } });
    const msgs = {
      quota_essai:    `Tu as utilisé tes 5 scans gratuits à vie. Passe au plan Standard (14.99$/mois) → ${WHOP_UPGRADE_URL}`,
      quota_standard: `Tu as atteint ta limite de 300 scans ce mois-ci. Passe au plan Pro (24.99$/mois) → ${WHOP_UPGRADE_URL}`,
    };
    return res.status(403).json({ error: msgs[quota.reason] || 'Quota atteint pour ton palier.' });
  }

  req.whopUserId = whopUserId;
  req.whopPlan   = plan;
  next();
}

// ─────────────────────────────────────────────────────────────
// Rate limiting — /api/analyze-chart
//
// Ces seuils sont un point de départ conservateur pour bloquer l'abus
// par script avant le lancement des paliers payants. Une fois Whop +
// Supabase en place, remplacer ces limites IP par des quotas par
// utilisateur liés à l'abonnement (ex: 50/jour Free, 200/jour Pro).
// ─────────────────────────────────────────────────────────────

const RATE_LIMIT_MSG = { error: 'Trop de requêtes. Réessaie dans quelques minutes.' };

// 20 scans / heure par IP — protège contre l'abus soutenu
const hourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-6', // ajoute RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset
  legacyHeaders: false,
  handler: (req, res) => { logEvent('rate_limit', req, { meta: { limiter: 'hourly' } }); res.status(429).json(RATE_LIMIT_MSG); },
});

// 5 scans / 10 min par IP — protège contre le spam en rafale
const burstLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  handler: (req, res) => { logEvent('rate_limit', req, { meta: { limiter: 'burst' } }); res.status(429).json(RATE_LIMIT_MSG); },
});

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/analyze-chart', hourlyLimiter, burstLimiter, whopGating, async (req, res) => {
  const handlerStart = Date.now();
  const elapsed      = () => `${Date.now() - handlerStart}ms`;
  const remaining    = () => HANDLER_BUDGET_MS - (Date.now() - handlerStart);

  try {
    const { image_base64, media_type, mode, symbol_override, accountBalance, riskPercent } = req.body;
    console.log(`[sizing] received accountBalance=${accountBalance} riskPercent=${riskPercent}`);

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
    logEvent('analyze_start', req, { meta: { mode: activeMode, image_kb: imageSizeKB, symbol_override: (symbol_override || '').toString().trim() || null } });

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

    // ── Position sizing ──────────────────────────────────────
    const bestSymbol = finalSignal.symbol_guess || marketSym || rawSymbol || null;
    const sizing = calculateLotSize(accountBalance, riskPercent, finalSignal.entry, finalSignal.sl, bestSymbol);

    const latencyMs = Date.now() - handlerStart;
    console.log(`[analyze] DONE — ${elapsed()}, data_source=${dataSource}`);

    // Fire-and-forget — never block the response on DB write
    const whopUserId = req.whopUserId || req.body.whop_user_id || null;
    saveScan({
      whop_user_id:     whopUserId,
      whop_plan:        req.whopPlan || null,
      symbol_guess:     finalSignal.symbol_guess,
      symbol_override:  (symbol_override || '').toString().trim() || null,
      direction:        finalSignal.direction,
      confidence:       finalSignal.confidence,
      entry:            finalSignal.entry,
      tp1:              finalSignal.tp1,
      tp2:              finalSignal.tp2,
      sl:               finalSignal.sl,
      rr_ratio:         finalSignal.rr_ratio,
      mode:             activeMode,
      data_source:      dataSource,
      lot_size:         sizing ? sizing.lot_size : null,
      reasoning:        finalSignal.reasoning,
      pass1_direction:  pass1Signal.direction,
      pass1_confidence: pass1Signal.confidence,
      indicators:       indicators,
      account_balance:  Number.isFinite(parseFloat(accountBalance)) ? parseFloat(accountBalance) : null,
      risk_pct:         Number.isFinite(parseFloat(riskPercent))    ? parseFloat(riskPercent)    : null,
      image_size_kb:    imageSizeKB,
      latency_ms:       latencyMs,
      ...clientMetaCols(req),
    });
    logEvent('analyze_success', req, { whop_user_id: whopUserId, whop_plan: req.whopPlan || null, meta: {
      mode: activeMode, data_source: dataSource, direction: finalSignal.direction,
      confidence: finalSignal.confidence, symbol: finalSignal.symbol_guess || marketSym || rawSymbol || null,
      latency_ms: latencyMs,
    } });

    return res.json({
      ...finalSignal,
      mode:               activeMode,
      data_source:        dataSource,
      indicators:         indicators,
      lot_size:           sizing ? sizing.lot_size          : null,
      risk_amount:        sizing ? sizing.risk_amount        : null,
      lot_size_is_estimate: sizing ? sizing.lot_size_is_estimate : null,
    });

  } catch (err) {
    console.error(`[analyze] ERROR at ${elapsed()}:`, err.name, err.status, err.message);
    logEvent('analyze_error', req, { meta: { name: err.name, status: err.status || null, message: (err.message || '').slice(0, 300), at_ms: Date.now() - handlerStart } });
    if (res.headersSent) return;

    const lower = (err.message || '').toLowerCase();

    // Problème côté fournisseur IA — jamais la faute du client, message neutre
    const isBilling = err.status === 400 && (lower.includes('credit balance') || lower.includes('billing') || lower.includes('quota'));
    const isOverloaded = err.status === 529 || err.status === 503 || lower.includes('overloaded');
    if (isBilling || isOverloaded || err.status === 401 || err.status === 500 || err.status === 502)
      return res.status(503).json({ error: "Le service d'analyse est momentanément indisponible. Réessaie dans quelques minutes." });

    if (err.name === 'APITimeoutError' || err.name === 'AbortError' || err.code === 'ETIMEDOUT')
      return res.status(504).json({ error: 'Délai dépassé. Réessaie dans un instant.' });
    if (err.status === 429)
      return res.status(429).json({ error: 'Beaucoup de demandes en ce moment. Réessaie dans quelques secondes.' });
    if (err instanceof SyntaxError || lower.includes('json'))
      return res.status(502).json({ error: 'Réponse IA invalide. Réessaie.' });

    return res.status(500).json({ error: 'Erreur serveur. Réessaie dans un instant.' });
  }
});

// Paper-trading only. This route never imports or calls a broker connector.
app.post('/api/paper-orders', (req, res) => {
  try {
    const data = validatePaperOrder(req.body || {});
    const order = {
      id: `DEMO-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      status: 'placed_demo',
      platform: data.platform,
      symbol: data.symbol,
      direction: data.direction,
      entry: data.entry,
      tp1: data.tp1,
      tp2: data.tp2,
      sl: data.sl,
      lot_size: data.lot_size,
      whop_user_id: data.whopUserId,
      created_at: new Date().toISOString(),
      live_execution: false,
    };

    paperOrders.unshift(order);
    if (paperOrders.length > PAPER_ORDER_LIMIT) paperOrders.length = PAPER_ORDER_LIMIT;

    console.log(`[paper-order] ${order.id} ${order.direction.toUpperCase()} ${order.symbol} ${order.lot_size} lot — ${order.platform}`);
    return res.status(201).json({
      status: order.status,
      message: 'Ordre de démonstration placé. Aucun ordre réel n’a été envoyé.',
      order,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Ordre de démonstration invalide.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Exécution d'ordres — pont EA MT5
//   POST /api/orders            (front « Accepter »)  → crée un ordre pending
//   GET  /api/orders/:ref                             → statut pour le front
//   POST /api/bridge/heartbeat  (EA, Bearer)          → santé du terminal
//   GET  /api/bridge/pending    (EA, Bearer)          → réclame les ordres pending
//   POST /api/bridge/report     (EA, Bearer)          → filled/rejected/be_moved/trailing/closed
// ─────────────────────────────────────────────────────────────

function makeRef() {
  return 'STO-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

function requireBridge(req, res, next) {
  const token = process.env.BRIDGE_TOKEN;
  if (!token) return res.status(503).json({ error: 'BRIDGE_TOKEN non configuré.' });
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-bridge-token') || '';
  if (provided !== token) return res.status(401).json({ error: 'Token pont invalide.' });
  next();
}

function validateOrder(body) {
  const platform   = typeof body.platform === 'string' ? body.platform.trim() : '';
  const direction  = typeof body.direction === 'string' ? body.direction.toLowerCase() : '';
  const symbol     = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  const whopUserId = typeof body.whop_user_id === 'string' ? body.whop_user_id.trim() : '';
  const mode       = body.mode === 'scalp' ? 'scalp' : (body.mode === 'swing' ? 'swing' : null);
  const num = k => Number(body[k]);
  const entry = num('entry'), tp1 = num('tp1'), tp2 = num('tp2'), sl = num('sl'), lot = num('lot_size');
  const atr = Number.isFinite(num('atr')) && num('atr') > 0 ? num('atr') : null;

  if (!whopUserId) throw new Error('ID membre Whop requis.');
  const ALL_PLATFORMS = new Set([...PAPER_PLATFORMS, ...BRIDGE_PLATFORMS]);
  if (!ALL_PLATFORMS.has(platform)) throw new Error('Plateforme invalide.');
  if (!['buy', 'sell'].includes(direction)) throw new Error('Direction invalide.');
  if (!symbol || symbol.length > 30 || !/^[A-Z0-9/_.=-]+$/.test(symbol)) throw new Error('Symbole invalide.');
  if ([entry, tp1, tp2, sl, lot].some(v => !Number.isFinite(v) || v <= 0))
    throw new Error('Entry, TP1, TP2, SL et lot doivent être des nombres positifs.');
  if (lot > 100) throw new Error('Lot trop élevé.');

  const levelsOk = direction === 'buy'
    ? sl < entry && tp1 > entry && tp2 >= tp1
    : sl > entry && tp1 < entry && tp2 <= tp1;
  if (!levelsOk) throw new Error('Les niveaux Entry/TP/SL ne correspondent pas à la direction.');

  return { platform, direction, symbol, whopUserId, mode, entry, tp1, tp2, sl, lot, atr,
           accountId: typeof body.account_id === 'string' ? body.account_id.trim() || null : null };
}

app.post('/api/orders', async (req, res) => {
  let d;
  try { d = validateOrder(req.body || {}); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  // Le réel n'est ouvert qu'avec le token admin ET un compte explicitement autorisé
  if (d.platform === 'mt5-live') {
    const adminOk = (req.get('x-admin-token') || '') === process.env.ADMIN_TOKEN && !!process.env.ADMIN_TOKEN;
    if (!adminOk) return res.status(403).json({ error: 'Exécution réelle réservée à l’administrateur.' });
  }

  if (!supabase) return res.status(503).json({ error: 'Base de données indisponible.' });

  const ref = makeRef();
  const { ip, country } = clientMeta(req);
  const paperInstant = (d.platform === 'snaptrade-paper' || d.platform === 'ctrader-demo');

  const row = {
    ref, whop_user_id: d.whopUserId, account_id: d.accountId, platform: d.platform,
    mode: d.mode, symbol: d.symbol, direction: d.direction, lot: d.lot,
    entry: d.entry, sl: d.sl, tp1: d.tp1, tp2: d.tp2, atr: d.atr,
    manage: ORDER_RULES,
    status: paperInstant ? 'filled' : 'pending',
    fill_price: paperInstant ? d.entry : null,
    filled_at:  paperInstant ? new Date().toISOString() : null,
    bridge_msg: paperInstant ? 'Simulation interne — aucun terminal impliqué.' : null,
    ip, country,
  };

  const { data, error } = await supabase.from('orders').insert(row).select('ref,status').single();
  if (error) { console.error('[orders] insert error:', error.message); return res.status(500).json({ error: error.message }); }

  logEvent('order_created', req, { whop_user_id: d.whopUserId, meta: { ref, platform: d.platform, symbol: d.symbol, direction: d.direction } });
  console.log(`[orders] ${ref} ${d.direction.toUpperCase()} ${d.symbol} ${d.lot} — ${d.platform} (${row.status})`);
  return res.status(201).json({ ref, status: row.status, routed_to_bridge: BRIDGE_PLATFORMS.has(d.platform) });
});

app.get('/api/orders/:ref', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Base de données indisponible.' });
  const { data, error } = await supabase.from('orders')
    .select('ref,status,platform,symbol,direction,lot,entry,sl,tp1,tp2,mt5_ticket,fill_price,close_price,pnl,be_moved,trail_active,bridge_msg,created_at,filled_at,closed_at')
    .eq('ref', req.params.ref).single();
  if (error) return res.status(404).json({ error: 'Ordre introuvable.' });
  return res.json(data);
});

app.post('/api/bridge/heartbeat', requireBridge, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'DB indisponible.' });
  const b = req.body || {};
  const accountId = (b.account_id || '').toString().trim();
  if (!accountId) return res.status(400).json({ error: 'account_id requis.' });

  const patch = {
    account_id: accountId,
    label:          b.label ? String(b.label).slice(0, 60) : null,
    whop_user_id:   b.whop_user_id ? String(b.whop_user_id).trim() : null,
    account_type:   ['demo', 'contest', 'real'].includes(b.account_type) ? b.account_type : null,
    balance:        Number.isFinite(Number(b.balance)) ? Number(b.balance) : null,
    equity:         Number.isFinite(Number(b.equity)) ? Number(b.equity) : null,
    open_positions: Number.isInteger(b.open_positions) ? b.open_positions : null,
    terminal_build: Number.isInteger(b.terminal_build) ? b.terminal_build : null,
    last_seen:      new Date().toISOString(),
  };
  Object.keys(patch).forEach(k => patch[k] == null && k !== 'account_id' && delete patch[k]);

  const { error } = await supabase.from('bridge_accounts').upsert(patch, { onConflict: 'account_id' });
  if (error) console.error('[bridge] heartbeat error:', error.message);

  const { data: acct } = await supabase.from('bridge_accounts')
    .select('kill_switch,live_enabled').eq('account_id', accountId).single();
  return res.json({ ok: true, kill_switch: !!acct?.kill_switch, live_enabled: !!acct?.live_enabled, rules: ORDER_RULES });
});

app.get('/api/bridge/pending', requireBridge, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'DB indisponible.' });
  const accountId = (req.query.account_id || '').toString().trim();
  if (!accountId) return res.status(400).json({ error: 'account_id requis.' });

  const { data, error } = await supabase.rpc('claim_pending_orders', { p_account_id: accountId, p_limit: 5 });
  if (error) { console.error('[bridge] claim error:', error.message); return res.status(500).json({ error: error.message }); }

  const orders = (data || []).map(o => ({
    ref: o.ref, symbol: o.symbol, direction: o.direction, lot: Number(o.lot),
    entry: Number(o.entry), sl: Number(o.sl), tp1: Number(o.tp1), tp2: Number(o.tp2),
    atr: o.atr != null ? Number(o.atr) : null, platform: o.platform, rules: o.manage || ORDER_RULES,
  }));
  if (orders.length) console.log(`[bridge] ${accountId} claimed ${orders.length} order(s): ${orders.map(o => o.ref).join(', ')}`);
  return res.json({ orders, rules: ORDER_RULES });
});

app.post('/api/bridge/report', requireBridge, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'DB indisponible.' });
  const b = req.body || {};
  const ref   = (b.ref || '').toString().trim();
  const event = (b.event || '').toString().trim();
  if (!ref || !['filled', 'rejected', 'be_moved', 'trailing', 'closed', 'expired', 'cancelled'].includes(event))
    return res.status(400).json({ error: 'ref et event valides requis.' });

  const now = new Date().toISOString();
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const patch = { updated_at: now, bridge_msg: b.message ? String(b.message).slice(0, 300) : null };

  if (event === 'filled')   { patch.status = 'filled';   patch.filled_at = now; patch.mt5_ticket = Number.isInteger(b.mt5_ticket) ? b.mt5_ticket : null; patch.fill_price = num(b.price); }
  if (event === 'rejected') { patch.status = 'rejected'; }
  if (event === 'expired')  { patch.status = 'expired'; }
  if (event === 'cancelled'){ patch.status = 'cancelled'; }
  if (event === 'be_moved') { patch.be_moved = true; }
  if (event === 'trailing') { patch.trail_active = true; }
  if (event === 'closed')   { patch.status = 'closed'; patch.closed_at = now; patch.close_price = num(b.price); patch.pnl = num(b.pnl); }

  const { error } = await supabase.from('orders').update(patch).eq('ref', ref);
  if (error) { console.error('[bridge] report error:', error.message); return res.status(500).json({ error: error.message }); }

  logEvent('order_' + event, req, { meta: { ref, ticket: b.mt5_ticket || null, pnl: b.pnl ?? null } });
  console.log(`[bridge] ${ref} → ${event}${b.mt5_ticket ? ' #' + b.mt5_ticket : ''}${b.pnl != null ? ' pnl=' + b.pnl : ''}`);
  return res.json({ ok: true });
});

// Admin — santé des ponts + derniers ordres + kill-switch
app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  if (!supabase) return res.status(503).json({ error: 'DB indisponible.' });
  const [accts, ords] = await Promise.all([
    supabase.from('bridge_accounts').select('*').order('last_seen', { ascending: false }),
    supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(80),
  ]);
  res.set('Cache-Control', 'no-store');
  return res.json({ accounts: accts.data || [], orders: ords.data || [] });
});

app.post('/api/admin/kill-switch', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'DB indisponible.' });
  const { account_id, on } = req.body || {};
  if (!account_id) return res.status(400).json({ error: 'account_id requis.' });
  const { error } = await supabase.from('bridge_accounts')
    .update({ kill_switch: !!on }).eq('account_id', String(account_id));
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, account_id, kill_switch: !!on });
});

// Admin — retirer une ligne d'ordre (ordre erroné, test, ou déjà géré côté MT5)
app.delete('/api/admin/orders/:ref', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'DB indisponible.' });
  const ref = (req.params.ref || '').toString().trim();
  if (!ref) return res.status(400).json({ error: 'ref requis.' });
  const { data, error } = await supabase.from('orders').delete().eq('ref', ref).select('ref');
  if (error) return res.status(500).json({ error: error.message });
  if (!data || !data.length) return res.status(404).json({ error: 'Ordre introuvable.' });
  console.log(`[orders] admin a supprimé ${ref}`);
  return res.json({ ok: true, deleted: ref });
});

app.get('/api/quota/:whop_user_id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Quota non disponible.' });
  const { data, error } = await supabase
    .from('user_quotas')
    .select('plan,scans_used_this_month,scans_used_lifetime,period_start')
    .eq('whop_user_id', req.params.whop_user_id)
    .single();
  if (error) return res.status(404).json({ plan: null, scans_used: 0 });
  return res.json(data);
});

app.get('/api/scans/:whop_user_id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Historique non disponible.' });
  const { data, error } = await supabase
    .from('scans')
    .select('*')
    .eq('whop_user_id', req.params.whop_user_id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// ─────────────────────────────────────────────────────────────
// Télémétrie front — page_view + heartbeat de présence
// ─────────────────────────────────────────────────────────────

const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,                      // 1 page_view + 1 heartbeat/min laisse large
  standardHeaders: false,
  legacyHeaders: false,
  handler: (_req, res) => res.status(204).end(),
});

app.post('/api/track', trackLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const t    = (body.type || '').toString().slice(0, 40);
    if (!['page_view', 'heartbeat'].includes(t)) return res.status(204).end();

    const vid        = (body.visitor_id || '').toString().slice(0, 64) || null;
    const whopUserId = (body.whop_user_id || '').toString().trim() || null;
    const { ip, country, ua } = clientMeta(req);

    if (supabase && vid) {
      await supabase.rpc('presence_touch', {
        p_visitor_id: vid, p_whop_user_id: whopUserId,
        p_ip: ip, p_country: country, p_ua: ua, p_kind: t,
      });
    }
    if (t === 'page_view') {
      logEvent('page_view', req, {
        whop_user_id: whopUserId,
        path: (body.path || '/').toString().slice(0, 200),
        meta: { visitor_id: vid },
      });
    }
    res.status(204).end();
  } catch (err) {
    console.error('[track] error:', err.message);
    res.status(204).end();
  }
});

// ─────────────────────────────────────────────────────────────
// Dashboard admin — protégé par ADMIN_TOKEN
// ─────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(503).json({ error: 'ADMIN_TOKEN non configuré sur le serveur.' });
  const provided = req.get('x-admin-token')
                || (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
                || req.query.token
                || '';
  if (provided !== token) return res.status(401).json({ error: 'Token admin invalide.' });
  next();
}

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase non configuré — aucune donnée.' });
  const { data, error } = await supabase.rpc('admin_dashboard_stats');
  if (error) {
    console.error('[admin] stats error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  // Additif — performance réelle des signaux (Phase 3). Echec non bloquant :
  // le reste du dashboard doit toujours s'afficher meme si cette table
  // n'existe pas encore (avant que la migration soit appliquee).
  try {
    const { data: outcomeData, error: outcomeErr } = await supabase.rpc('outcome_stats');
    data.outcome_stats = outcomeErr ? null : (outcomeData?.[0] || null);
  } catch (e) {
    data.outcome_stats = null;
  }
  res.set('Cache-Control', 'no-store');
  return res.json(data);
});

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

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

// Suivi des résultats de signaux : première passe 2 min après démarrage
// (laisse le serveur se stabiliser), puis chaque heure. setInterval simple
// suffit ici (charge légère, pas besoin de node-cron) — voir checkPendingOutcomes.
setTimeout(() => checkPendingOutcomes(), 2 * 60 * 1000);
setInterval(() => checkPendingOutcomes(), OUTCOME_CHECK_MS);
