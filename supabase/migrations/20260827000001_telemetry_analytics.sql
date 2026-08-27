-- ============================================================
-- SnapTrade AI — Télémétrie & Analytics
-- Phase 1 : enrichissement de `scans`
-- Phase 2 : tables `events` + `presence`
-- Phase 4 : fonctions d'agrégation pour le dashboard admin
-- ============================================================

-- ── Phase 1 : colonnes de contexte sur chaque scan ──────────
alter table scans add column if not exists ip                text;
alter table scans add column if not exists country           text;
alter table scans add column if not exists user_agent        text;
alter table scans add column if not exists latency_ms         integer;
alter table scans add column if not exists pass1_direction    text;
alter table scans add column if not exists pass1_confidence   numeric;
alter table scans add column if not exists indicators         jsonb;
alter table scans add column if not exists account_balance    numeric;
alter table scans add column if not exists risk_pct           numeric;
alter table scans add column if not exists image_size_kb      integer;
alter table scans add column if not exists symbol_override    text;
alter table scans add column if not exists whop_plan          text;

create index if not exists scans_created_at_idx on scans (created_at desc);
create index if not exists scans_symbol_idx     on scans (symbol_guess);
create index if not exists scans_mode_idx       on scans (mode);

-- ── Phase 2 : journal d'évènements ──────────────────────────
-- type : page_view | analyze_start | analyze_success | analyze_error
--        | quota_block | auth_fail | rate_limit
create table if not exists events (
  id           uuid primary key default gen_random_uuid(),
  type         text not null,
  whop_user_id text,
  whop_plan    text,
  ip           text,
  country      text,
  user_agent   text,
  path         text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists events_type_created_idx on events (type, created_at desc);
create index if not exists events_created_idx      on events (created_at desc);
create index if not exists events_user_idx         on events (whop_user_id);

-- ── Phase 2 : présence (1 ligne par visiteur navigateur) ────
create table if not exists presence (
  visitor_id   text primary key,
  whop_user_id text,
  ip           text,
  country      text,
  user_agent   text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  page_views   integer not null default 0,
  heartbeats   integer not null default 0
);
create index if not exists presence_last_seen_idx on presence (last_seen desc);

-- Upsert atomique appelé à chaque page_view / heartbeat du front
create or replace function presence_touch(
  p_visitor_id   text,
  p_whop_user_id text,
  p_ip           text,
  p_country      text,
  p_ua           text,
  p_kind         text
) returns void
language sql
set search_path = public
as $$
  insert into presence as pr (
    visitor_id, whop_user_id, ip, country, user_agent,
    page_views, heartbeats, first_seen, last_seen
  )
  values (
    p_visitor_id, p_whop_user_id, p_ip, p_country, p_ua,
    case when p_kind = 'page_view' then 1 else 0 end,
    case when p_kind = 'page_view' then 0 else 1 end,
    now(), now()
  )
  on conflict (visitor_id) do update set
    last_seen    = now(),
    ip           = coalesce(excluded.ip, pr.ip),
    country      = coalesce(excluded.country, pr.country),
    user_agent   = coalesce(excluded.user_agent, pr.user_agent),
    whop_user_id = coalesce(excluded.whop_user_id, pr.whop_user_id),
    page_views   = pr.page_views + (case when p_kind = 'page_view' then 1 else 0 end),
    heartbeats   = pr.heartbeats + (case when p_kind = 'page_view' then 0 else 1 end);
$$;

-- ── Phase 4 : agrégat unique pour le dashboard admin ────────
create or replace function admin_dashboard_stats()
returns jsonb
language sql
stable
set search_path = public
as $$
  with
  live as (
    select * from presence where last_seen > now() - interval '5 minutes'
  ),
  funnel as (
    select type, count(*)::int c
    from events
    where created_at > now() - interval '7 days'
    group by type
  ),
  per_day as (
    select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') d, count(*)::int c
    from scans
    where created_at > now() - interval '30 days'
    group by 1
    order by 1
  ),
  top_sym as (
    select coalesce(nullif(symbol_guess, ''), '(inconnu)') s, count(*)::int c
    from scans
    where created_at > now() - interval '30 days'
    group by 1
    order by c desc
    limit 15
  ),
  patterns as (
    select
      coalesce(nullif(symbol_guess, ''), '(inconnu)') sym,
      mode,
      direction,
      least(100, (floor(confidence / 10) * 10))::int conf_bucket,
      count(*)::int c,
      round(avg(confidence), 1) avg_conf
    from scans
    where created_at > now() - interval '30 days'
    group by 1, 2, 3, 4
    having count(*) >= 2
    order by c desc
    limit 25
  ),
  recent as (
    select
      id, created_at, whop_user_id, whop_plan, symbol_guess, symbol_override,
      direction, confidence, pass1_direction, pass1_confidence, mode, data_source,
      latency_ms, lot_size, account_balance, risk_pct, ip, country
    from scans
    order by created_at desc
    limit 40
  ),
  errs as (
    select created_at, whop_user_id, ip, country, meta
    from events
    where type = 'analyze_error'
    order by created_at desc
    limit 25
  )
  select jsonb_build_object(
    'generated_at', now(),

    'live_now', (select count(*) from live),
    'live_users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'visitor_id',   visitor_id,
        'whop_user_id', whop_user_id,
        'ip',           ip,
        'country',      country,
        'last_seen',    last_seen,
        'page_views',   page_views
      ) order by last_seen desc)
      from live
    ), '[]'::jsonb),

    'scans_today', (select count(*) from scans where created_at > date_trunc('day', now())),
    'scans_7d',    (select count(*) from scans where created_at > now() - interval '7 days'),
    'scans_30d',   (select count(*) from scans where created_at > now() - interval '30 days'),
    'scans_total', (select count(*) from scans),

    'users_today', (select count(distinct whop_user_id) from scans where created_at > date_trunc('day', now())),
    'users_7d',    (select count(distinct whop_user_id) from scans where created_at > now() - interval '7 days'),
    'users_30d',   (select count(distinct whop_user_id) from scans where created_at > now() - interval '30 days'),

    'funnel_7d', coalesce((select jsonb_object_agg(type, c) from funnel), '{}'::jsonb),

    'scans_per_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'count', c)) from per_day
    ), '[]'::jsonb),

    'top_symbols', coalesce((
      select jsonb_agg(jsonb_build_object('symbol', s, 'count', c)) from top_sym
    ), '[]'::jsonb),

    'frequent_setups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'symbol', sym, 'mode', mode, 'direction', direction,
        'confidence_bucket', conf_bucket, 'count', c, 'avg_confidence', avg_conf
      ))
      from patterns
    ), '[]'::jsonb),

    'direction_split_30d', jsonb_build_object(
      'buy',  (select count(*) from scans where created_at > now() - interval '30 days' and direction = 'buy'),
      'sell', (select count(*) from scans where created_at > now() - interval '30 days' and direction = 'sell')
    ),
    'mode_split_30d', jsonb_build_object(
      'swing', (select count(*) from scans where created_at > now() - interval '30 days' and mode = 'swing'),
      'scalp', (select count(*) from scans where created_at > now() - interval '30 days' and mode = 'scalp')
    ),
    'data_source_split_30d', jsonb_build_object(
      'vision_only',             (select count(*) from scans where created_at > now() - interval '30 days' and data_source = 'vision_only'),
      'vision_plus_market_data', (select count(*) from scans where created_at > now() - interval '30 days' and data_source = 'vision_plus_market_data')
    ),

    'avg_confidence_30d',    (select round(avg(confidence), 1) from scans where created_at > now() - interval '30 days'),
    'avg_confidence_swing',  (select round(avg(confidence), 1) from scans where created_at > now() - interval '30 days' and mode = 'swing'),
    'avg_confidence_scalp',  (select round(avg(confidence), 1) from scans where created_at > now() - interval '30 days' and mode = 'scalp'),

    'plan_distribution', coalesce((
      select jsonb_object_agg(plan, c)
      from (select plan, count(*)::int c from user_quotas group by plan) x
    ), '{}'::jsonb),
    'total_members', (select count(*) from user_quotas),

    'recent_scans',  coalesce((select jsonb_agg(to_jsonb(r)) from recent r), '[]'::jsonb),
    'recent_errors', coalesce((select jsonb_agg(to_jsonb(e)) from errs e), '[]'::jsonb)
  );
$$;
