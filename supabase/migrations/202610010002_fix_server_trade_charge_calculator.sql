-- Reassign row-derived values inside BEGIN. The former DECLARE initializers
-- produced zero turnover for composite trade arguments on production.
create or replace function private.trade_charge_amount(t public.trades)
returns numeric language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  cfg public.charges_history;
  c jsonb;
  turnover numeric;
  typ text;
  exch text;
  trade_side text;
  stt numeric:=0; stamp numeric:=0; tot numeric:=0; sebi numeric:=0;
  ipf numeric:=0; clearing numeric:=0; gst numeric:=0; subtotal numeric:=0;
begin
  if t.id~'^(CF_CLOSE_|CF_OPEN_|ME_CLOSE_|ME_OPEN_)' then return 0; end if;
  turnover:=coalesce(t.price,0)*coalesce(t.qty,0);
  typ:=upper(coalesce(t."instrType",''));
  exch:=upper(coalesce(t.exchange,'NSE'));
  trade_side:=upper(coalesce(t.side,''));

  select h.* into cfg from public.charges_history h
  where h."effectiveFrom"<=t.date order by h."effectiveFrom" desc limit 1;
  if cfg.id is null then return 0; end if;

  if typ like '%OPT%' or typ in('OPTIONS','OPTION') or typ like '%FUT%' or typ in('FUTURES','FUTURE') then
    c:=case when exch='BSE' then cfg.fno_bse else cfg.fno_nse end;
    if typ like '%OPT%' or typ in('OPTIONS','OPTION') then
      stt:=case when trade_side='SELL' then turnover*coalesce((c->>'stt_opt_sell')::numeric,0)/100 else turnover*coalesce((c->>'stt_opt_buy')::numeric,0)/100 end;
      tot:=turnover*coalesce((c->>'tot_opt')::numeric,0)/100;
    else
      stt:=case when trade_side='SELL' then turnover*coalesce((c->>'stt_fut_sell')::numeric,0)/100 else turnover*coalesce((c->>'stt_fut_buy')::numeric,0)/100 end;
      tot:=turnover*coalesce((c->>'tot_fut')::numeric,0)/100;
    end if;
  else
    c:=case when exch='BSE' then cfg.eq_bse else cfg.eq_nse end;
    stt:=turnover*coalesce((c->>case when trade_side='BUY' then 'stt_del_buy' else 'stt_del_sell' end)::numeric,0)/100;
    tot:=turnover*coalesce((c->>'tot')::numeric,0)/100;
  end if;
  stamp:=case when trade_side='BUY' then turnover*coalesce((c->>'stamp_buy')::numeric,0)/100 else 0 end;
  sebi:=turnover*coalesce((c->>'sebi')::numeric,0)/100;
  ipf:=turnover*coalesce((c->>'ipf')::numeric,0)/100;
  clearing:=turnover*coalesce((c->>'clearing')::numeric,0)/100;
  gst:=(tot+clearing+sebi)*coalesce((c->>'gst')::numeric,0)/100;
  subtotal:=stt+stamp+tot+sebi+ipf+clearing+gst;
  return round(subtotal*(1+coalesce(cfg."extraMarkup",0)/100),2);
end $$;
revoke all on function private.trade_charge_amount(public.trades) from public,anon,authenticated;

insert into private.monthly_pnl_ledger_recovery(reason,ledger_row)
select 'Before final 2026-09 server charge calculator correction',to_jsonb(l)
from public.ledger l where l.id like 'AUTO\_PNL\_%\_202609' escape '\';

select private.post_monthly_pnl_ledger(date '2026-09-30');
