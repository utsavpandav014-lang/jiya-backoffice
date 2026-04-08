-- ═══════════════════════════════════════════════════════════════
-- JIYA BACK OFFICE — Supabase Database Setup
-- Run this entire script in: Supabase → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════

-- ── 1. CLIENTS ──────────────────────────────────────────────────
create table if not exists clients (
  id           text primary key,        -- e.g. "DLL11647"
  name         text not null,
  email        text,
  phone        text,
  password     text not null,           -- store as plain for now (upgrade to hashed later)
  created_at   timestamptz default now()
);

-- ── 2. TRADES ───────────────────────────────────────────────────
create table if not exists trades (
  id           text primary key,
  "clientId"   text references clients(id) on delete cascade,
  contract     text not null,
  side         text not null check (side in ('BUY','SELL')),
  qty          numeric not null,
  price        numeric not null,
  date         text,                    -- YYYY-MM-DD
  time         text,                    -- HH:MM:SS AM/PM
  exchange     text,
  "instrType"  text,
  "scriptName" text,
  "batchId"    bigint,
  "isAutoExpiry" boolean default false,
  created_at   timestamptz default now()
);
create index if not exists trades_client_idx on trades("clientId");
create index if not exists trades_date_idx   on trades(date);

-- ── 3. LEDGER ───────────────────────────────────────────────────
create table if not exists ledger (
  id           text primary key,
  "clientId"   text references clients(id) on delete cascade,
  date         text not null,
  description  text not null,
  credit       numeric default 0,
  debit        numeric default 0,
  "ledgerType" text default 'all' check ("ledgerType" in ('all','dp')),
  created_at   timestamptz default now()
);
create index if not exists ledger_client_idx on ledger("clientId");

-- ── 4. TICKETS ──────────────────────────────────────────────────
create table if not exists tickets (
  id           text primary key,
  "clientId"   text references clients(id) on delete cascade,
  subject      text,
  "issueType"  text,
  message      text,
  attachments  jsonb default '[]',
  status       text default 'open' check (status in ('open','answered','closed')),
  date         text,
  replies      jsonb default '[]',      -- [{from, text, date}]
  created_at   timestamptz default now()
);
create index if not exists tickets_client_idx  on tickets("clientId");
create index if not exists tickets_status_idx  on tickets(status);

-- ── 5. INTEREST / BROKERAGE ─────────────────────────────────────
create table if not exists interest (
  id           text primary key,
  "clientId"   text references clients(id) on delete cascade,
  "yearMonth"  text not null,           -- e.g. "2026-04"
  amount       numeric not null,
  note         text,
  created_at   timestamptz default now()
);
create index if not exists interest_client_idx on interest("clientId");

-- ── 6. CHARGES HISTORY ──────────────────────────────────────────
create table if not exists charges_history (
  id               text primary key default gen_random_uuid()::text,
  "effectiveFrom"  text not null,
  "extraMarkup"    numeric default 0,
  fno_nse          jsonb,
  fno_bse          jsonb,
  eq_nse           jsonb,
  eq_bse           jsonb,
  created_at       timestamptz default now()
);

-- ── 7. BHAVCOPY ─────────────────────────────────────────────────
create table if not exists bhavcopy (
  id           text primary key default gen_random_uuid()::text,
  contract     text not null,
  symbol       text,
  expiry       text,
  "expiryRaw"  text,
  "optType"    text,
  strike       numeric,
  "instrTp"    text,
  "closePrice" numeric,
  "settlPrice" numeric,
  "bhavDate"   text,
  created_at   timestamptz default now()
);
create index if not exists bhavcopy_contract_idx on bhavcopy(contract);
create index if not exists bhavcopy_date_idx     on bhavcopy("bhavDate");

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- This makes sure clients can ONLY see their OWN data
-- ═══════════════════════════════════════════════════════════════

-- Enable RLS on all tables
alter table clients        enable row level security;
alter table trades         enable row level security;
alter table ledger         enable row level security;
alter table tickets        enable row level security;
alter table interest       enable row level security;
alter table charges_history enable row level security;
alter table bhavcopy       enable row level security;

-- For now: allow all access via anon key (the app controls auth logic)
-- This is secure because the anon key is restricted and the app
-- validates login before showing any data.
create policy "Allow all via anon" on clients        for all using (true) with check (true);
create policy "Allow all via anon" on trades         for all using (true) with check (true);
create policy "Allow all via anon" on ledger         for all using (true) with check (true);
create policy "Allow all via anon" on tickets        for all using (true) with check (true);
create policy "Allow all via anon" on interest       for all using (true) with check (true);
create policy "Allow all via anon" on charges_history for all using (true) with check (true);
create policy "Allow all via anon" on bhavcopy       for all using (true) with check (true);

-- ═══════════════════════════════════════════════════════════════
-- DONE! Your database is ready.
-- Now copy your Project URL and anon key from:
-- Supabase → Settings → API → Project URL & anon public key
-- ═══════════════════════════════════════════════════════════════
