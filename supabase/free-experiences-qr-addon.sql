-- Incremental migration: free experiences and an optional one-time QR addon.
-- Existing experiences, payments, subscriptions, and plans are preserved.

alter table public.experiences
  add column if not exists paid boolean not null default false,
  add column if not exists paid_at timestamptz,
  add column if not exists pay_ref text;
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid references public.experiences(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  amount_cents integer not null,
  provider text not null default 'mercadopago',
  provider_ref text unique,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
alter table public.payments enable row level security;

alter table public.experiences
  add column if not exists qr_custom_paid boolean not null default false;
update public.experiences
set qr_custom_paid=true
where coalesce(content->>'qrCustom','false')='true'
  and (paid=true or exists(
    select 1 from public.profiles p
    where p.id=experiences.owner and (p.plan='premium' or p.role='admin')
  ));

alter table public.payments add column if not exists purpose text not null default 'experience';
create index if not exists payments_experience_purpose_idx
  on public.payments(experience_id,purpose,status);
create unique index if not exists payments_one_pending_qr_idx
  on public.payments(experience_id) where purpose='qr_custom' and status='pending';

create table if not exists public.admin_allowlist (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
insert into public.admin_allowlist(user_id)
select id from public.profiles where role='admin' on conflict do nothing;

create table if not exists public.admin_identity (
  slot boolean primary key default true check(slot),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  configured_at timestamptz not null default now()
);
create table if not exists public.admin_audit (
  id bigint generated always as identity primary key,
  actor uuid, action text not null, record_type text not null, record_id text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit(created_at desc);
alter table public.admin_allowlist enable row level security;
alter table public.admin_identity enable row level security;
alter table public.admin_audit enable row level security;
revoke all on public.admin_allowlist,public.admin_identity,public.admin_audit from anon,authenticated;
grant select on public.admin_audit to authenticated;

create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path=public,auth as $$
  select exists(select 1 from public.admin_allowlist where user_id=auth.uid())
$$;
create or replace function public.is_primary_admin()
returns boolean language sql security definer stable set search_path=public,auth as $$
  select exists(select 1 from public.admin_identity where slot and user_id=auth.uid())
$$;
revoke all on function public.is_admin() from public,anon;
revoke all on function public.is_primary_admin() from public,anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_primary_admin() to authenticated;
drop policy if exists admin_audit_read on public.admin_audit;
create policy admin_audit_read on public.admin_audit for select to authenticated
  using(public.is_primary_admin());

drop policy if exists p_upd on public.profiles;
create policy p_upd on public.profiles for update to authenticated
  using(public.is_primary_admin()) with check(public.is_primary_admin());
drop policy if exists p_sel on public.profiles;
create policy p_sel on public.profiles for select to authenticated
  using(id=auth.uid() or public.is_primary_admin());
drop policy if exists e_sel on public.experiences;
create policy e_sel on public.experiences for select to authenticated
  using(owner=auth.uid() or public.is_primary_admin());
drop policy if exists e_del on public.experiences;
create policy e_del on public.experiences for delete to authenticated
  using(owner=auth.uid() or public.is_primary_admin());
drop policy if exists v_sel on public.experience_views;
create policy v_sel on public.experience_views for select to authenticated
  using(exists(select 1 from public.experiences x where x.id=experience_id and (x.owner=auth.uid() or public.is_primary_admin())));
drop policy if exists pay_r on public.payments;
create policy pay_r on public.payments for select to authenticated
  using(user_id=auth.uid() or public.is_primary_admin());
drop policy if exists mu_r on public.music;
create policy mu_r on public.music for select to authenticated
  using(active or public.is_primary_admin());
drop policy if exists sb_r on public.subscriptions;
create policy sb_r on public.subscriptions for select to authenticated
  using(user_id=auth.uid() or public.is_primary_admin());
drop policy if exists sb_w on public.subscriptions;
create policy sb_w on public.subscriptions for all to authenticated
  using(public.is_primary_admin()) with check(public.is_primary_admin());
drop policy if exists ph_del on storage.objects;
create policy ph_del on storage.objects for delete to authenticated
  using(bucket_id='photos' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_primary_admin()));
drop policy if exists sm_del on storage.objects;
create policy sm_del on storage.objects for delete to authenticated
  using(bucket_id='music' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_primary_admin()));
drop policy if exists sm_ins on storage.objects;
create policy sm_ins on storage.objects for insert to authenticated
  with check(bucket_id='music' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_primary_admin()));
drop policy if exists amoria_video_delete on storage.objects;
create policy amoria_video_delete on storage.objects for delete to authenticated
  using(bucket_id='amoria-videos' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_primary_admin()));

