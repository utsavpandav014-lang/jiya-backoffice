-- Monthly targets are presentation/control data only. They never write to trades,
-- positions, FIFO lots, charges, interest or P&L records.
create table if not exists public.client_monthly_targets (
  "clientId" text not null references public.clients(id) on update cascade on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  "targetAmount" numeric not null check ("targetAmount" > 0),
  "createdBy" text not null,
  "updatedAt" timestamptz not null default now(),
  primary key ("clientId", month)
);

create index if not exists client_monthly_targets_month_idx
  on public.client_monthly_targets(month);

alter table public.client_monthly_targets enable row level security;

create schema if not exists private;

create or replace function private.set_client_monthly_target(
  p_client_id text,
  p_month text,
  p_target_amount numeric,
  p_created_by text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if p_month !~ '^\d{4}-\d{2}$' then raise exception 'Invalid target month'; end if;
  if not exists(select 1 from public.clients where id=p_client_id) then raise exception 'Client was not found'; end if;
  if p_target_amount < 0 then raise exception 'Monthly target cannot be negative'; end if;
  if p_target_amount = 0 then
    delete from public.client_monthly_targets where "clientId"=p_client_id and month=p_month;
    return jsonb_build_object('clientId',p_client_id,'month',p_month,'targetAmount',0,'deleted',true);
  end if;

  insert into public.client_monthly_targets ("clientId", month, "targetAmount", "createdBy", "updatedAt")
  values (p_client_id, p_month, p_target_amount, coalesce(nullif(p_created_by,''),'JIYA'), now())
  on conflict ("clientId", month) do update
    set "targetAmount"=excluded."targetAmount", "createdBy"=excluded."createdBy", "updatedAt"=now()
  returning to_jsonb(client_monthly_targets.*) into v_result;
  return v_result;
end;
$$;

revoke all on function private.set_client_monthly_target(text,text,numeric,text) from public;
grant usage on schema private to anon;
grant execute on function private.set_client_monthly_target(text,text,numeric,text) to anon;

create or replace function public.set_client_monthly_target(
  p_client_id text,
  p_month text,
  p_target_amount numeric,
  p_created_by text
) returns jsonb
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select private.set_client_monthly_target(p_client_id,p_month,p_target_amount,p_created_by);
$$;

revoke all on function public.set_client_monthly_target(text,text,numeric,text) from public;
grant execute on function public.set_client_monthly_target(text,text,numeric,text) to anon;
