create table if not exists public.monthly_software_settings(
 id uuid primary key default gen_random_uuid(),
 "clientId" text not null references public.clients(id) on update cascade on delete cascade,
 amount numeric(18,2) not null check(amount>0),
 "effectiveFrom" text not null check("effectiveFrom"~'^\d{4}-\d{2}$'),
 "effectiveTo" text check("effectiveTo" is null or "effectiveTo"~'^\d{4}-\d{2}$'),
 active boolean not null default true,"createdAt" timestamptz not null default now()
);
create unique index if not exists monthly_software_one_active_client_idx on public.monthly_software_settings("clientId") where active;
alter table public.monthly_software_settings enable row level security;
revoke all on table public.monthly_software_settings from public,anon,authenticated;

create or replace function private.apply_monthly_software(p_day date default ((now() at time zone 'Asia/Kolkata')::date))
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_month text:=to_char(p_day,'YYYY-MM');v_count integer;
begin
 if p_day<>(date_trunc('month',p_day)+interval '1 month - 1 day')::date then return 0; end if;
 insert into public.interest(id,"clientId","yearMonth",amount,note,"entryType",created_at)
 select 'AUTO_SW_'||s."clientId"||'_'||replace(v_month,'-',''),s."clientId",v_month||'_SW',s.amount,'Monthly Software Charges','software',p_day::timestamptz
 from public.monthly_software_settings s join public.clients c on c.id=s."clientId" and c."accountType"='trading'
 where s."effectiveFrom"<=v_month and coalesce(s."effectiveTo",v_month)>=v_month
 on conflict(id) do update set amount=excluded.amount,note=excluded.note,"yearMonth"=excluded."yearMonth","entryType"='software';
 get diagnostics v_count=row_count;return v_count;
end $$;
revoke all on function private.apply_monthly_software(date) from public,anon,authenticated;

create or replace function private.trade_charge_amount(t public.trades)
returns numeric language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare cfg public.charges_history; c jsonb; turnover numeric:=coalesce(t.price,0)*coalesce(t.qty,0); typ text:=upper(coalesce(t."instrType",'')); exch text:=upper(coalesce(t.exchange,'NSE')); stt numeric:=0;stamp numeric:=0;tot numeric:=0;sebi numeric:=0;ipf numeric:=0;clearing numeric:=0;gst numeric:=0;subtotal numeric;
begin
 if t.id~'^(CF_CLOSE_|CF_OPEN_|ME_CLOSE_|ME_OPEN_)' then return 0;end if;
 select h into cfg from public.charges_history h where h."effectiveFrom"<=t.date order by h."effectiveFrom" desc limit 1;
 if cfg.id is null then return 0;end if;
 if typ like '%OPT%' or typ in('OPTIONS','OPTION') or typ like '%FUT%' or typ in('FUTURES','FUTURE') then
  c:=case when exch='BSE' then cfg.fno_bse else cfg.fno_nse end;
  if typ like '%OPT%' or typ in('OPTIONS','OPTION') then stt:=case when t.side='SELL' then turnover*coalesce((c->>'stt_opt_sell')::numeric,0)/100 else turnover*coalesce((c->>'stt_opt_buy')::numeric,0)/100 end;tot:=turnover*coalesce((c->>'tot_opt')::numeric,0)/100;
  else stt:=case when t.side='SELL' then turnover*coalesce((c->>'stt_fut_sell')::numeric,0)/100 else turnover*coalesce((c->>'stt_fut_buy')::numeric,0)/100 end;tot:=turnover*coalesce((c->>'tot_fut')::numeric,0)/100;end if;
 else c:=case when exch='BSE' then cfg.eq_bse else cfg.eq_nse end;stt:=turnover*coalesce((c->>case when t.side='BUY' then 'stt_del_buy' else 'stt_del_sell' end)::numeric,0)/100;tot:=turnover*coalesce((c->>'tot')::numeric,0)/100;end if;
 stamp:=case when t.side='BUY' then turnover*coalesce((c->>'stamp_buy')::numeric,0)/100 else 0 end;sebi:=turnover*coalesce((c->>'sebi')::numeric,0)/100;ipf:=turnover*coalesce((c->>'ipf')::numeric,0)/100;clearing:=turnover*coalesce((c->>'clearing')::numeric,0)/100;gst:=(tot+clearing+sebi)*coalesce((c->>'gst')::numeric,0)/100;subtotal:=stt+stamp+tot+sebi+ipf+clearing+gst;
 return round(subtotal*(1+coalesce(cfg."extraMarkup",0)/100),2);