create or replace function public.prevent_profile_role_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is not null and new.role is distinct from old.role then
    raise exception 'A função do perfil não pode ser alterada pelo cliente';
  end if;
  if auth.uid() is not null and new.plan is distinct from old.plan then
    raise exception 'Planos não podem ser alterados pelo cliente';
  end if;
  return new;
end $$;
drop trigger if exists protect_profile_role on public.profiles;
create trigger protect_profile_role before update on public.profiles
  for each row execute function public.prevent_profile_role_change();

create or replace function public.prevent_paid_flags_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is not null and not public.is_primary_admin() then
    if tg_op='INSERT' then
      new.paid:=false; new.paid_at:=null; new.pay_ref:=null; new.qr_custom_paid:=false;
    else
      new.paid:=old.paid; new.paid_at:=old.paid_at; new.pay_ref:=old.pay_ref;
      new.qr_custom_paid:=old.qr_custom_paid;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_paid on public.experiences;
drop trigger if exists protect_qr_custom_paid on public.experiences;
create trigger protect_qr_custom_paid before insert or update on public.experiences
  for each row execute function public.prevent_paid_flags_change();

drop trigger if exists t_limit on public.experiences;
create or replace function public.limit_exp()
returns trigger language plpgsql security definer set search_path=public as $$
begin return new; end $$;
create trigger t_limit before insert on public.experiences
  for each row execute function public.limit_exp();

