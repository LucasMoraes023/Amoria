-- AMORIA: cole tudo no Supabase (SQL Editor) e clique em Run.
create table public.profiles(
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'user' check (role in ('user','admin')),
  plan text not null default 'free' check (plan in ('free','premium')),
  blocked boolean not null default false,
  created_at timestamptz not null default now());
create table public.experiences(
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]{6,12}$'),
  title text, type text, theme text,
  priv text not null default 'public' check (priv in ('public','secret','password')),
  at timestamptz,
  content jsonb not null,
  pub text not null,
  views int not null default 0,
  last_view timestamptz,
  created_at timestamptz not null default now());
create index on public.experiences(owner, created_at desc);
create table public.experience_views(
  experience_id uuid not null references public.experiences(id) on delete cascade,
  viewed_at timestamptz not null default now());
create index on public.experience_views(experience_id, viewed_at);
alter table public.profiles enable row level security;
alter table public.experiences enable row level security;
alter table public.experience_views enable row level security;

create function public.is_admin() returns boolean language sql security definer stable set search_path=public as $$
  select exists(select 1 from public.profiles where id=auth.uid() and role='admin') $$;

create function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into public.profiles(id,name) values(new.id, coalesce(new.raw_user_meta_data->>'name','')); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create function public.limit_exp() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if (select plan from public.profiles where id=new.owner)='free'
     and (select count(*) from public.experiences where owner=new.owner)>=5 then
    raise exception 'Limite do plano gratuito: 5 experiências';
  end if;
  return new;
end $$;
create trigger t_limit before insert on public.experiences for each row execute function public.limit_exp();

create policy p_sel on public.profiles for select using (id=auth.uid() or public.is_admin());
create policy p_upd on public.profiles for update using (public.is_admin()) with check (public.is_admin());
create policy e_sel on public.experiences for select using (owner=auth.uid() or public.is_admin());
create policy e_ins on public.experiences for insert with check (owner=auth.uid() and not exists(select 1 from public.profiles where id=auth.uid() and blocked));
create policy e_upd on public.experiences for update using (owner=auth.uid()) with check (owner=auth.uid());
create policy e_del on public.experiences for delete using (owner=auth.uid() or public.is_admin());
create policy v_sel on public.experience_views for select using (exists(select 1 from public.experiences x where x.id=experience_id and (x.owner=auth.uid() or public.is_admin())));

-- Link público: só esta função entrega o conteúdo (a tabela não é pública).
-- Antes da data agendada ela devolve apenas a data: o bloqueio é real, no servidor.
create function public.get_experience(p_slug text) returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.experiences%rowtype;
begin
  select * into e from public.experiences where slug=p_slug;
  if not found or exists(select 1 from public.profiles where id=e.owner and blocked) then return null; end if;
  if e.at is not null and e.at>now() then return jsonb_build_object('at', floor(extract(epoch from e.at)*1000)); end if;
  update public.experiences set views=views+1, last_view=now() where id=e.id;
  insert into public.experience_views(experience_id) values (e.id);
  return jsonb_build_object('pub', e.pub);
end $$;
grant execute on function public.get_experience(text) to anon, authenticated;

-- Fotos: bucket público, só JPEG até 2 MB, cada usuário escreve apenas na própria pasta.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values ('photos','photos',true,2097152,array['image/jpeg']) on conflict (id) do nothing;
create policy ph_read on storage.objects for select using (bucket_id='photos');
create policy ph_ins on storage.objects for insert to authenticated with check (bucket_id='photos' and (storage.foldername(name))[1]=auth.uid()::text);
create policy ph_del on storage.objects for delete to authenticated using (bucket_id='photos' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));

-- ===== ETAPA 2 (se você já rodou a etapa 1, rode apenas daqui para baixo) =====
-- Estruturas de planos antigas são mantidas para compatibilidade, sem opções ativas.
create table public.plans(id text primary key, name text not null, max_experiences int not null, max_photos int not null, price_cents int not null default 0);
create table public.subscriptions(id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, plan_id text not null references public.plans(id), status text not null default 'active', provider text, provider_ref text, started_at timestamptz not null default now(), ends_at timestamptz);
create table public.settings(key text primary key, value jsonb not null);
insert into public.settings values ('themes','{}') on conflict do nothing;
create table public.music(id uuid primary key default gen_random_uuid(), title text not null, artist text not null default '', url text not null, active boolean not null default true, created_at timestamptz not null default now());
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.settings enable row level security;
alter table public.music enable row level security;
create policy pl_r on public.plans for select using (true);
create policy pl_w on public.plans for all using (public.is_admin()) with check (public.is_admin());
create policy st_r on public.settings for select using (true);
create policy st_w on public.settings for all using (public.is_admin()) with check (public.is_admin());
create policy mu_r on public.music for select using (active or public.is_admin());
create policy mu_w on public.music for all using (public.is_admin()) with check (public.is_admin());
create policy sb_r on public.subscriptions for select using (user_id=auth.uid() or public.is_admin());
create policy sb_w on public.subscriptions for all using (public.is_admin()) with check (public.is_admin());