end $$;
revoke all on function private.trade_charge_amount(public.trades) from public,anon,authenticated;

create or replace function private.trading_month_net(p_client text,p_month text) returns numeric language sql stable security definer set search_path=pg_catalog,public as $$
 with tx as(select coalesce(sum(case when side='SELL' then price*qty else -price*qty end),0) gross,coalesce(sum(private.trade_charge_amount(t)),0) charges from public.trades t where "clientId"=p_client and date like p_month||'%'), fees as(select coalesce(sum(amount) filter(where "yearMonth"=p_month),0)+coalesce(sum(amount) filter(where "yearMonth"=p_month||'_SW'),0) amount from public.interest where "clientId"=p_client)
 select round(tx.gross-tx.charges-fees.amount,2) from tx,fees;
$$;
revoke all on function private.trading_month_net(text,text) from public,anon,authenticated;

create or replace function private.post_monthly_pnl_ledger(p_day date default ((now() at time zone 'Asia/Kolkata')::date)) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_month text:=to_char(p_day,'YYYY-MM');v_count integer;
begin
 if p_day<>(date_trunc('month',p_day)+interval '1 month - 1 day')::date then return 0;end if;
 perform private.apply_daily_interest(p_day);perform private.apply_monthly_software(p_day);
 insert into public.ledger(id,"clientId",date,description,credit,debit,"ledgerType",created_at)
 with own_net as(select c.id,c."accountType",private.trading_month_net(c.id,v_month) pnl from public.clients c), final_net as(
  select o.id,case when o."accountType"='investor' then coalesce((select sum(private.trading_month_net(a."strategyClientId",v_month)*a."ownershipPct"/100) from public.investor_allocations a where a."investorClientId"=o.id and a.status<>'cancelled' and a."effectiveFrom"<=((p_day-date_part('day',p_day)::int+1)::date+time '09:15') at time zone 'Asia/Kolkata' and (a."effectiveTo" is null or a."effectiveTo">=(p_day+time '23:59:59') at time zone 'Asia/Kolkata')),0) else o.pnl end pnl from own_net o)
 select 'AUTO_PNL_'||id||'_'||replace(v_month,'-',''),id,p_day::text,'PNL',case when pnl>0 then round(pnl,2) else 0 end,case when pnl<0 then round(abs(pnl),2) else 0 end,'all',p_day::timestamptz from final_net
 on conflict(id) do update set credit=excluded.credit,debit=excluded.debit,date=excluded.date,description='PNL';
 get diagnostics v_count=row_count;return v_count;
end $$;
revoke all on function private.post_monthly_pnl_ledger(date) from public,anon,authenticated;

