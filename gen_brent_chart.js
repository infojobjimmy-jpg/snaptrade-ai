'use strict';
// Fetches real BZ=F (Brent) hourly candles from Yahoo Finance,
// renders a 1280×720 candlestick chart as PNG, saves to xbrusd_chart.png
const axios = require('./node_modules/axios');
const zlib  = require('zlib');
const fs    = require('fs');

const W = 1280, H = 720;

// ── pixel buffer helpers ──────────────────────────────────────
const buf = Buffer.alloc(W * H * 3);
function px(x, y, r, g, b) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3; buf[i] = r; buf[i+1] = g; buf[i+2] = b;
}
function rect(x1, y1, x2, y2, r, g, b) {
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) px(x, y, r, g, b);
}
function vline(x, y1, y2, r, g, b) {
  for (let y = Math.min(y1,y2); y <= Math.max(y1,y2); y++) px(x, y, r, g, b);
}
function hline(y, x1, x2, r, g, b) {
  for (let x = Math.min(x1,x2); x <= Math.max(x1,x2); x++) px(x, y, r, g, b);
}

// ── PNG writer (no deps) ──────────────────────────────────────
function crc32(b) {
  let c = 0xFFFFFFFF;
  for (const byte of b) { c ^= byte; for (let k=0; k<8; k++) c = (c&1) ? (0xEDB88320^(c>>>1)) : (c>>>1); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}
function writePNG(path) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3); row[0] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y*W+x)*3;
      row[1+x*3] = buf[i]; row[1+x*3+1] = buf[i+1]; row[1+x*3+2] = buf[i+2];
    }
    rows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows), { level: 6 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=2;
  const png = Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path, png);
  return png.length;
}

// ── 5×7 pixel font for price labels ──────────────────────────
const FONT5 = {
  '0':'01110100011000110001100011000101110','1':'00100011000010000100001000010001110',
  '2':'01110100010000100010001000010011111','3':'11110000101110000010000110001011110',
  '4':'00010001100101001010011110000100001','5':'11111100001111000001000011000101110',
  '6':'00110010001000011110100011000101110','7':'11111000010001000100010000100001000',
  '8':'01110100011000101110100011000101110','9':'01110100011000101111000010001001100',
  '.':'00000000000000000000000000000011100',
  '$':'00100011111010001111000101111100100',
};
function drawChar(ch, cx, cy, r, g, b) {
  const bits = FONT5[ch]; if (!bits) return;
  for (let row=0; row<7; row++) for (let col=0; col<5; col++)
    if (bits[row*5+col] === '1') px(cx+col, cy+row, r, g, b);
}
function drawText(str, cx, cy, r, g, b) {
  str.split('').forEach((ch, i) => drawChar(ch, cx + i*6, cy, r, g, b));
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  const resp = await axios.default.get(
    'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F',
    {
      params: { interval: '1h', range: '5d' },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' },
      timeout: 10000,
    }
  );
  const result = resp.data.chart.result[0];
  const ts = result.timestamp;
  const q  = result.indicators.quote[0];

  const raw = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    raw.push({ o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  const data = raw.slice(-60); // last 60 candles
  const N    = data.length;

  const ML = 75, MR = 90, MT = 55, MB = 45;
  const cW = W - ML - MR, cH = H - MT - MB;

  const pMin = Math.min(...data.map(c => c.l)) * 0.9992;
  const pMax = Math.max(...data.map(c => c.h)) * 1.0008;
  const pRange = pMax - pMin;

  const py = price => Math.round(MT + (1 - (price - pMin) / pRange) * cH);

  // Background
  rect(0, 0, W-1, H-1, 11, 14, 17);

  // Horizontal grid lines (8)
  for (let i = 0; i <= 8; i++) {
    const y = MT + Math.round(i * cH / 8);
    hline(y, ML, W - MR, 28, 36, 48);
    const price = pMax - i * pRange / 8;
    drawText(price.toFixed(2), W - MR + 6, y - 3, 100, 120, 140);
  }

  // Vertical grid lines (10)
  for (let i = 0; i <= 10; i++) {
    const x = ML + Math.round(i * cW / 10);
    vline(x, MT, H - MB, 28, 36, 48);
  }

  // Symbol label top-left
  const labelChars = 'BZ=F  BRENT CRUDE  1H'.replace(/[^0-9.]/g, '');
  // Draw "BRENT" manually as green text using thick dots
  const label = 'XBRUSD';
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    // Draw each char as block pixel (simplified)
    drawChar(ch.charCodeAt(0) < 58 ? ch : null, ML + 6 + i * 7, MT - 38, 31, 201, 139);
  }
  // Draw price range
  drawText(pMin.toFixed(2), ML + 6, H - MB + 8, 80, 100, 120);
  drawText(pMax.toFixed(2), ML + 6, MT - 20, 80, 100, 120);

  // Candles
  const slotW = cW / N;
  const bodyW = Math.max(2, Math.floor(slotW * 0.65));

  for (let i = 0; i < N; i++) {
    const c = data[i];
    const cx = Math.round(ML + (i + 0.5) * slotW);
    const isGreen = c.c >= c.o;
    const [cr, cg, cb] = isGreen ? [31, 201, 139] : [229, 72, 77];

    // Wick
    vline(cx, py(c.h), py(c.l), 80, 100, 120);

    // Body
    const bTop = Math.min(py(c.o), py(c.c));
    const bBot = Math.max(py(c.o), py(c.c));
    rect(cx - Math.floor(bodyW/2), bTop, cx + Math.floor(bodyW/2), Math.max(bBot, bTop+1), cr, cg, cb);
  }

  // Axis borders
  vline(ML, MT, H-MB, 50, 65, 80);
  hline(H-MB, ML, W-MR, 50, 65, 80);

  // SMA-like curve (smooth of closes)
  const smaPeriod = 14;
  for (let i = smaPeriod; i < N; i++) {
    const sma = data.slice(i - smaPeriod, i).reduce((s, c) => s + c.c, 0) / smaPeriod;
    const x = Math.round(ML + (i + 0.5) * slotW);
    const y = py(sma);
    for (let dy = -1; dy <= 1; dy++) px(x, y+dy, 76, 141, 255);
  }

  const bytes = writePNG('xbrusd_chart.png');
  const last = data[data.length-1];
  console.log('Chart written: xbrusd_chart.png (' + (bytes/1024).toFixed(0) + 'KB)');
  console.log('Candles: ' + N + '  |  Range: $' + pMin.toFixed(2) + '-$' + pMax.toFixed(2) + '  |  Last close: $' + last.c.toFixed(2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