-- limite de experiências agora vem da tabela plans (editável no painel ADM)
create or replace function public.limit_exp() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if (select count(*) from public.experiences where owner=new.owner) >=
     (select pl.max_experiences from public.plans pl join public.profiles pr on pr.plan=pl.id where pr.id=new.owner) then
    raise exception 'Limite do seu plano atingido';
  end if;
  return new;
end $$;

create function public.set_my_name(p_name text) returns void language sql security definer set search_path=public as $$
  update public.profiles set name=left(p_name,60) where id=auth.uid() $$;

create function public.exp_stats(p_id uuid) returns table(day date, n bigint) language sql security definer set search_path=public as $$
  select (v.viewed_at at time zone 'UTC')::date, count(*) from public.experience_views v join public.experiences e on e.id=v.experience_id
  where v.experience_id=p_id and (e.owner=auth.uid() or public.is_admin()) and v.viewed_at>now()-interval '14 days' group by 1 order by 1 $$;

create function public.admin_overview() returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object('users',(select count(*) from public.profiles),'blocked',(select count(*) from public.profiles where blocked),
    'experiences',(select count(*) from public.experiences),'views',(select coalesce(sum(views),0) from public.experiences),
    'views7',(select count(*) from public.experience_views where viewed_at>now()-interval '7 days'));
end $$;
create function public.admin_users() returns table(id uuid, email text, name text, role text, plan text, blocked boolean, created_at timestamptz, exps bigint) language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select p.id, u.email::text, p.name, p.role, p.plan, p.blocked, p.created_at, (select count(*) from public.experiences e where e.owner=p.id)
    from public.profiles p join auth.users u on u.id=p.id order by p.created_at desc;
end $$;
create function public.admin_experiences() returns table(id uuid, slug text, title text, type text, owner_email text, views int, created_at timestamptz) language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select e.id, e.slug, e.title, e.type, u.email::text, e.views, e.created_at
    from public.experiences e join auth.users u on u.id=e.owner order by e.created_at desc limit 200;
