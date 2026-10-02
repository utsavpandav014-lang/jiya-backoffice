create table if not exists public.login_announcements(
  id uuid primary key default gen_random_uuid(),
  title text not null check(char_length(title) between 1 and 160),
  description text not null check(char_length(description) between 1 and 5000),
  audience text not null check(audience in('everyone','investors','clients','custom')),
  "clientIds" text[] not null default '{}',
  "imageData" text,
  active boolean not null default true,
  "activatedAt" timestamptz not null default now(),
  "createdAt" timestamptz not null default now(),
  "createdBy" text not null
);
create table if not exists public.login_announcement_receipts(
  "announcementId" uuid not null references public.login_announcements(id) on delete cascade,
  "clientId" text not null references public.clients(id) on update cascade on delete cascade,
  "seenAt" timestamptz not null default now(),
  primary key("announcementId","clientId")
);
create index if not exists login_announcement_receipts_client_idx on public.login_announcement_receipts("clientId");
alter table public.login_announcements enable row level security;
alter table public.login_announcement_receipts enable row level security;
revoke all on public.login_announcements,public.login_announcement_receipts from public,anon,authenticated;

create or replace function private.get_admin_login_announcement(p_user text,p_password text)
returns table(id uuid,title text,description text,audience text,"clientIds" text[],"imageData" text,active boolean,"activatedAt" timestamptz,"recipientCount" bigint,"seenCount" bigint)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_user<>'JIYA' or not private.is_jiya_admin(p_user,p_password) then raise exception 'Master admin verification failed'; end if;
  return query
  select a.id,a.title,a.description,a.audience,a."clientIds",a."imageData",a.active,a."activatedAt",
    (select count(*) from public.clients c where
      a.audience='everyone' or
      (a.audience='investors' and c."accountType"='investor') or
      (a.audience='clients' and coalesce(c."accountType",'trading') in('trading','hybrid')) or
      (a.audience='custom' and c.id=any(a."clientIds"))) as "recipientCount",
    (select count(*) from public.login_announcement_receipts r where r."announcementId"=a.id) as "seenCount"
  from public.login_announcements a order by a."activatedAt" desc limit 1;
end $$;

