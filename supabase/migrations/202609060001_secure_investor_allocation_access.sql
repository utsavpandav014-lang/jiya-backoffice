-- Read investor allocations through JIYA's existing credential model while
-- keeping the RLS-protected table unavailable to anonymous direct SELECTs.

create or replace function private.get_investor_allocations(
  p_user text,
  p_password text
) returns setof public.investor_allocations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_admin_id text;
begin
  if private.is_jiya_admin(p_user, p_password) then
    if p_user = 'JIYA' then
      return query
        select * from public.investor_allocations
        order by "effectiveFrom" desc, id;
      return;
    end if;

    select id into v_admin_id
    from public.admins
    where username = p_user and password = p_password
    limit 1;

    return query
      select allocation.*
      from public.investor_allocations allocation
      join public.clients investor on investor.id = allocation."investorClientId"
      join public.clients strategy on strategy.id = allocation."strategyClientId"
      where investor."adminId" = v_admin_id or strategy."adminId" = v_admin_id
      order by allocation."effectiveFrom" desc, allocation.id;
    return;
  end if;

  if exists (
    select 1 from public.clients
    where id = p_user and password = p_password
      and coalesce("accountType", 'trading') in ('investor', 'hybrid')
  ) then
    return query
      select * from public.investor_allocations
      where "investorClientId" = p_user
      order by "effectiveFrom" desc, id;
    return;
  end if;

  raise exception 'Invalid investor allocation access credentials';
end;
$$;

revoke all on function private.get_investor_allocations(text,text) from public, anon;

create or replace function public.get_investor_allocations(
  p_user text,
  p_password text
) returns setof public.investor_allocations
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select * from private.get_investor_allocations(p_user, p_password);
$$;

revoke all on function public.get_investor_allocations(text,text) from public;
grant usage on schema private to anon;
grant execute on function private.get_investor_allocations(text,text) to anon;
grant execute on function public.get_investor_allocations(text,text) to anon;

