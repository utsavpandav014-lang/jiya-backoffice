-- Master-admin emergency lockdown. This is isolated from trades, FIFO, P&L,
-- ledger, charges and month-end accounting.

create table if not exists public.emergency_lockdown_state (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  enabled_at timestamptz,
  disabled_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'JIYA'
);

insert into public.emergency_lockdown_state (id, enabled)
values (true, false)
on conflict (id) do nothing;

alter table public.emergency_lockdown_state enable row level security;
revoke all on table public.emergency_lockdown_state from public, anon, authenticated;

create or replace function private.get_emergency_lockdown()
returns jsonb
language sql security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'enabled', enabled,
    'enabledAt', enabled_at,
    'updatedAt', updated_at
  )
  from public.emergency_lockdown_state
  where id = true;
$$;

create or replace function public.get_emergency_lockdown()
returns jsonb
language sql security invoker
set search_path = pg_catalog, public
as $$ select private.get_emergency_lockdown(); $$;

create or replace function private.set_emergency_lockdown(
  p_user text,
  p_password text,
  p_enabled boolean
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  if p_user <> 'JIYA' or not private.is_jiya_admin(p_user, p_password) then
    raise exception 'Master administrator verification failed';
  end if;

  update public.emergency_lockdown_state
  set enabled = p_enabled,
      enabled_at = case when p_enabled then now() else enabled_at end,
      disabled_at = case when not p_enabled then now() else disabled_at end,
      updated_at = now(),
      updated_by = 'JIYA'
  where id = true
  returning jsonb_build_object(
    'enabled', enabled,
    'enabledAt', enabled_at,
    'updatedAt', updated_at
  ) into v_result;

  insert into public.audit_log (id, action, "clientId", details, actor, timestamp)
  values (
    'EMERGENCY_' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text || '_' || substr(md5(random()::text), 1, 8),
    case when p_enabled then 'EMERGENCY_LOCKDOWN_ENABLED' else 'EMERGENCY_LOCKDOWN_DISABLED' end,
    'SYSTEM',
    case when p_enabled then 'Master admin enabled site-wide emergency lockdown' else 'Master admin disabled site-wide emergency lockdown' end,
    'JIYA',
    now()
  );

  return v_result;
end;
$$;

create or replace function public.set_emergency_lockdown(
  p_user text,
  p_password text,
  p_enabled boolean
) returns jsonb
language sql security invoker
set search_path = pg_catalog, public
as $$ select private.set_emergency_lockdown(p_user, p_password, p_enabled); $$;

revoke all on function private.get_emergency_lockdown() from public, anon, authenticated;
revoke all on function private.set_emergency_lockdown(text,text,boolean) from public, anon, authenticated;
revoke all on function public.get_emergency_lockdown() from public, authenticated;
revoke all on function public.set_emergency_lockdown(text,text,boolean) from public, authenticated;

grant usage on schema private to anon;
grant execute on function private.get_emergency_lockdown() to anon;
grant execute on function private.set_emergency_lockdown(text,text,boolean) to anon;
grant execute on function public.get_emergency_lockdown() to anon;
grant execute on function public.set_emergency_lockdown(text,text,boolean) to anon;