create or replace function private.activate_login_announcement(p_user text,p_password text,p_title text,p_description text,p_audience text,p_client_ids text[],p_image_data text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  if p_user<>'JIYA' or not private.is_jiya_admin(p_user,p_password) then raise exception 'Only the master admin can activate announcements'; end if;
  if nullif(btrim(p_title),'') is null or nullif(btrim(p_description),'') is null then raise exception 'Title and description are required'; end if;
  if char_length(p_title)>160 or char_length(p_description)>5000 then raise exception 'Announcement text is too long'; end if;
  if p_audience not in('everyone','investors','clients','custom') then raise exception 'Invalid audience'; end if;
  if p_audience='custom' and coalesce(cardinality(p_client_ids),0)=0 then raise exception 'Select at least one account'; end if;
  if p_image_data is not null and (p_image_data !~ '^data:image/(png|jpeg|webp);base64,' or octet_length(p_image_data)>2800000) then raise exception 'Image must be PNG, JPEG or WebP and no larger than 2 MB'; end if;
  update public.login_announcements set active=false where active;
  insert into public.login_announcements(title,description,audience,"clientIds","imageData",active,"createdBy")
  values(btrim(p_title),btrim(p_description),p_audience,coalesce(p_client_ids,'{}'),p_image_data,true,p_user) returning id into v_id;
  return v_id;
end $$;

create or replace function private.deactivate_login_announcement(p_user text,p_password text)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  if p_user<>'JIYA' or not private.is_jiya_admin(p_user,p_password) then raise exception 'Only the master admin can deactivate announcements'; end if;
  update public.login_announcements set active=false where active;
  get diagnostics v_count=row_count; return v_count;
end $$;

create or replace function private.get_login_announcement(p_client text,p_password text)
returns table(id uuid,title text,description text,"imageData" text,"activatedAt" timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.clients c where c.id=p_client and c.password=p_password) then raise exception 'Client verification failed'; end if;
  return query
  select a.id,a.title,a.description,a."imageData",a."activatedAt"
  from public.login_announcements a join public.clients c on c.id=p_client
  where a.active
    and (a.audience='everyone'
      or (a.audience='investors' and c."accountType"='investor')
      or (a.audience='clients' and coalesce(c."accountType",'trading') in('trading','hybrid'))
      or (a.audience='custom' and c.id=any(a."clientIds")))
    and not exists(select 1 from public.login_announcement_receipts r where r."announcementId"=a.id and r."clientId"=p_client)
  order by a."activatedAt" desc limit 1;
end $$;

create or replace function private.acknowledge_login_announcement(p_client text,p_password text,p_announcement uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.clients c where c.id=p_client and c.password=p_password) then raise exception 'Client verification failed'; end if;
  if not exists(select 1 from private.get_login_announcement(p_client,p_password) a where a.id=p_announcement) then return false; end if;
  insert into public.login_announcement_receipts("announcementId","clientId") values(p_announcement,p_client) on conflict do nothing;
  return true;
end $$;

create or replace function public.get_admin_login_announcement(p_user text,p_password text) returns table(id uuid,title text,description text,audience text,"clientIds" text[],"imageData" text,active boolean,"activatedAt" timestamptz,"recipientCount" bigint,"seenCount" bigint) language sql security invoker set search_path=pg_catalog,public as $$select * from private.get_admin_login_announcement(p_user,p_password)$$;
create or replace function public.activate_login_announcement(p_user text,p_password text,p_title text,p_description text,p_audience text,p_client_ids text[],p_image_data text default null) returns uuid language sql security invoker set search_path=pg_catalog,public as $$select private.activate_login_announcement(p_user,p_password,p_title,p_description,p_audience,p_client_ids,p_image_data)$$;
create or replace function public.deactivate_login_announcement(p_user text,p_password text) returns integer language sql security invoker set search_path=pg_catalog,public as $$select private.deactivate_login_announcement(p_user,p_password)$$;
create or replace function public.get_login_announcement(p_client text,p_password text) returns table(id uuid,title text,description text,"imageData" text,"activatedAt" timestamptz) language sql security invoker set search_path=pg_catalog,public as $$select * from private.get_login_announcement(p_client,p_password)$$;
create or replace function public.acknowledge_login_announcement(p_client text,p_password text,p_announcement uuid) returns boolean language sql security invoker set search_path=pg_catalog,public as $$select private.acknowledge_login_announcement(p_client,p_password,p_announcement)$$;

revoke all on function private.get_admin_login_announcement(text,text),private.activate_login_announcement(text,text,text,text,text,text[],text),private.deactivate_login_announcement(text,text),private.get_login_announcement(text,text),private.acknowledge_login_announcement(text,text,uuid) from public,anon,authenticated;
revoke all on function public.get_admin_login_announcement(text,text),public.activate_login_announcement(text,text,text,text,text,text[],text),public.deactivate_login_announcement(text,text),public.get_login_announcement(text,text),public.acknowledge_login_announcement(text,text,uuid) from public,authenticated;
grant usage on schema private to anon;
grant execute on function private.get_admin_login_announcement(text,text),private.activate_login_announcement(text,text,text,text,text,text[],text),private.deactivate_login_announcement(text,text),private.get_login_announcement(text,text),private.acknowledge_login_announcement(text,text,uuid) to anon;
grant execute on function public.get_admin_login_announcement(text,text),public.activate_login_announcement(text,text,text,text,text,text[],text),public.deactivate_login_announcement(text,text),public.get_login_announcement(text,text),public.acknowledge_login_announcement(text,text,uuid) to anon;
