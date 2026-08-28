-- Suivi automatique des résultats de signaux (TP1/TP2/SL touché) --
-- additif, ne touche à rien d'existant.
create table signal_outcomes (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans(id) on delete cascade,
  outcome text not null default 'pending', -- pending | tp1 | tp2 | sl | expired | no_data
  hit_price numeric,
  hit_at timestamptz,
  hours_after numeric,
  checked_count integer not null default 0,
  last_checked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index on signal_outcomes (scan_id);
create index on signal_outcomes (outcome);

-- Stats agrégées de performance (taux de réussite réel, par palier de temps)
create or replace function outcome_stats()
returns table (
  total_resolved bigint,
  wins bigint,
  losses bigint,
  win_rate_pct numeric,
  pending bigint,
  expired bigint
)
language sql stable as $$
  select
    count(*) filter (where outcome in ('tp1','tp2','sl'))                         as total_resolved,
    count(*) filter (where outcome in ('tp1','tp2'))                              as wins,
    count(*) filter (where outcome = 'sl')                                        as losses,
    round(
      100.0 * count(*) filter (where outcome in ('tp1','tp2'))
      / nullif(count(*) filter (where outcome in ('tp1','tp2','sl')), 0)
    , 1)                                                                          as win_rate_pct,
    count(*) filter (where outcome = 'pending')                                   as pending,
    count(*) filter (where outcome = 'expired')                                   as expired
  from signal_outcomes;
$$;
