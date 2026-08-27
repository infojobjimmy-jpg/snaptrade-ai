-- ============================================================
-- SnapTrade AI — Exécution d'ordres via pont EA MT5
-- Table `orders` (cycle de vie complet) + `bridge_accounts` (santé des terminaux)
-- ============================================================

-- ── Terminaux MT5 reliés au pont ────────────────────────────
create table if not exists bridge_accounts (
  account_id     text primary key,             -- login MT5 (en texte)
  label          text,
  whop_user_id   text,
  account_type   text,                          -- demo | contest | real
  live_enabled   boolean not null default false, -- garde-fou : doit être activé à la main pour le réel
  kill_switch    boolean not null default false, -- coupe l'ouverture de nouveaux ordres
  balance        numeric,
  equity         numeric,
  open_positions integer default 0,
  terminal_build integer,
  last_seen      timestamptz,
  created_at     timestamptz not null default now()
);

-- ── Ordres ─────────────────────────────────────────────────
-- status : pending → claimed → filled → closed
--          (ou rejected / cancelled / expired en sortie)
create table if not exists orders (
  id             uuid primary key default gen_random_uuid(),
  ref            text unique not null,          -- réf courte lisible, ex: STO-1A2B3C
  whop_user_id   text,
  whop_plan      text,
  account_id     text,                          -- terminal ciblé (null = premier dispo)
  platform       text not null,                 -- mt5-demo | mt5-live | ctrader-demo | snaptrade-paper
  mode           text,                          -- swing | scalp
  symbol         text not null,
  direction      text not null,                 -- buy | sell
  lot            numeric not null,              -- lot demandé (l'EA peut recalculer selon l'équité réelle)
  entry          numeric,
  sl             numeric,
  tp1            numeric,
  tp2            numeric,
  atr            numeric,                        -- ATR(14) au moment du scan (pour le trailing)
  manage         jsonb,                          -- snapshot des règles (BE@TP1, trailing, etc.)
  status         text not null default 'pending',
  mt5_ticket     bigint,
  fill_price     numeric,
  close_price    numeric,
  pnl            numeric,
  be_moved       boolean not null default false,
  trail_active   boolean not null default false,
  bridge_msg     text,
  ip             text,
  country        text,
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  filled_at      timestamptz,
  closed_at      timestamptz,
  updated_at     timestamptz not null default now()
);
create index if not exists orders_status_idx on orders (status, created_at);
create index if not exists orders_user_idx   on orders (whop_user_id, created_at desc);
create index if not exists orders_account_idx on orders (account_id, status);

-- ── Réclamation atomique des ordres en attente par l'EA ─────
-- Passe pending → claimed et renvoie les lignes réclamées.
create or replace function claim_pending_orders(p_account_id text, p_limit int default 5)
returns setof orders
language sql
volatile
set search_path = public
as $$
  update orders o
  set status = 'claimed', claimed_at = now(), updated_at = now(),
      account_id = coalesce(o.account_id, p_account_id)
  where o.id in (
    select id from orders
    where status = 'pending'
      and platform in ('mt5-demo', 'mt5-live')
      and (account_id is null or account_id = p_account_id)
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning o.*;
$$;
