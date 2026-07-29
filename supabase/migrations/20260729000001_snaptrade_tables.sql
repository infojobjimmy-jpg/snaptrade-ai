create table scans (
  id uuid primary key default gen_random_uuid(),
  whop_user_id text,
  symbol_guess text,
  direction text,
  confidence numeric,
  entry numeric, tp1 numeric, tp2 numeric, sl numeric,
  rr_ratio text,
  mode text,
  data_source text,
  lot_size numeric,
  reasoning text,
  created_at timestamptz default now()
);
create index on scans (whop_user_id);

create table user_quotas (
  whop_user_id text primary key,
  plan text not null default 'essai',
  scans_used_this_month integer not null default 0,
  scans_used_lifetime integer not null default 0,
  period_start timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
