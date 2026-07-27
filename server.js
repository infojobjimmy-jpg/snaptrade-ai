'use strict';

const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `You are an expert trading chart analyst. You will receive a trading chart image and must return ONLY a valid JSON object — no markdown, no explanation, no additional text whatsoever.

Analyze the chart carefully and return this exact structure:
{
  "symbol_guess": string or null,
  "direction": "buy" or "sell",
  "confidence": number between 0 and 100,
  "entry": number or null,
  "tp1": number or null,
  "tp2": number or null,
  "sl": number or null,
  "rr_ratio": number or null,
  "reasoning": string
}

Rules:
- "direction" and "confidence" are ALWAYS provided — never null.
- If price levels are not readable from the chart, set entry, tp1, tp2, sl, rr_ratio to null.
- If the symbol/ticker is visible, populate symbol_guess; otherwise null.
- rr_ratio = (tp1 - entry) / (entry - sl) for buy, or (entry - tp1) / (tp2 - entry) for sell. Round to 2 decimals.
- "reasoning" must be a concise 2-3 sentence explanation of the signal rationale.
- Return ONLY the raw JSON object. No prose, no code fences, no markdown.`;

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
    rr_ratio: data.rr_ratio ?? null,
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
      model: 'claude-sonnet-5',
      max_tokens: 1024,
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
