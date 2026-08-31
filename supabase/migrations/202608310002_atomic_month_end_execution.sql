-- Execute the whole month-end carry-forward as one validated transaction.
-- Direct browser writes to carry_forward_batches remain blocked by RLS.
create schema if not exists private;

create or replace function private.execute_month_end_carry_forward(
  p_batch jsonb,
  p_trades jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_month text := p_batch->>'month';
  v_batch_id text := p_batch->>'id';
  v_month_end date := (p_batch->>'monthEndDate')::date;
  v_reopen date := (p_batch->>'reopenDate')::date;
  v_position_count integer := (p_batch->>'positionCount')::integer;
  v_trade_count integer := jsonb_array_length(p_trades);
  v_trade_batch_id bigint := to_char(v_month_end, 'YYYYMMDD')::bigint;
  v_completed_at timestamptz := now();
  v_invalid integer;
begin
  if jsonb_typeof(p_batch) <> 'object' or jsonb_typeof(p_trades) <> 'array' then
    raise exception 'Invalid month-end payload';
  end if;
  if v_month !~ '^\d{4}-\d{2}$' or v_batch_id <> 'CF_' || replace(v_month, '-', '_') then
    raise exception 'Invalid month or batch identifier';
  end if;
  if v_month_end <> (date_trunc('month', v_month_end) + interval '1 month - 1 day')::date
     or to_char(v_month_end, 'YYYY-MM') <> v_month
     or v_reopen <> v_month_end + 1 then
    raise exception 'Invalid month boundary';
  end if;
  if v_position_count <= 0 or v_trade_count <> v_position_count * 2
     or (p_batch->>'tradeCount')::integer <> v_trade_count then
    raise exception 'Position/trade count mismatch';
  end if;
  if coalesce(p_batch->>'status', '') <> 'processing' then
    raise exception 'Batch must begin in processing status';
  end if;
  if exists (select 1 from public.carry_forward_batches where month = v_month or id = v_batch_id)
     or exists (select 1 from public.trades where "batchId" = v_trade_batch_id) then
    raise exception 'Month % has already been processed', v_month;
  end if;

  select count(*) into v_invalid
  from jsonb_array_elements(p_trades) t
  where coalesce((t->>'qty')::numeric, 0) <= 0
     or coalesce((t->>'price')::numeric, 0) <= 0
     or (t->>'batchId')::bigint <> v_trade_batch_id
     or coalesce(t->>'clientId', '') = ''
     or coalesce(t->>'contract', '') = ''
     or t->>'side' not in ('BUY', 'SELL')
     or not (
       ((t->>'id') like 'CF_CLOSE_' || v_batch_id || '_%' and (t->>'date')::date = v_month_end and t->>'time' = '23:59:59')
       or
       ((t->>'id') like 'CF_OPEN_' || v_batch_id || '_%' and (t->>'date')::date = v_reopen and t->>'time' = '00:00:01')
     );
  if v_invalid > 0 then
    raise exception '% malformed synthetic trades rejected', v_invalid;
  end if;

  -- Every sequence must contain exactly one opposite-side close and one reopen
  -- with identical client, contract, quantity and price.
  with parsed as (
    select
      regexp_replace(t->>'id', '^CF_(CLOSE|OPEN)_' || v_batch_id || '_', '') as seq,
      case when (t->>'id') like 'CF_CLOSE_%' then 'CLOSE' else 'OPEN' end as kind,
      t
    from jsonb_array_elements(p_trades) t
  ), pairs as (
    select seq,
      count(*) as row_count,
      count(*) filter (where kind='CLOSE') as close_count,
      count(*) filter (where kind='OPEN') as open_count,
      max(t->>'clientId') filter (where kind='CLOSE') as close_client,
      max(t->>'clientId') filter (where kind='OPEN') as open_client,
      max(t->>'contract') filter (where kind='CLOSE') as close_contract,
      max(t->>'contract') filter (where kind='OPEN') as open_contract,
      max((t->>'qty')::numeric) filter (where kind='CLOSE') as close_qty,
      max((t->>'qty')::numeric) filter (where kind='OPEN') as open_qty,
      max((t->>'price')::numeric) filter (where kind='CLOSE') as close_price,
      max((t->>'price')::numeric) filter (where kind='OPEN') as open_price,
      max(t->>'side') filter (where kind='CLOSE') as close_side,
      max(t->>'side') filter (where kind='OPEN') as open_side
    from parsed group by seq
  )
  select count(*) into v_invalid from pairs
  where row_count <> 2 or close_count <> 1 or open_count <> 1
     or close_client is distinct from open_client
     or close_contract is distinct from open_contract
     or close_qty is distinct from open_qty
     or close_price is distinct from open_price
     or close_side = open_side;
  if v_invalid > 0 then
    raise exception '% invalid close/reopen pairs rejected', v_invalid;
  end if;

  insert into public.carry_forward_batches (
    id, month, "monthEndDate", "reopenDate", status, "positionCount",
    "tradeCount", details, error, "createdBy", "createdAt", "completedAt"
  ) values (
    v_batch_id, v_month, v_month_end, v_reopen, 'processing', v_position_count,
    v_trade_count, coalesce(p_batch->'details', '[]'::jsonb), null,
    coalesce(nullif(p_batch->>'createdBy',''), 'JIYA'),
    coalesce((p_batch->>'createdAt')::timestamptz, now()), null
  );

  insert into public.trades (
    id, "clientId", contract, qty, price, exchange, "instrType",
    "scriptName", "scripCode", "batchId", side, date, time
  )
  select
    t->>'id', t->>'clientId', t->>'contract', (t->>'qty')::numeric,
    (t->>'price')::numeric, t->>'exchange', t->>'instrType',
    t->>'scriptName', coalesce(t->>'scripCode',''), (t->>'batchId')::bigint,
    t->>'side', t->>'date', t->>'time'
  from jsonb_array_elements(p_trades) t;

  update public.carry_forward_batches
  set status='completed', "completedAt"=v_completed_at
  where id=v_batch_id;

  return jsonb_build_object(
    'id', v_batch_id,
    'status', 'completed',
    'positionCount', v_position_count,
    'tradeCount', v_trade_count,
    'completedAt', v_completed_at
  );
end;
$$;

revoke all on function private.execute_month_end_carry_forward(jsonb, jsonb) from public;
grant usage on schema private to anon;
grant execute on function private.execute_month_end_carry_forward(jsonb, jsonb) to anon;

create or replace function public.execute_month_end_carry_forward(
  p_batch jsonb,
  p_trades jsonb
) returns jsonb
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select private.execute_month_end_carry_forward(p_batch, p_trades);
$$;

revoke all on function public.execute_month_end_carry_forward(jsonb, jsonb) from public;
grant execute on function public.execute_month_end_carry_forward(jsonb, jsonb) to anon;
