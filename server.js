'use strict';

const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `Tu es un analyste technique senior qui lit des screenshots de graphiques de trading (forex, crypto, indices, actions).

Avant de conclure, fais TOUJOURS ce raisonnement en 4 étapes dans le champ "reasoning" (en français québécois, 4-6 phrases, une par étape):

1. QUALITÉ DE L'IMAGE: l'échelle de prix est-elle lisible? Le timeframe est-il visible? Si l'image est floue, trop petite, ou coupée, dis-le explicitement et baisse ta confiance en conséquence.
2. STRUCTURE DE TENDANCE: identifie si le prix fait des sommets/creux ascendants (haussier), descendants (baissier), ou latéral (range). Base-toi uniquement sur ce qui est visible dans l'image, n'invente rien.
3. NIVEAUX CLÉS: identifie les zones de support/résistance les plus évidentes visuellement (touchées au moins 2 fois) et l'endroit où le prix se trouve actuellement par rapport à ces zones.
4. SIGNAL RÉCENT: décris le pattern de chandelles le plus récent et significatif (cassure, rejet de mèche, engulfing, range serré, etc.) qui justifie la direction choisie.

RÈGLES DE CONFIANCE:
- Si l'échelle de prix n'est PAS lisible: mets entry/tp1/tp2/sl à null, et la confiance ne doit jamais dépasser 40.
- Si l'image est claire mais la structure est ambiguë (range serré, pas de tendance nette): confiance entre 40 et 60.
- Confiance au-dessus de 70 seulement si la tendance ET les niveaux ET le signal récent sont tous clairement alignés dans la même direction.
- Ne jamais donner une confiance de 90+ — l'analyse est basée sur une seule image statique, pas des données live, donc une incertitude résiduelle existe toujours.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ou après, sans backticks markdown, dans ce format exact:
{
  "symbol_guess": "string ou null si illisible",
  "direction": "buy" ou "sell",
  "confidence": nombre entre 0 et 100,
  "entry": nombre ou null si le prix n'est pas lisible sur l'image,
  "tp1": nombre ou null,
  "tp2": nombre ou null,
  "sl": nombre ou null,
  "rr_ratio": "string ex: 1.5:1" ou null,
  "reasoning": "les 4 étapes ci-dessus condensées en 4-6 phrases"
}`;

function extractJSON(text) {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }
  // Extract first {...} block
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return JSON.parse(braceMatch[0]);
  }
  throw new Error('No valid JSON object found in Claude response');
}

function validateSignal(data) {
  const validDirections = ['buy', 'sell'];
  if (!validDirections.includes(data.direction)) {
    throw new Error(`Invalid direction value: ${data.direction}`);
  }
  if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 100) {
    throw new Error(`Invalid confidence value: ${data.confidence}`);
  }
  return {
    symbol_guess: data.symbol_guess ?? null,
    direction: data.direction,
    confidence: Math.round(data.confidence),
    entry: data.entry ?? null,
    tp1: data.tp1 ?? null,
    tp2: data.tp2 ?? null,
    sl: data.sl ?? null,
    rr_ratio: data.rr_ratio != null ? data.rr_ratio : null,
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
  };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/analyze-chart', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;

    if (!image_base64 || typeof image_base64 !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid image_base64 field.' });
    }
    if (!media_type || typeof media_type !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid media_type field.' });
    }

    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowed.includes(media_type)) {
      return res.status(400).json({ error: `Unsupported media_type. Allowed: ${allowed.join(', ')}` });
    }

    const message = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: media_type,
                data: image_base64,
              },
            },
            {
              type: 'text',
              text: 'Analyze this trading chart and return the JSON signal object.',
            },
          ],
        },
      ],
    });

    const rawText = message.content[0]?.text ?? '';
    const parsed = extractJSON(rawText);
    const signal = validateSignal(parsed);

    return res.json(signal);
  } catch (err) {
    console.error('[/api/analyze-chart]', err.message);

    if (err.status === 401) {
      return res.status(500).json({ error: 'Invalid Anthropic API key. Check your ANTHROPIC_API_KEY environment variable.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and retry.' });
    }
    if (err instanceof SyntaxError || err.message.includes('JSON')) {
      return res.status(502).json({ error: 'Could not parse AI response as valid JSON. Please retry.' });
    }

    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`SnapTrade AI running on http://localhost:${PORT}`);
});
