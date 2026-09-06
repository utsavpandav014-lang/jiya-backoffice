alter table public.clients
  add column if not exists "adhocDeposit" numeric(18,2) not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_adhoc_deposit_check'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients
      add constraint clients_adhoc_deposit_check check ("adhocDeposit" >= 0);
  end if;
end $$;

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
  v_adhoc_deposit numeric := coalesce((p_client->>'adhocDeposit')::numeric, 0);
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
  if v_account_type not in ('trading','investor','hybrid') then raise exception 'Invalid account type'; end if;
  if v_deposit < 0 or v_strategy_capital < 0 or v_adhoc_deposit < 0 then
    raise exception 'Fund values cannot be negative';
  end if;
  if v_account_type in ('investor','hybrid') and v_deposit <= 0 then
    raise exception 'Investor cash deposit must be greater than zero';
  end if;
  if v_account_type in ('trading','hybrid') and v_strategy_capital <= 0 then
    raise exception 'Cash strategy capital must be greater than zero';
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
    raise exception 'Cash deposit cannot be lower than active allocations (%)', v_investor_allocated;
  end if;
  if v_strategy_allocated > v_strategy_capital then
    raise exception 'Cash strategy capital cannot be lower than active allocations (%)', v_strategy_allocated;
  end if;

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
      "adhocDeposit"=v_adhoc_deposit,
      "adminId"=v_admin_id
  where id=p_original_id
  returning to_jsonb(clients.*) into v_result;

  return v_result;
end;
$$;

revoke all on function private.update_client_account(text, jsonb) from public;
grant usage on schema private to anon;
grant execute on function private.update_client_account(text, jsonb) to anon;
