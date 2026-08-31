-- Audit/control records only. Synthetic close/reopen entries remain in public.trades
-- so the unchanged FIFO engine processes them exactly like broker trades.
create table if not exists public.carry_forward_batches (
  id text primary key,
  month text not null unique check (month ~ '^\d{4}-\d{2}$'),
  "monthEndDate" date not null,
  "reopenDate" date not null,
  status text not null check (status in ('processing','completed','failed')),
  "positionCount" integer not null check ("positionCount" >= 0),
  "tradeCount" integer not null check ("tradeCount" >= 0),
  details jsonb not null default '[]'::jsonb,
  error text,
  "createdBy" text not null,
  "createdAt" timestamptz not null default now(),
  "completedAt" timestamptz,
  check ("reopenDate" = "monthEndDate" + 1)
);

create index if not exists carry_forward_batches_status_idx on public.carry_forward_batches(status);
alter table public.carry_forward_batches enable row level security;

-- Supabase changed new-table Data API exposure defaults in 2026. Grants and
-- row policies must be added deliberately after the production auth review.