create or replace function public.get_experience(p_slug text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.experiences%rowtype; payload jsonb; public_content text;
begin
  select * into e from public.experiences where slug=p_slug;
  if not found or exists(select 1 from public.profiles where id=e.owner and blocked) then return null; end if;
  if e.at is not null and e.at>now() then
    return jsonb_build_object('at',floor(extract(epoch from e.at)*1000));
  end if;
  public_content:=e.pub;
  if not e.qr_custom_paid and e.pub like 'P.%' then
    payload:=convert_from(decode(
      translate(substr(e.pub,3),'-_','+/')||repeat('=',(4-length(substr(e.pub,3))%4)%4),
      'base64'),'UTF8')::jsonb;
    payload:=payload-array['qrCustom','qrFg','qrBg','qrTitle','qrFooter','qrPhoto','qrFrame','qrMargin','qrSize','qrModel'];
    public_content:='P.'||regexp_replace(
      translate(regexp_replace(encode(convert_to(payload::text,'UTF8'),'base64'),E'\\s','','g'),'+/','-_'),
      '=+$','','g');
  end if;
  update public.experiences set views=views+1,last_view=now() where id=e.id;
  insert into public.experience_views(experience_id) values(e.id);
  return jsonb_build_object('pub',public_content);
end $$;
grant execute on function public.get_experience(text) to anon,authenticated;

drop policy if exists st_w on public.settings;
create policy st_w on public.settings for all to authenticated
  using(public.is_primary_admin()) with check(public.is_primary_admin());
drop policy if exists pl_w on public.plans;
create policy pl_w on public.plans for all to authenticated
  using(public.is_primary_admin()) with check(public.is_primary_admin());
drop policy if exists mu_w on public.music;
create policy mu_w on public.music for all to authenticated
  using(public.is_primary_admin()) with check(public.is_primary_admin());

insert into public.settings(key,value)
values('billing','{"price_cents":0,"qr_custom_cents":699,"pix_key":"","pix_name":"","pix_city":"","whatsapp":""}'::jsonb)
on conflict(key) do update set value=(public.settings.value-'price_cents'-'qr_custom_cents')||
  jsonb_build_object('price_cents',0,'qr_custom_cents',coalesce(public.settings.value->'qr_custom_cents','699'::jsonb));

create or replace function public.admin_qr_payments()
returns table(id uuid,experience_id uuid,amount_cents integer,provider text,provider_ref text,purpose text,status text,created_at timestamptz,paid_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query select p.id,p.experience_id,p.amount_cents,p.provider,p.provider_ref,p.purpose,p.status,p.created_at,p.paid_at
    from public.payments p order by p.created_at desc limit 500;
end $$;
create or replace function public.admin_audit_log()
returns table(id bigint,actor uuid,action text,record_type text,record_id text,created_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query select a.id,a.actor,a.action,a.record_type,a.record_id,a.created_at
    from public.admin_audit a order by a.created_at desc limit 500;
end $$;

create or replace function public.audit_admin_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare item jsonb; rid text;
begin
  if public.is_primary_admin() then
    if tg_op='DELETE' then item:=to_jsonb(old); else item:=to_jsonb(new); end if;
    rid:=coalesce(item->>'id',item->>'key',item->>'user_id');
    insert into public.admin_audit(actor,action,record_type,record_id)
      values(auth.uid(),tg_op,tg_table_name,rid);
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists audit_admin_profiles on public.profiles;
create trigger audit_admin_profiles after insert or update or delete on public.profiles
  for each row execute function public.audit_admin_change();
drop trigger if exists audit_admin_experiences on public.experiences;
create trigger audit_admin_experiences after insert or update or delete on public.experiences
  for each row execute function public.audit_admin_change();
drop trigger if exists audit_admin_settings on public.settings;
create trigger audit_admin_settings after insert or update or delete on public.settings
  for each row execute function public.audit_admin_change();
drop trigger if exists audit_admin_music on public.music;
create trigger audit_admin_music after insert or update or delete on public.music
  for each row execute function public.audit_admin_change();

create or replace function public.admin_overview()
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object('users',(select count(*) from public.profiles),
    'blocked',(select count(*) from public.profiles where blocked),
    'experiences',(select count(*) from public.experiences),
    'views',(select coalesce(sum(views),0) from public.experiences),
    'views7',(select count(*) from public.experience_views where viewed_at>now()-interval '7 days'),
    'paid',(select count(*) from public.payments where status='approved' and purpose='qr_custom'),
    'revenue',(select coalesce(sum(amount_cents),0) from public.payments where status='approved' and purpose='qr_custom'));
end $$;
create or replace function public.admin_users()
returns table(id uuid,email text,name text,role text,plan text,blocked boolean,created_at timestamptz,exps bigint)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query select p.id,u.email::text,p.name,p.role,p.plan,p.blocked,p.created_at,
    (select count(*) from public.experiences e where e.owner=p.id)
    from public.profiles p join auth.users u on u.id=p.id order by p.created_at desc;
end $$;
create or replace function public.admin_experiences()
returns table(id uuid,slug text,title text,type text,owner_email text,views int,created_at timestamptz,paid boolean)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query select e.id,e.slug,e.title,e.type,u.email::text,e.views,e.created_at,e.qr_custom_paid
    from public.experiences e join auth.users u on u.id=e.owner order by e.created_at desc limit 200;
end $$;
create or replace function public.admin_set_user(uid uuid,p_blocked boolean default null,p_plan text default null)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  update public.profiles set blocked=coalesce(p_blocked,blocked) where id=uid;
end $$;
create or replace function public.admin_delete_user(uid uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if uid=auth.uid() then raise exception 'Você não pode excluir a si mesmo'; end if;
  delete from auth.users where id=uid;
end $$;
create or replace function public.admin_set_paid(p_id uuid,p_paid boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if p_paid and not exists(select 1 from public.payments where experience_id=p_id and purpose='qr_custom' and status='approved') then
    raise exception 'Pagamento do QR personalizado não confirmado';
  end if;
  update public.experiences set qr_custom_paid=p_paid where id=p_id;
  if not found then raise exception 'não encontrada'; end if;
end $$;
create or replace function public.admin_save_settings(p_themes jsonb,p_billing jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  insert into public.settings(key,value) values
    ('themes',coalesce(p_themes,'{}'::jsonb)),
    ('billing',jsonb_build_object('price_cents',0,
      'qr_custom_cents',greatest(100,coalesce((p_billing->>'qr_custom_cents')::integer,699)),
      'pix_key',coalesce(p_billing->>'pix_key',''),'pix_name',coalesce(p_billing->>'pix_name',''),
      'pix_city',coalesce(p_billing->>'pix_city',''),'whatsapp',coalesce(p_billing->>'whatsapp','')))
  on conflict(key) do update set value=excluded.value;
end $$;
create or replace function public.exp_stats(p_id uuid)
returns table(day date,n bigint) language sql security definer stable set search_path=public as $$
  select (v.viewed_at at time zone 'UTC')::date,count(*) from public.experience_views v
  join public.experiences e on e.id=v.experience_id
  where v.experience_id=p_id and (e.owner=auth.uid() or public.is_primary_admin())
    and v.viewed_at>now()-interval '14 days' group by 1 order by 1
$$;

revoke all on function public.admin_qr_payments() from public,anon;
revoke all on function public.admin_audit_log() from public,anon;
revoke all on function public.admin_save_settings(jsonb,jsonb) from public,anon;
grant execute on function public.admin_qr_payments() to authenticated;
grant execute on function public.admin_audit_log() to authenticated;
grant execute on function public.admin_save_settings(jsonb,jsonb) to authenticated;

-- After verifying Lucas Moraes' authenticated account UUID, run manually:
-- insert into public.admin_identity(slot,user_id)
-- values(true,'VERIFIED-AUTH-USER-UUID')
-- on conflict(slot) do update set user_id=excluded.user_id,configured_at=now();