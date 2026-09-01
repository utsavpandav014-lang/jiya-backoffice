-- Safely edit every client/account field, including the primary client code.
-- Client-code changes cascade through all financial records in one transaction.

alter table public.trades drop constraint if exists "trades_clientId_fkey";
alter table public.trades add constraint "trades_clientId_fkey"
  foreign key ("clientId") references public.clients(id) on update cascade on delete cascade;

alter table public.ledger drop constraint if exists "ledger_clientId_fkey";
alter table public.ledger add constraint "ledger_clientId_fkey"
  foreign key ("clientId") references public.clients(id) on update cascade on delete cascade;

alter table public.interest drop constraint if exists "interest_clientId_fkey";
alter table public.interest add constraint "interest_clientId_fkey"
  foreign key ("clientId") references public.clients(id) on update cascade on delete cascade;

alter table public.tickets drop constraint if exists "tickets_clientId_fkey";
alter table public.tickets add constraint "tickets_clientId_fkey"
  foreign key ("clientId") references public.clients(id) on update cascade on delete cascade;

alter table public.investor_allocations drop constraint if exists "investor_allocations_investorClientId_fkey";
alter table public.investor_allocations add constraint "investor_allocations_investorClientId_fkey"
  foreign key ("investorClientId") references public.clients(id) on update cascade on delete restrict;

alter table public.investor_allocations drop constraint if exists "investor_allocations_strategyClientId_fkey";
alter table public.investor_allocations add constraint "investor_allocations_strategyClientId_fkey"
  foreign key ("strategyClientId") references public.clients(id) on update cascade on delete restrict;

create schema if not exists private;

