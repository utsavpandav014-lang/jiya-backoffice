create extension if not exists pg_cron;

create table if not exists public.daily_interest_settings (
  id uuid primary key default gen_random_uuid(),
  "clientId" text not null references public.clients(id) on update cascade on delete cascade,
  capital numeric(18,2) not null check (capital > 0),
  "annualRate" numeric(9,4) not null check ("annualRate" > 0),
  "effectiveFrom" date not null,
  "effectiveTo" date,
  active boolean not null default true,
  "createdAt" timestamptz not null default now(),
  check ("effectiveTo" is null or "effectiveTo" >= "effectiveFrom")
);
create unique index if not exists daily_interest_one_active_client_idx on public.daily_interest_settings("clientId") where active;
alter table public.daily_interest_settings enable row level security;
revoke all on table public.daily_interest_settings from public,anon,authenticated;

create or replace function private.apply_daily_interest(p_through date default ((now() at time zone 'Asia/Kolkata')::date))
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  insert into public.interest(id,"clientId","yearMonth",amount,note,"entryType",created_at)
  select 'AUTOINT_'||s."clientId"||'_'||to_char(d.day,'YYYYMMDD'),s."clientId",to_char(d.day,'YYYY-MM'),
         round(s.capital*s."annualRate"/100/365,2),
         'Daily interest - '||to_char(d.day,'DD Mon YYYY')||' - INR '||s.capital||' @ '||s."annualRate"||'% yearly',
         'interest',d.day::timestamptz
  from public.daily_interest_settings s
  cross join lateral generate_series(s."effectiveFrom",least(coalesce(s."effectiveTo",p_through),p_through),interval '1 day') d(day)
  join public.clients c on c.id=s."clientId" and c."accountType"='trading'
  where s."effectiveFrom"<=p_through
  on conflict(id) do update set amount=excluded.amount,note=excluded.note,"yearMonth"=excluded."yearMonth","entryType"='interest';
  get diagnostics v_count=row_count; return v_count;
end $$;
revoke all on function private.apply_daily_interest(date) from public,anon,authenticated;

create or replace function private.get_daily_interest_settings(p_user text,p_password text)
returns table(id uuid,"clientId" text,"clientName" text,capital numeric,"annualRate" numeric,"effectiveFrom" date,"effectiveTo" date,active boolean,"dailyAmount" numeric)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_admin_id text;
begin
  if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed'; end if;
  if p_user<>'JIYA' then select a.id into v_admin_id from public.admins a where a.username=p_user and a.password=p_password limit 1; end if;
  return query select s.id,s."clientId",c.name,s.capital,s."annualRate",s."effectiveFrom",s."effectiveTo",s.active,round(s.capital*s."annualRate"/100/365,2)
  from public.daily_interest_settings s join public.clients c on c.id=s."clientId"
  where p_user='JIYA' or c."adminId"=v_admin_id order by s.active desc,s."effectiveFrom" desc;
end $$;

create or replace function private.save_daily_interest_setting(p_user text,p_password text,p_client_id text,p_capital numeric,p_annual_rate numeric)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_admin_id text; v_row jsonb; v_today date:=((now() at time zone 'Asia/Kolkata')::date);
begin
  if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed'; end if;
  if p_capital<=0 or p_annual_rate<=0 then raise exception 'Capital and annual rate must be greater than zero'; end if;
  if p_user<>'JIYA' then select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1; end if;
  if not exists(select 1 from public.clients where id=p_client_id and "accountType"='trading' and (p_user='JIYA' or "adminId"=v_admin_id)) then raise exception 'Select an accessible trading account'; end if;
  update public.daily_interest_settings set active=false,"effectiveTo"=v_today-1 where "clientId"=p_client_id and active and "effectiveFrom"<v_today;
  delete from public.daily_interest_settings where "clientId"=p_client_id and active and "effectiveFrom">=v_today;
  insert into public.daily_interest_settings("clientId",capital,"annualRate","effectiveFrom") values(p_client_id,p_capital,p_annual_rate,v_today)
  returning to_jsonb(daily_interest_settings.*) into v_row;
  perform private.apply_daily_interest(v_today); return v_row;
