'use strict';
// Run: node create_whop_plans.js <PRODUCT_ID>
// Creates the 4 SnapTrade AI plans under the given Whop product ID.

const https = require('https');

const WHOP_API_KEY = 'apik_toSkB3HNu9Egv_C5116542_C_4eb9c67b6b81061caf840a0947dd870140d62dc2fd0834eb8ced6170bf7cd4';
const PRODUCT_ID   = process.argv[2];

if (!PRODUCT_ID) {
  console.error('Usage: node create_whop_plans.js <prod_xxx>');
  process.exit(1);
}

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const opts = {
      hostname: 'api.whop.com', path, method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHOP_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(b),
      },
    };
    const req = https.request(opts, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        const parsed = JSON.parse(d);
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(parsed);
        else reject(new Error(`HTTP ${r.statusCode}: ${JSON.stringify(parsed)}`));
      });
    });
    req.on('error', reject);
    req.write(b); req.end();
  });
}

async function main() {
  console.log(`Creating 4 plans on product ${PRODUCT_ID}...`);

  const plans = [
    {
      label: 'Essai (gratuit, 5 scans à vie)',
      body: {
        access_pass_id: PRODUCT_ID,
        plan_type: 'one_time',   // one-time free join, lifetime membership
        initial_price: '0.0',    // free (if API rejects, script logs error — set manually in dashboard)
        unlimited_stock: true,
        visibility: 'visible',
        internal_notes: 'Essai — 5 scans à vie. Quota enforced by SnapTrade AI middleware.',
      },
    },
    {
      label: 'Fondateur (14.99$/mois, illimité, max 100 membres)',
      body: {
        access_pass_id: PRODUCT_ID,
        plan_type: 'renewal',
        billing_period: 30,
        initial_price: '14.99',
        renewal_price: '14.99',
        unlimited_stock: false,
        stock: 100,
        visibility: 'visible',
        internal_notes: 'Offre Fondateur — prix verrouillé à vie à 14.99$/mois. Illimité. Max 100 membres (stock enforced by Whop).',
      },
    },
    {
      label: 'Standard (14.99$/mois, 300 scans/mois)',
      body: {
        access_pass_id: PRODUCT_ID,
        plan_type: 'renewal',
        billing_period: 30,
        initial_price: '14.99',
        renewal_price: '14.99',
        unlimited_stock: true,
        visibility: 'visible',
        internal_notes: 'Standard — 300 scans/mois. Quota enforced by SnapTrade AI middleware.',
      },
    },
    {
      label: 'Pro (24.99$/mois, illimité)',
      body: {
        access_pass_id: PRODUCT_ID,
        plan_type: 'renewal',
        billing_period: 30,
        initial_price: '24.99',
        renewal_price: '24.99',
        unlimited_stock: true,
        visibility: 'visible',
        internal_notes: 'Pro — Scans illimités (soumis au rate limit IP anti-abus).',
      },
    },
  ];

  const results = {};
  for (const { label, body } of plans) {
    try {
      const r = await apiPost('/api/v2/plans', body);
      console.log(`✓ ${label} → ${r.id}`);
      results[label] = r.id;
    } catch (err) {
      console.error(`✗ ${label}: ${err.message}`);
    }
  }

  console.log('\n--- Copy these to Railway + server.js ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