create or replace function private.update_client_account(
  p_original_id text,
  p_client jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_new_id text := btrim(p_client->>'id');
  v_name text := btrim(p_client->>'name');
  v_email text := btrim(coalesce(p_client->>'email', ''));
  v_phone text := btrim(coalesce(p_client->>'phone', ''));
  v_password text := p_client->>'password';
  v_account_type text := coalesce(nullif(p_client->>'accountType',''), 'trading');
  v_deposit numeric := coalesce((p_client->>'depositAmount')::numeric, 0);
  v_strategy_capital numeric := coalesce((p_client->>'monthlyStrategyCapital')::numeric, 0);
  v_admin_id text := nullif(btrim(coalesce(p_client->>'adminId','')), '');
  v_investor_allocated numeric;
  v_strategy_allocated numeric;
  v_result jsonb;
begin
  if not exists (select 1 from public.clients where id=p_original_id) then
    raise exception 'Account % no longer exists', p_original_id;
  end if;
  if v_new_id = '' or v_new_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Client ID may contain only letters, numbers, underscore and hyphen';
  end if;
  if v_name = '' then raise exception 'Client name is required'; end if;
  if coalesce(v_password,'') = '' then raise exception 'Password is required'; end if;
  if v_account_type not in ('trading','investor','hybrid') then
    raise exception 'Invalid account type';
  end if;
  if v_deposit < 0 or v_strategy_capital < 0 then
    raise exception 'Fund values cannot be negative';
  end if;
  if v_account_type in ('investor','hybrid') and v_deposit <= 0 then
    raise exception 'Investor deposited fund must be greater than zero';
  end if;
  if v_account_type in ('trading','hybrid') and v_strategy_capital <= 0 then
    raise exception 'Monthly strategy capital must be greater than zero';
  end if;
  if v_new_id <> p_original_id and exists (select 1 from public.clients where id=v_new_id) then
    raise exception 'Client ID % already exists', v_new_id;
  end if;

  select coalesce(sum("allocatedAmount"),0) into v_investor_allocated
  from public.investor_allocations
  where "investorClientId"=p_original_id and status <> 'closed' and "effectiveTo" is null;

  select coalesce(sum("allocatedAmount"),0) into v_strategy_allocated
  from public.investor_allocations
  where "strategyClientId"=p_original_id and status <> 'closed' and "effectiveTo" is null;

  if v_investor_allocated > 0 and v_account_type not in ('investor','hybrid') then
    raise exception 'Account has active investor allocations and cannot become Trading-only';
  end if;
  if v_strategy_allocated > 0 and v_account_type not in ('trading','hybrid') then
    raise exception 'Account has active strategy allocations and cannot become Investor-only';
  end if;
  if v_investor_allocated > v_deposit then
    raise exception 'Deposited fund cannot be lower than active allocations (%)', v_investor_allocated;
  end if;
  if v_strategy_allocated > v_strategy_capital then
    raise exception 'Strategy capital cannot be lower than active allocations (%)', v_strategy_allocated;
  end if;

  -- These historical/live tables carry client codes but do not have FKs.
  if v_new_id <> p_original_id then
    update public.live_positions set "clientId"=v_new_id where "clientId"=p_original_id;
    update public.intraday_trades set "clientId"=v_new_id where "clientId"=p_original_id;
    update public.audit_log set "clientId"=v_new_id where "clientId"=p_original_id;
  end if;

  update public.clients
  set id=v_new_id,
      name=v_name,
      email=nullif(v_email,''),
      phone=nullif(v_phone,''),
      password=v_password,
      "accountType"=v_account_type,
      "depositAmount"=v_deposit,
      "monthlyStrategyCapital"=v_strategy_capital,
      "adminId"=v_admin_id
  where id=p_original_id
  returning to_jsonb(clients.*) into v_result;

  return v_result;
end;
$$;

revoke all on function private.update_client_account(text, jsonb) from public;
grant usage on schema private to anon;
grant execute on function private.update_client_account(text, jsonb) to anon;

create or replace function public.update_client_account(
  p_original_id text,
  p_client jsonb
) returns jsonb
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select private.update_client_account(p_original_id, p_client);
$$;

revoke all on function public.update_client_account(text, jsonb) from public;
grant execute on function public.update_client_account(text, jsonb) to anon;

create or replace function private.create_investor_allocation(
  p_allocation jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id text := btrim(p_allocation->>'id');
  v_investor_id text := btrim(p_allocation->>'investorClientId');
  v_strategy_id text := btrim(p_allocation->>'strategyClientId');
  v_amount numeric := coalesce((p_allocation->>'allocatedAmount')::numeric, 0);
  v_effective_from timestamptz := (p_allocation->>'effectiveFrom')::timestamptz;
  v_reason text := btrim(coalesce(p_allocation->>'reason',''));
  v_investor public.clients%rowtype;
  v_strategy public.clients%rowtype;
  v_investor_used numeric;
  v_strategy_used numeric;
  v_ownership numeric;
  v_result jsonb;
begin
  if v_id !~ '^IALLOC_[0-9]+(_[A-Za-z0-9]+)?$' then raise exception 'Invalid allocation identifier'; end if;
  if v_investor_id = '' or v_strategy_id = '' or v_investor_id = v_strategy_id then
    raise exception 'Select different investor and strategy accounts';
  end if;
  if v_amount <= 0 then raise exception 'Allocation amount must be greater than zero'; end if;
  if v_reason = '' then raise exception 'Narration is mandatory'; end if;
  if v_effective_from is null then raise exception 'Effective date and time are required'; end if;

  select * into v_investor from public.clients where id=v_investor_id for update;
  select * into v_strategy from public.clients where id=v_strategy_id for update;
  if v_investor.id is null or v_strategy.id is null then raise exception 'Investor or strategy account was not found'; end if;
  if v_investor."accountType" not in ('investor','hybrid') then raise exception 'Selected account is not an investor'; end if;
  if v_strategy."accountType" not in ('trading','hybrid') then raise exception 'Selected account is not a trading strategy'; end if;
  if exists (
    select 1 from public.investor_allocations
    where "investorClientId"=v_investor_id and "strategyClientId"=v_strategy_id
      and status <> 'closed' and "effectiveTo" is null
  ) then raise exception 'This investor already has an active allocation in the selected strategy'; end if;

  select coalesce(sum("allocatedAmount"),0) into v_investor_used
  from public.investor_allocations
  where "investorClientId"=v_investor_id and status <> 'closed' and "effectiveTo" is null;
  select coalesce(sum("allocatedAmount"),0) into v_strategy_used
  from public.investor_allocations
  where "strategyClientId"=v_strategy_id and status <> 'closed' and "effectiveTo" is null;

  if v_investor_used + v_amount > v_investor."depositAmount" then
    raise exception 'Allocation exceeds investor remaining fund (%)', v_investor."depositAmount" - v_investor_used;
  end if;
  if v_strategy_used + v_amount > v_strategy."monthlyStrategyCapital" then
    raise exception 'Allocation exceeds strategy remaining capacity (%)', v_strategy."monthlyStrategyCapital" - v_strategy_used;
  end if;

  v_ownership := round((v_amount / v_strategy."monthlyStrategyCapital") * 100, 6);
  insert into public.investor_allocations (
    id, "investorClientId", "strategyClientId", "allocatedAmount",
    "strategyCapitalSnapshot", "ownershipPct", "effectiveFrom", "effectiveTo",
    status, "ltpSnapshotStatus", reason, "createdBy", "createdAt"
  ) values (
    v_id, v_investor_id, v_strategy_id, v_amount,
    v_strategy."monthlyStrategyCapital", v_ownership, v_effective_from, null,
    'active', 'pending', v_reason,
    coalesce(nullif(p_allocation->>'createdBy',''),'JIYA'), now()
  ) returning to_jsonb(investor_allocations.*) into v_result;
  return v_result;
end;
$$;

revoke all on function private.create_investor_allocation(jsonb) from public;
grant execute on function private.create_investor_allocation(jsonb) to anon;

create or replace function public.create_investor_allocation(
  p_allocation jsonb
) returns jsonb
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select private.create_investor_allocation(p_allocation);
$$;

revoke all on function public.create_investor_allocation(jsonb) from public;
grant execute on function public.create_investor_allocation(jsonb) to anon;
