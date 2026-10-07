-- Include signed manual P&L adjustments in the canonical monthly net used by
-- automatic month-end ledger postings. These entries remain separate from
-- FIFO results and from interest/software/transaction charges.
create or replace function private.trading_month_net(p_client text,p_month text)
returns numeric
language sql
stable
security definer
set search_path=pg_catalog,public
as $$
  with tx as (
    select
      coalesce(sum(case when side='SELL' then price*qty else -price*qty end),0) gross,
      coalesce(sum(private.trade_charge_amount(t)),0) charges
    from public.trades t
    where "clientId"=p_client and date like p_month||'%'
  ), fees as (
    select
      coalesce(sum(amount) filter(where "yearMonth"=p_month),0)
      + coalesce(sum(amount) filter(where "yearMonth"=p_month||'_SW'),0) amount
    from public.interest
    where "clientId"=p_client
  ), adjustments as (
    select coalesce(sum(amount) filter(where "yearMonth"=p_month||'_PNL'),0) amount
    from public.interest
    where "clientId"=p_client
  )
  select round(tx.gross-tx.charges-fees.amount+adjustments.amount,2)
  from tx,fees,adjustments;
$$;

revoke all on function private.trading_month_net(text,text) from public,anon,authenticated;