create or replace function private.get_monthly_software_settings(p_user text,p_password text) returns table(id uuid,"clientId" text,"clientName" text,amount numeric,"effectiveFrom" text,"effectiveTo" text,active boolean) language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_admin_id text;begin if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed';end if;if p_user<>'JIYA' then select a.id into v_admin_id from public.admins a where a.username=p_user and a.password=p_password limit 1;end if;return query select s.id,s."clientId",c.name,s.amount,s."effectiveFrom",s."effectiveTo",s.active from public.monthly_software_settings s join public.clients c on c.id=s."clientId" where p_user='JIYA' or c."adminId"=v_admin_id order by s.active desc,s."effectiveFrom" desc;end $$;
create or replace function private.save_monthly_software_setting(p_user text,p_password text,p_client text,p_amount numeric) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_admin_id text;v_month text:=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM');v_prev text:=to_char((date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month'),'YYYY-MM');v jsonb;begin if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed';end if;if p_amount<=0 then raise exception 'Amount must be greater than zero';end if;if p_user<>'JIYA' then select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1;end if;if not exists(select 1 from public.clients where id=p_client and "accountType"='trading' and(p_user='JIYA' or "adminId"=v_admin_id)) then raise exception 'Select an accessible trading account';end if;update public.monthly_software_settings set active=false,"effectiveTo"=v_prev where "clientId"=p_client and active and "effectiveFrom"<v_month;delete from public.monthly_software_settings where "clientId"=p_client and active and "effectiveFrom">=v_month;insert into public.monthly_software_settings("clientId",amount,"effectiveFrom") values(p_client,p_amount,v_month) returning to_jsonb(monthly_software_settings.*) into v;perform private.apply_monthly_software();return v;end $$;
create or replace function private.pause_monthly_software_setting(p_user text,p_password text,p_client text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_admin_id text;v_month text:=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM');v_previous_month text:=to_char((date_trunc('month',now() at time zone 'Asia/Kolkata')-interval '1 month')::date,'YYYY-MM');v_found boolean:=false;begin if not private.is_jiya_admin(p_user,p_password) then raise exception 'Admin verification failed';end if;if p_user<>'JIYA' then select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1;end if;delete from public.monthly_software_settings s using public.clients c where s."clientId"=p_client and s.active and s."effectiveFrom">=v_month and c.id=s."clientId" and(p_user='JIYA' or c."adminId"=v_admin_id);v_found:=found;update public.monthly_software_settings s set active=false,"effectiveTo"=v_previous_month from public.clients c where s."clientId"=p_client and s.active and s."effectiveFrom"<v_month and c.id=s."clientId" and(p_user='JIYA' or c."adminId"=v_admin_id);return v_found or found;end $$;

create or replace function public.get_monthly_software_settings(p_user text,p_password text) returns table(id uuid,"clientId" text,"clientName" text,amount numeric,"effectiveFrom" text,"effectiveTo" text,active boolean) language sql security invoker set search_path=pg_catalog,public as $$select * from private.get_monthly_software_settings(p_user,p_password)$$;
create or replace function public.save_monthly_software_setting(p_user text,p_password text,p_client text,p_amount numeric) returns jsonb language sql security invoker set search_path=pg_catalog,public as $$select private.save_monthly_software_setting(p_user,p_password,p_client,p_amount)$$;
create or replace function public.pause_monthly_software_setting(p_user text,p_password text,p_client text) returns boolean language sql security invoker set search_path=pg_catalog,public as $$select private.pause_monthly_software_setting(p_user,p_password,p_client)$$;
revoke all on function public.get_monthly_software_settings(text,text),public.save_monthly_software_setting(text,text,text,numeric),public.pause_monthly_software_setting(text,text,text) from public,authenticated;
grant usage on schema private to anon;grant execute on function private.get_monthly_software_settings(text,text),private.save_monthly_software_setting(text,text,text,numeric),private.pause_monthly_software_setting(text,text,text) to anon;grant execute on function public.get_monthly_software_settings(text,text),public.save_monthly_software_setting(text,text,text,numeric),public.pause_monthly_software_setting(text,text,text) to anon;

do $$begin if exists(select 1 from cron.job where jobname='jiya-monthly-software')then perform cron.unschedule('jiya-monthly-software');end if;perform cron.schedule('jiya-monthly-software','30 13 * * *','select private.apply_monthly_software();');if exists(select 1 from cron.job where jobname='jiya-monthly-pnl-ledger')then perform cron.unschedule('jiya-monthly-pnl-ledger');end if;perform cron.schedule('jiya-monthly-pnl-ledger','30 17 * * *','select private.post_monthly_pnl_ledger();');end $$;
