-- Additive only: does not alter trades, FIFO, positions, P&L, ledger or charges.
alter table public.clients
  add column if not exists "accountType" text not null default 'trading',
  add column if not exists "depositAmount" numeric(18,2) not null default 0,
  add column if not exists "monthlyStrategyCapital" numeric(18,2) not null default 0;
alter table public.clients drop constraint if exists clients_account_type_check;
alter table public.clients add constraint clients_account_type_check check ("accountType" in ('trading','investor','hybrid'));
alter table public.clients drop constraint if exists clients_deposit_amount_check;
alter table public.clients add constraint clients_deposit_amount_check check ("depositAmount" >= 0);
alter table public.clients drop constraint if exists clients_strategy_capital_check;
alter table public.clients add constraint clients_strategy_capital_check check ("monthlyStrategyCapital" >= 0);

create table if not exists public.investor_allocations (
  id text primary key,
  "investorClientId" text not null references public.clients(id) on delete restrict,
  "strategyClientId" text not null references public.clients(id) on delete restrict,
  "allocatedAmount" numeric(18,2) not null check ("allocatedAmount" > 0),
  "strategyCapitalSnapshot" numeric(18,2) not null check ("strategyCapitalSnapshot" > 0),
  "ownershipPct" numeric(12,6) not null check ("ownershipPct" > 0 and "ownershipPct" <= 100),
  "effectiveFrom" timestamptz not null,
  "effectiveTo" timestamptz,
  status text not null default 'active' check (status in ('active','closed')),
  "ltpSnapshotStatus" text not null default 'pending' check ("ltpSnapshotStatus" in ('pending','captured','not_required')),
  reason text not null check (length(trim(reason)) > 0),
  "createdBy" text not null,
  "createdAt" timestamptz not null default now(),
  check ("investorClientId" <> "strategyClientId"),
  check ("effectiveTo" is null or "effectiveTo" > "effectiveFrom")
);
create index if not exists investor_allocations_investor_period_idx on public.investor_allocations ("investorClientId", "effectiveFrom", "effectiveTo");
create index if not exists investor_allocations_strategy_period_idx on public.investor_allocations ("strategyClientId", "effectiveFrom", "effectiveTo");
alter table public.investor_allocations enable row level security;
-- Access policies must match the reviewed production authentication model before writes are enabled.
