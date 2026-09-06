create table if not exists public.performance_leaderboard (
  month text not null,
  client_id text not null references public.clients(id) on update cascade on delete cascade,
  client_name text not null,
  pnl numeric not null,
  roi numeric not null,
  updated_at timestamptz not null default now(),
  primary key (month, client_id)
);

alter table public.performance_leaderboard enable row level security;
revoke all on table public.performance_leaderboard from public, anon, authenticated;

create or replace function private.save_performance_leaderboard(p_user text,p_password text,p_month text,p_rows jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_admin_id text; v_count integer;
begin
  if not private.is_jiya_admin(p_user,p_password) then raise exception 'Invalid leaderboard write credentials'; end if;
  if p_user <> 'JIYA' then select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1; end if;
  insert into public.performance_leaderboard(month,client_id,client_name,pnl,roi,updated_at)
  select p_month,c.id,c.name,x.pnl,x.roi,now()
  from jsonb_to_recordset(coalesce(p_rows,'[]'::jsonb)) as x(client_id text,pnl numeric,roi numeric)
  join public.clients c on c.id=x.client_id
  where p_user='JIYA' or c."adminId"=v_admin_id
  on conflict(month,client_id) do update set client_name=excluded.client_name,pnl=excluded.pnl,roi=excluded.roi,updated_at=excluded.updated_at;
  get diagnostics v_count = row_count; return v_count;
end; $$;

create or replace function private.get_performance_leaderboard(p_user text,p_password text,p_month text)
returns table("clientId" text,name text,roi numeric,pnl numeric,rank bigint)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_admin boolean; v_admin_id text; v_client boolean;
begin
  v_admin := private.is_jiya_admin(p_user,p_password);
  select exists(select 1 from public.clients where id=p_user and password=p_password) into v_client;
  if not v_admin and not v_client then raise exception 'Invalid leaderboard access credentials'; end if;
  if v_admin and p_user<>'JIYA' then select id into v_admin_id from public.admins where username=p_user and password=p_password limit 1; end if;
  return query
  with ranked as (
    select l.*,row_number() over(order by l.roi desc,l.pnl desc,l.client_id) as place
    from public.performance_leaderboard l join public.clients c on c.id=l.client_id
    where l.month=p_month and (not v_admin or p_user='JIYA' or c."adminId"=v_admin_id)
  )
  select r.client_id,r.client_name,r.roi,case when v_admin or r.client_id=p_user then r.pnl else null end,r.place
  from ranked r where r.place<=3 order by r.place;
end; $$;

revoke all on function private.save_performance_leaderboard(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function private.get_performance_leaderboard(text,text,text) from public,anon,authenticated;

create or replace function public.save_performance_leaderboard(p_user text,p_password text,p_month text,p_rows jsonb)
returns integer language sql security invoker set search_path=pg_catalog,public as $$ select private.save_performance_leaderboard(p_user,p_password,p_month,p_rows); $$;
create or replace function public.get_performance_leaderboard(p_user text,p_password text,p_month text)
returns table("clientId" text,name text,roi numeric,pnl numeric,rank bigint)
language sql security invoker set search_path=pg_catalog,public as $$ select * from private.get_performance_leaderboard(p_user,p_password,p_month); $$;

revoke all on function public.save_performance_leaderboard(text,text,text,jsonb) from public,authenticated;
revoke all on function public.get_performance_leaderboard(text,text,text) from public,authenticated;
grant usage on schema private to anon;
grant execute on function private.save_performance_leaderboard(text,text,text,jsonb) to anon;
grant execute on function private.get_performance_leaderboard(text,text,text) to anon;
grant execute on function public.save_performance_leaderboard(text,text,text,jsonb) to anon;
grant execute on function public.get_performance_leaderboard(text,text,text) to anon;