end $$;

create or replace function private.pause_daily_interest_setting(p_user text,p_password text,p_client_id text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_admin_id text; v_today date:=((now() at time zone 'Asia/Kolkata')::date);
begin
  if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed'; end if;
  if p_user<>'JIYA' then select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1; end if;
  update public.daily_interest_settings s set active=false,"effectiveTo"=v_today
  from public.clients c where s."clientId"=p_client_id and s.active and c.id=s."clientId" and (p_user='JIYA' or c."adminId"=v_admin_id);
  return found;
end $$;

create or replace function private.add_bulk_charges(p_user text,p_password text,p_month text,p_entry_type text,p_rows jsonb)
returns setof public.interest language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_admin_id text;
begin
  if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed'; end if;
  if p_month!~'^\d{4}-\d{2}$' or p_entry_type not in ('interest','software') then raise exception 'Invalid month or charge type'; end if;
  if p_user<>'JIYA' then select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1; end if;
  return query insert into public.interest(id,"clientId","yearMonth",amount,note,"entryType")
  select 'BULK_'||replace(gen_random_uuid()::text,'-',''),c.id,case when p_entry_type='software' then p_month||'_SW' else p_month end,
         round(x.amount,2),case when p_entry_type='software' then 'Bulk Software Charges' else 'Bulk Interest / Brokerage' end,p_entry_type
  from jsonb_to_recordset(coalesce(p_rows,'[]'::jsonb)) x(client_id text,amount numeric)
  join public.clients c on c.id=x.client_id
  where x.amount>0 and c."accountType"='trading' and (p_user='JIYA' or c."adminId"=v_admin_id)
  returning *;
end $$;

create or replace function public.get_daily_interest_settings(p_user text,p_password text) returns table(id uuid,"clientId" text,"clientName" text,capital numeric,"annualRate" numeric,"effectiveFrom" date,"effectiveTo" date,active boolean,"dailyAmount" numeric)
language sql security invoker set search_path=pg_catalog,public as $$select * from private.get_daily_interest_settings(p_user,p_password)$$;
create or replace function public.save_daily_interest_setting(p_user text,p_password text,p_client_id text,p_capital numeric,p_annual_rate numeric) returns jsonb language sql security invoker set search_path=pg_catalog,public as $$select private.save_daily_interest_setting(p_user,p_password,p_client_id,p_capital,p_annual_rate)$$;
create or replace function public.pause_daily_interest_setting(p_user text,p_password text,p_client_id text) returns boolean language sql security invoker set search_path=pg_catalog,public as $$select private.pause_daily_interest_setting(p_user,p_password,p_client_id)$$;
create or replace function public.add_bulk_charges(p_user text,p_password text,p_month text,p_entry_type text,p_rows jsonb) returns setof public.interest language sql security invoker set search_path=pg_catalog,public as $$select * from private.add_bulk_charges(p_user,p_password,p_month,p_entry_type,p_rows)$$;
revoke all on function public.get_daily_interest_settings(text,text),public.save_daily_interest_setting(text,text,text,numeric,numeric),public.pause_daily_interest_setting(text,text,text),public.add_bulk_charges(text,text,text,text,jsonb) from public,authenticated;
grant usage on schema private to anon;
grant execute on function private.get_daily_interest_settings(text,text),private.save_daily_interest_setting(text,text,text,numeric,numeric),private.pause_daily_interest_setting(text,text,text),private.add_bulk_charges(text,text,text,text,jsonb) to anon;
grant execute on function public.get_daily_interest_settings(text,text),public.save_daily_interest_setting(text,text,text,numeric,numeric),public.pause_daily_interest_setting(text,text,text),public.add_bulk_charges(text,text,text,text,jsonb) to anon;

do $$ begin
  if exists(select 1 from cron.job where jobname='jiya-daily-interest') then perform cron.unschedule('jiya-daily-interest'); end if;
  perform cron.schedule('jiya-daily-interest','5 0 * * *','select private.apply_daily_interest();');
end $$;
