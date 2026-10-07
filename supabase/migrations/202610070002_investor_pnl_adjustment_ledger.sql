-- Investor month-end ledger rows are allocation-based, so add any adjustment
-- entered directly against the investor account to that allocated result.
create or replace function private.post_monthly_pnl_ledger(p_day date default ((now() at time zone 'Asia/Kolkata')::date))
returns integer
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare v_month text:=to_char(p_day,'YYYY-MM');v_count integer;
begin
 if p_day<>(date_trunc('month',p_day)+interval '1 month - 1 day')::date then return 0;end if;
 perform private.apply_daily_interest(p_day);perform private.apply_monthly_software(p_day);
 insert into public.ledger(id,"clientId",date,description,credit,debit,"ledgerType",created_at)
 with own_net as(select c.id,c."accountType",private.trading_month_net(c.id,v_month) pnl from public.clients c), final_net as(
  select o.id,case when o."accountType"='investor' then
    coalesce((select sum(private.trading_month_net(a."strategyClientId",v_month)*a."ownershipPct"/100) from public.investor_allocations a where a."investorClientId"=o.id and a.status<>'cancelled' and a."effectiveFrom"<=((p_day-date_part('day',p_day)::int+1)::date+time '09:15') at time zone 'Asia/Kolkata' and (a."effectiveTo" is null or a."effectiveTo">=(p_day+time '23:59:59') at time zone 'Asia/Kolkata')),0)
    + coalesce((select sum(i.amount) from public.interest i where i."clientId"=o.id and i."yearMonth"=v_month||'_PNL'),0)
  else o.pnl end pnl from own_net o)
 select 'AUTO_PNL_'||id||'_'||replace(v_month,'-',''),id,p_day::text,'PNL',case when pnl>0 then round(pnl,2) else 0 end,case when pnl<0 then round(abs(pnl),2) else 0 end,'all',p_day::timestamptz from final_net
 on conflict(id) do update set credit=excluded.credit,debit=excluded.debit,date=excluded.date,description='PNL';
 get diagnostics v_count=row_count;return v_count;
end $$;

revoke all on function private.post_monthly_pnl_ledger(date) from public,anon,authenticated;
