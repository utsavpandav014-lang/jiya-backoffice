-- Change an active investor allocation by closing its old economic period and
-- opening a replacement at the exact same timestamp. No trades/FIFO are touched.
create or replace function private.modify_investor_allocation(
  p_user text,
  p_password text,
  p_allocation_id text,
  p_allocated_amount numeric,
  p_effective_from timestamptz,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_admin_id text;
  v_old public.investor_allocations%rowtype;
  v_investor public.clients%rowtype;
  v_strategy public.clients%rowtype;
  v_investor_other numeric;
  v_strategy_other numeric;
  v_new_id text;
  v_new jsonb;
  v_previous jsonb;
begin
  if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed'; end if;
  if p_user <> 'JIYA' then
    select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1;
  end if;
  select * into v_old from public.investor_allocations where id=p_allocation_id for update;
  if v_old.id is null then raise exception 'Allocation was not found'; end if;
  if v_old.status='closed' or v_old."effectiveTo" is not null then raise exception 'Only the active allocation can be changed'; end if;
  select * into v_investor from public.clients where id=v_old."investorClientId" for update;
  select * into v_strategy from public.clients where id=v_old."strategyClientId" for update;
  if p_user <> 'JIYA' and (v_investor."adminId" is distinct from v_admin_id or v_strategy."adminId" is distinct from v_admin_id) then
    raise exception 'Allocation is outside your client access';
  end if;
  if coalesce(p_allocated_amount,0)<=0 then raise exception 'Allocation amount must be greater than zero'; end if;
  if p_effective_from is null then raise exception 'Effective date and time are required'; end if;
  if p_effective_from<=v_old."effectiveFrom" then raise exception 'Change date must be after the original allocation start'; end if;
  if p_effective_from>now()+interval '5 minutes' then raise exception 'Change date cannot be in the future'; end if;
  if btrim(coalesce(p_reason,''))='' then raise exception 'Narration is mandatory'; end if;
  if v_strategy."monthlyStrategyCapital"<=0 then raise exception 'Strategy capital must be greater than zero'; end if;

  select coalesce(sum("allocatedAmount"),0) into v_investor_other from public.investor_allocations
    where "investorClientId"=v_old."investorClientId" and id<>v_old.id and status<>'closed' and "effectiveTo" is null;
  select coalesce(sum("allocatedAmount"),0) into v_strategy_other from public.investor_allocations
    where "strategyClientId"=v_old."strategyClientId" and id<>v_old.id and status<>'closed' and "effectiveTo" is null;
  if v_investor_other+p_allocated_amount>v_investor."depositAmount" then raise exception 'Allocation exceeds investor remaining fund (%)',v_investor."depositAmount"-v_investor_other; end if;
  if v_strategy_other+p_allocated_amount>v_strategy."monthlyStrategyCapital" then raise exception 'Allocation exceeds strategy remaining capacity (%)',v_strategy."monthlyStrategyCapital"-v_strategy_other; end if;

  update public.investor_allocations set "effectiveTo"=p_effective_from,status='closed'
    where id=v_old.id returning to_jsonb(investor_allocations.*) into v_previous;
  v_new_id:='IALLOC_'||floor(extract(epoch from clock_timestamp())*1000)::bigint||'_'||substr(md5(random()::text),1,6);
  insert into public.investor_allocations(id,"investorClientId","strategyClientId","allocatedAmount","strategyCapitalSnapshot","ownershipPct","effectiveFrom","effectiveTo",status,"ltpSnapshotStatus",reason,"createdBy","createdAt")
  values(v_new_id,v_old."investorClientId",v_old."strategyClientId",round(p_allocated_amount,2),v_strategy."monthlyStrategyCapital",round((p_allocated_amount/v_strategy."monthlyStrategyCapital")*100,6),p_effective_from,null,'active','pending',btrim(p_reason),coalesce(v_admin_id,p_user),now())
  returning to_jsonb(investor_allocations.*) into v_new;
  return jsonb_build_object('previous',v_previous,'current',v_new);
end;
$$;

revoke all on function private.modify_investor_allocation(text,text,text,numeric,timestamptz,text) from public,anon;

create or replace function public.modify_investor_allocation(p_user text,p_password text,p_allocation_id text,p_allocated_amount numeric,p_effective_from timestamptz,p_reason text)
returns jsonb language sql security invoker set search_path=pg_catalog,public as $$
  select private.modify_investor_allocation(p_user,p_password,p_allocation_id,p_allocated_amount,p_effective_from,p_reason)
$$;
revoke all on function public.modify_investor_allocation(text,text,text,numeric,timestamptz,text) from public;
grant usage on schema private to anon;
grant execute on function private.modify_investor_allocation(text,text,text,numeric,timestamptz,text) to anon;
grant execute on function public.modify_investor_allocation(text,text,text,numeric,timestamptz,text) to anon;
