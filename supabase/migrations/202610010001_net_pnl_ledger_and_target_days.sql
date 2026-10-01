-- Keep the server-side month-end ledger on the same charge schedule used by
-- the P&L screen. The UI has always used this default when no saved schedule
-- exists; seeding it here removes the client/server mismatch.
insert into public.charges_history(
  id,"effectiveFrom","extraMarkup",fno_nse,fno_bse,eq_nse,eq_bse
)
select
  'DEFAULT_20240101','2024-01-01',0,
  '{"stt_fut_buy":0,"stt_fut_sell":0.02,"stt_opt_buy":0,"stt_opt_sell":0.1,"stamp_buy":0.002,"stamp_sell":0,"tot_fut":0.0017,"tot_opt":0.04,"sebi":0.0001,"ipf":0.0001,"clearing":0.00045,"gst":18}'::jsonb,
  '{"stt_fut_buy":0,"stt_fut_sell":0.02,"stt_opt_buy":0,"stt_opt_sell":0.1,"stamp_buy":0.002,"stamp_sell":0,"tot_fut":0.0019,"tot_opt":0.0325,"sebi":0.0001,"ipf":0.0001,"clearing":0.00045,"gst":18}'::jsonb,
  '{"stt_del_buy":0.1,"stt_del_sell":0.1,"stt_intra_buy":0,"stt_intra_sell":0.025,"stamp_buy":0.015,"stamp_sell":0,"tot":0.00297,"sebi":0.0001,"ipf":0.0001,"clearing":0,"gst":18}'::jsonb,
  '{"stt_del_buy":0.1,"stt_del_sell":0.1,"stt_intra_buy":0,"stt_intra_sell":0.025,"stamp_buy":0.015,"stamp_sell":0,"tot":0.00345,"sebi":0.0001,"ipf":0.0001,"clearing":0,"gst":18}'::jsonb
where not exists (select 1 from public.charges_history);

-- Recovery snapshots are private and cannot be reached through PostgREST.
create table if not exists private.monthly_pnl_ledger_recovery(
  recovery_id bigint generated always as identity primary key,
  recovered_at timestamptz not null default now(),
  reason text not null,
  ledger_row jsonb not null
);
revoke all on table private.monthly_pnl_ledger_recovery from public,anon,authenticated;

insert into private.monthly_pnl_ledger_recovery(reason,ledger_row)
select 'Before 2026-09 net-P&L charge correction',to_jsonb(l)
from public.ledger l
where l.id like 'AUTO\_PNL\_%\_202609' escape '\';

-- Re-runs are idempotent: AUTO_PNL ids are updated, never duplicated.
select private.post_monthly_pnl_ledger(date '2026-09-30');

-- One shared days-left value per month. It affects presentation only.
create table if not exists public.target_days_settings(
  month text primary key check(month~'^\d{4}-\d{2}$'),
  days_left integer not null check(days_left between 1 and 366),
  updated_at timestamptz not null default now(),
  updated_by text not null
);
alter table public.target_days_settings enable row level security;
revoke all on table public.target_days_settings from public,anon,authenticated;

create or replace function private.get_target_days(p_month text)
returns integer language sql stable security definer set search_path=pg_catalog,public as $$
  select days_left from public.target_days_settings where month=p_month;
$$;

create or replace function private.set_target_days(p_user text,p_password text,p_month text,p_days integer)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_user<>'JIYA' or not private.is_jiya_admin(p_user,p_password) then
    raise exception 'Only the master admin can change target days';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' or p_days not between 1 and 366 then
    raise exception 'Enter days between 1 and 366';
  end if;
  insert into public.target_days_settings(month,days_left,updated_at,updated_by)
  values(p_month,p_days,now(),p_user)
  on conflict(month) do update set days_left=excluded.days_left,updated_at=now(),updated_by=excluded.updated_by;
  return p_days;
end $$;

create or replace function public.get_target_days(p_month text)
returns integer language sql security invoker set search_path=pg_catalog,public as $$
  select private.get_target_days(p_month);
$$;
create or replace function public.set_target_days(p_user text,p_password text,p_month text,p_days integer)
returns integer language sql security invoker set search_path=pg_catalog,public as $$
  select private.set_target_days(p_user,p_password,p_month,p_days);
$$;

revoke all on function private.get_target_days(text),private.set_target_days(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.get_target_days(text),public.set_target_days(text,text,text,integer) from public,authenticated;
grant usage on schema private to anon;
grant execute on function private.get_target_days(text),private.set_target_days(text,text,text,integer) to anon;
grant execute on function public.get_target_days(text),public.set_target_days(text,text,text,integer) to anon;
