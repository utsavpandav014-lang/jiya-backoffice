-- Persisted target access for JIYA's existing credential model.
-- Targets remain isolated from every financial/FIFO table.

drop function if exists public.set_client_monthly_target(text,text,numeric,text);
revoke all on function private.set_client_monthly_target(text,text,numeric,text) from public, anon;

create or replace function private.is_jiya_admin(p_user text, p_password text)
returns boolean language sql security definer
set search_path = pg_catalog, public
as $$
  select (p_user = 'JIYA' and p_password = 'Jiya@3044')
      or exists (
        select 1 from public.admins
        where username = p_user and password = p_password
      );
$$;

revoke all on function private.is_jiya_admin(text,text) from public, anon;

create or replace function private.get_monthly_targets(p_user text, p_password text)
returns setof public.client_monthly_targets
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_admin_id text;
begin
  if private.is_jiya_admin(p_user,p_password) then
    if p_user = 'JIYA' then
      return query select * from public.client_monthly_targets order by month desc, "clientId";
      return;
    end if;
    select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1;
    return query
      select t.* from public.client_monthly_targets t
      join public.clients c on c.id=t."clientId"
      where c."adminId"=v_admin_id
      order by t.month desc, t."clientId";
    return;
  end if;

  if exists(select 1 from public.clients where id=p_user and password=p_password) then
    return query select * from public.client_monthly_targets where "clientId"=p_user order by month desc;
    return;
  end if;
  raise exception 'Invalid target access credentials';
end;
$$;

revoke all on function private.get_monthly_targets(text,text) from public, anon;

create or replace function public.get_monthly_targets(p_user text, p_password text)
returns setof public.client_monthly_targets
language sql security invoker
set search_path = pg_catalog, public
as $$ select * from private.get_monthly_targets(p_user,p_password); $$;

revoke all on function public.get_monthly_targets(text,text) from public;
grant execute on function public.get_monthly_targets(text,text) to anon;
grant usage on schema private to anon;
grant execute on function private.get_monthly_targets(text,text) to anon;

create or replace function private.admin_set_client_monthly_target(
  p_client_id text, p_month text, p_target_amount numeric,
  p_admin_user text, p_admin_password text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_result jsonb; v_admin_id text;
begin
  if not private.is_jiya_admin(p_admin_user,p_admin_password) then raise exception 'Admin verification failed'; end if;
  if p_month !~ '^\d{4}-\d{2}$' then raise exception 'Invalid target month'; end if;
  if not exists(select 1 from public.clients where id=p_client_id) then raise exception 'Client was not found'; end if;
  if p_admin_user <> 'JIYA' then
    select id into v_admin_id from public.admins where username=p_admin_user and password=p_admin_password limit 1;
    if not exists(select 1 from public.clients where id=p_client_id and "adminId"=v_admin_id) then
      raise exception 'Client is outside this admin scope';
    end if;
  end if;
  if p_target_amount < 0 then raise exception 'Monthly target cannot be negative'; end if;
  if p_target_amount = 0 then
    delete from public.client_monthly_targets where "clientId"=p_client_id and month=p_month;
    return jsonb_build_object('clientId',p_client_id,'month',p_month,'targetAmount',0,'deleted',true);
  end if;
  insert into public.client_monthly_targets ("clientId",month,"targetAmount","createdBy","updatedAt")
  values (p_client_id,p_month,p_target_amount,p_admin_user,now())
  on conflict ("clientId",month) do update set
    "targetAmount"=excluded."targetAmount", "createdBy"=excluded."createdBy", "updatedAt"=now()
  returning to_jsonb(client_monthly_targets.*) into v_result;
  return v_result;
end;
$$;

revoke all on function private.admin_set_client_monthly_target(text,text,numeric,text,text) from public, anon;

create or replace function public.admin_set_client_monthly_target(
  p_client_id text, p_month text, p_target_amount numeric,
  p_admin_user text, p_admin_password text
) returns jsonb language sql security invoker
set search_path = pg_catalog, public
as $$ select private.admin_set_client_monthly_target(p_client_id,p_month,p_target_amount,p_admin_user,p_admin_password); $$;

revoke all on function public.admin_set_client_monthly_target(text,text,numeric,text,text) from public;
grant execute on function public.admin_set_client_monthly_target(text,text,numeric,text,text) to anon;
grant execute on function private.admin_set_client_monthly_target(text,text,numeric,text,text) to anon;

create or replace function private.set_own_monthly_target_once(
  p_client_id text, p_password text, p_target_amount numeric
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_month text := to_char(timezone('Asia/Kolkata',now()),'YYYY-MM'); v_result jsonb;
begin
  if not exists(
    select 1 from public.clients
    where id=p_client_id and password=p_password and coalesce("accountType",'trading') in ('trading','hybrid')
  ) then raise exception 'Trading client verification failed'; end if;
  if p_target_amount <= 0 then raise exception 'Monthly target must be greater than zero'; end if;
  if exists(select 1 from public.client_monthly_targets where "clientId"=p_client_id and month=v_month) then
    raise exception 'Target already locked for this month. Contact JIYA admin to change it';
  end if;
  insert into public.client_monthly_targets ("clientId",month,"targetAmount","createdBy","updatedAt")
  values (p_client_id,v_month,p_target_amount,p_client_id,now())
  returning to_jsonb(client_monthly_targets.*) into v_result;
  return v_result;
end;
$$;

revoke all on function private.set_own_monthly_target_once(text,text,numeric) from public, anon;

create or replace function public.set_own_monthly_target_once(
  p_client_id text, p_password text, p_target_amount numeric
) returns jsonb language sql security invoker
set search_path = pg_catalog, public
as $$ select private.set_own_monthly_target_once(p_client_id,p_password,p_target_amount); $$;

revoke all on function public.set_own_monthly_target_once(text,text,numeric) from public;
grant execute on function public.set_own_monthly_target_once(text,text,numeric) to anon;
grant execute on function private.set_own_monthly_target_once(text,text,numeric) to anon;