end $$;
create function public.admin_set_user(uid uuid, p_blocked boolean default null, p_plan text default null) returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.profiles set blocked=coalesce(p_blocked,blocked), plan=coalesce(p_plan,plan) where id=uid;
end $$;
create function public.admin_delete_user(uid uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if uid=auth.uid() then raise exception 'Você não pode excluir a si mesmo'; end if;
  delete from auth.users where id=uid;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values ('music','music',true,8388608,array['audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/aac','audio/webm','audio/x-m4a']) on conflict (id) do nothing;
create policy sm_read on storage.objects for select using (bucket_id='music');
create policy sm_ins on storage.objects for insert to authenticated with check (bucket_id='music' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
create policy sm_del on storage.objects for delete to authenticated using (bucket_id='music' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));

-- Para virar administrador (troque o e-mail e rode depois de criar sua conta no site):
-- update public.profiles set role='admin' where id=(select id from auth.users where email='SEU@EMAIL.COM');

-- ===== ETAPA 3: COBRANÇA PIX (se você já rodou as etapas 1 e 2, rode apenas daqui para baixo) =====
alter table public.experiences add column if not exists paid boolean not null default false, add column if not exists paid_at timestamptz, add column if not exists pay_ref text;
insert into public.settings values ('billing','{"price_cents":1490,"pix_key":"","whatsapp":""}') on conflict do nothing;
create table if not exists public.payments(id uuid primary key default gen_random_uuid(), experience_id uuid references public.experiences(id) on delete cascade, user_id uuid references auth.users(id) on delete cascade, amount_cents int not null, provider text not null default 'mercadopago', provider_ref text unique, status text not null default 'pending', created_at timestamptz not null default now(), paid_at timestamptz);
alter table public.payments enable row level security;
drop policy if exists pay_r on public.payments;
create policy pay_r on public.payments for select using (user_id=auth.uid() or public.is_admin());

-- o usuário comum nunca consegue marcar a própria experiência como paga (só o webhook e o admin)
create or replace function public.protect_paid() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op='INSERT' then new.paid:=false; new.paid_at:=null; new.pay_ref:=null;
    else new.paid:=old.paid; new.paid_at:=old.paid_at; new.pay_ref:=old.pay_ref; end if;
  end if;
  return new;
end $$;
drop trigger if exists t_paid on public.experiences;
create trigger t_paid before insert or update on public.experiences for each row execute function public.protect_paid();

-- link público: sem pagamento, o servidor não entrega o conteúdo (vale para preço > 0, exceto Premium/admin)
create or replace function public.get_experience(p_slug text) returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.experiences%rowtype; price int;
begin
  select * into e from public.experiences where slug=p_slug;
  if not found or exists(select 1 from public.profiles where id=e.owner and blocked) then return null; end if;
  select coalesce((value->>'price_cents')::int,0) into price from public.settings where key='billing';
  if coalesce(price,0)>0 and not e.paid and not exists(select 1 from public.profiles where id=e.owner and (plan='premium' or role='admin')) then
    return jsonb_build_object('unpaid',true);
  end if;
  if e.at is not null and e.at>now() then return jsonb_build_object('at', floor(extract(epoch from e.at)*1000)); end if;
  update public.experiences set views=views+1, last_view=now() where id=e.id;
  insert into public.experience_views(experience_id) values (e.id);
  return jsonb_build_object('pub', e.pub);
end $$;

create or replace function public.admin_set_paid(p_id uuid, p_paid boolean) returns void language plpgsql security definer set search_path=public as $$
declare e public.experiences%rowtype; price int;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into e from public.experiences where id=p_id;
  if not found then raise exception 'não encontrada'; end if;
  if p_paid and not e.paid then
    select coalesce((value->>'price_cents')::int,0) into price from public.settings where key='billing';
    insert into public.payments(experience_id,user_id,amount_cents,provider,provider_ref,status,paid_at) values (p_id,e.owner,coalesce(price,0),'manual','manual-'||gen_random_uuid(),'approved',now());
  end if;
  update public.experiences set paid=p_paid, paid_at=case when p_paid then now() else null end where id=p_id;
end $$;

drop function if exists public.admin_experiences();
create function public.admin_experiences() returns table(id uuid, slug text, title text, type text, owner_email text, views int, created_at timestamptz, paid boolean) language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select e.id, e.slug, e.title, e.type, u.email::text, e.views, e.created_at, e.paid
    from public.experiences e join auth.users u on u.id=e.owner order by e.created_at desc limit 200;
end $$;

create or replace function public.admin_overview() returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object('users',(select count(*) from public.profiles),'blocked',(select count(*) from public.profiles where blocked),
    'experiences',(select count(*) from public.experiences),'views',(select coalesce(sum(views),0) from public.experiences),
    'views7',(select count(*) from public.experience_views where viewed_at>now()-interval '7 days'),
    'paid',(select count(*) from public.payments where status='approved'),
    'revenue',(select coalesce(sum(amount_cents),0) from public.payments where status='approved'));
end $$;

-- ===== ETAPA 4: SÓ PAGAMENTO POR CRIAÇÃO (sem plano grátis nem premium) =====
drop trigger if exists t_limit on public.experiences;
create or replace function public.limit_exp() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger t_limit before insert on public.experiences for each row execute function public.limit_exp();
alter table public.payments add column if not exists payer_email text;
update public.settings set value=jsonb_set(value,'{price_cents}',to_jsonb(greatest(coalesce((value->>'price_cents')::int,0),100))) where key='billing';
create or replace function public.get_experience(p_slug text) returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.experiences%rowtype;
begin
  select * into e from public.experiences where slug=p_slug;
  if not found or exists(select 1 from public.profiles where id=e.owner and blocked) then return null; end if;
  if not e.paid then return jsonb_build_object('unpaid',true); end if;
  if e.at is not null and e.at>now() then return jsonb_build_object('at', floor(extract(epoch from e.at)*1000)); end if;
  update public.experiences set views=views+1, last_view=now() where id=e.id;
  insert into public.experience_views(experience_id) values (e.id);
  return jsonb_build_object('pub', e.pub);
end $$;
