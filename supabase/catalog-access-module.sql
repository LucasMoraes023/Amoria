-- AMORIA: Catálogo de preços, cupons, cortesias, direitos de acesso e pedidos com preço congelado.
-- Seguro para reexecutar. Não apaga dados. Por padrão nada novo passa a ser cobrado.

-- ========== 1) Produtos ==========
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{3,40}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  description text not null default '' check (length(description) <= 500),
  price_cents integer not null default 0 check (price_cents between 0 and 1000000),
  active boolean not null default true,
  wired boolean not null default false,
  lock_stage text not null default 'none' check (lock_stage in ('none','create','publish','generate','export','download','link')),
  included_qty integer not null default 0 check (included_qty >= 0),
  extra_unit_cents integer check (extra_unit_cents is null or extra_unit_cents >= 0),
  limits jsonb not null default '{}'::jsonb,
  promo_percent integer check (promo_percent between 1 and 100),
  promo_fixed_cents integer check (promo_fixed_cents > 0),
  promo_starts timestamptz,
  promo_ends timestamptz,
  promo_new_users_days integer check (promo_new_users_days is null or promo_new_users_days > 0),
  sort integer not null default 100,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (promo_percent is null or promo_fixed_cents is null),
  check (promo_starts is null or promo_ends is null or promo_ends > promo_starts)
);
alter table public.products enable row level security;
drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products for select to anon, authenticated
  using (deleted_at is null and active);
revoke all on public.products from anon, authenticated;
grant select on public.products to anon, authenticated;

-- produtos já conectados ao sistema (preço do QR vem do valor atual de settings.billing)
insert into public.products(code,name,description,price_cents,active,wired,lock_stage,sort)
values ('qr_custom','QR Code personalizado','Arte personalizada para o QR Code: foto, moldura, cores e textos.',
  coalesce((select (value->>'qr_custom_cents')::int from public.settings where key='billing'),699),true,true,'download',10)
on conflict (code) do nothing;
insert into public.products(code,name,description,price_cents,active,wired,lock_stage,sort)
values ('publish_experience','Publicar experiência','Publicação da experiência com link e QR Code funcionais.',0,false,true,'publish',20)
on conflict (code) do nothing;

-- ========== 2) Cupons ==========
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{3,30}$'),
  kind text not null check (kind in ('percent','fixed','free')),
  value integer not null default 0 check (value >= 0),
  product_codes text[],
  max_uses integer check (max_uses is null or max_uses > 0),
  per_user_limit integer not null default 1 check (per_user_limit > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  allowed_user_ids uuid[],
  active boolean not null default true,
  note text not null default '' check (length(note) <= 300),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind='free' and value=0) or (kind='percent' and value between 1 and 100) or (kind='fixed' and value > 0)),
  check (starts_at is null or ends_at is null or ends_at > starts_at)
);
alter table public.coupons enable row level security;
revoke all on public.coupons from anon, authenticated;

-- ========== 3) Pedidos (payments) com preço congelado ==========
alter table public.payments
  add column if not exists product_code text,
  add column if not exists original_cents integer,
  add column if not exists discount_cents integer not null default 0,
  add column if not exists coupon_code text,
  add column if not exists coupon_id uuid,
  add column if not exists snapshot jsonb not null default '{}'::jsonb,
  add column if not exists delivered_at timestamptz;
update public.payments set product_code = case when purpose='qr_custom' then 'qr_custom' else purpose end where product_code is null;
update public.payments set original_cents = amount_cents where original_cents is null;
update public.payments p set delivered_at = coalesce(p.paid_at, now())
  where p.status='approved' and p.delivered_at is null and p.purpose='qr_custom'
    and exists(select 1 from public.experiences e where e.id=p.experience_id and e.qr_custom_paid);
create unique index if not exists payments_one_pending_order_idx
  on public.payments(user_id, product_code, coalesce(experience_id,'00000000-0000-0000-0000-000000000000'::uuid))
  where status='pending' and product_code is not null;

create table if not exists public.coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  order_id uuid not null unique references public.payments(id) on delete cascade,
  discount_cents integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists coupon_redemptions_coupon_idx on public.coupon_redemptions(coupon_id);
alter table public.coupon_redemptions enable row level security;
revoke all on public.coupon_redemptions from anon, authenticated;

-- ========== 4) Direitos de acesso (entitlements) ==========
create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_code text not null,
  experience_id uuid references public.experiences(id) on delete cascade,
  source text not null check (source in ('payment','coupon','promo','courtesy')),
  order_id uuid unique references public.payments(id) on delete set null,
  quantity integer not null default 1 check (quantity > 0),
  consumed integer not null default 0,
  granted_by uuid,
  reason text,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  check (consumed >= 0 and consumed <= quantity)
);
create index if not exists entitlements_user_product_idx on public.entitlements(user_id, product_code);
alter table public.entitlements enable row level security;
drop policy if exists ent_own_read on public.entitlements;
create policy ent_own_read on public.entitlements for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.entitlements from anon, authenticated;
grant select on public.entitlements to authenticated;

alter table public.admin_audit add column if not exists detail text;

-- ========== 5) Preço: promoção, cupom e cotação (somente servidor) ==========
create or replace function public._promo_discount(p public.products, uid uuid) returns integer
language plpgsql stable security definer set search_path=public as $$
begin
  if p.promo_starts is not null and now() < p.promo_starts then return 0; end if;
  if p.promo_ends is not null and now() > p.promo_ends then return 0; end if;
  if p.promo_new_users_days is not null and (uid is null or not exists(
      select 1 from public.profiles where id=uid and created_at > now() - make_interval(days => p.promo_new_users_days))) then
    return 0; end if;
  if p.promo_percent is not null then return floor(p.price_cents * p.promo_percent / 100.0)::int; end if;
  if p.promo_fixed_cents is not null then return least(p.promo_fixed_cents, p.price_cents); end if;
  return 0;
end $$;

drop function if exists public.compute_quote(uuid,text,text,boolean);
create or replace function public.compute_quote(p_uid uuid, p_code text, p_coupon text default null, p_strict boolean default false, p_exclude uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.products; c public.coupons; base int; promo int; aft int; cdisc int:=0; cerr text;
  ccode text:=upper(btrim(coalesce(p_coupon,''))); used_total int; used_user int; applied boolean:=false;
begin
  select * into p from public.products where code=p_code and deleted_at is null;
  if not found or not p.active or not p.wired then
    return jsonb_build_object('ok',false,'error','Produto indisponível no momento'); end if;
  base:=p.price_cents; promo:=public._promo_discount(p,p_uid); aft:=base-promo;
  if ccode<>'' then
    select * into c from public.coupons where code=ccode and deleted_at is null;
    if not found or not c.active then cerr:='Cupom inválido';
    elsif c.starts_at is not null and now()<c.starts_at then cerr:='Este cupom ainda não está válido';
    elsif c.ends_at is not null and now()>c.ends_at then cerr:='Cupom expirado';
    elsif c.product_codes is not null and not (p_code = any(c.product_codes)) then cerr:='Este cupom não vale para este produto';
    elsif c.allowed_user_ids is not null and (p_uid is null or not (p_uid = any(c.allowed_user_ids))) then cerr:='Este cupom não está disponível para a sua conta';
    else
      select count(*) into used_total from public.coupon_redemptions r join public.payments o on o.id=r.order_id
        where r.coupon_id=c.id and o.status in ('pending','in_process','approved') and r.order_id is distinct from p_exclude;
      select count(*) into used_user from public.coupon_redemptions r join public.payments o on o.id=r.order_id
        where r.coupon_id=c.id and r.user_id=p_uid and o.status in ('pending','in_process','approved') and r.order_id is distinct from p_exclude;
      if c.max_uses is not null and used_total>=c.max_uses then cerr:='Cupom esgotado';
      elsif p_uid is not null and used_user>=c.per_user_limit then cerr:='Você já utilizou este cupom';
      else
        cdisc:=case c.kind when 'free' then aft when 'percent' then floor(aft*c.value/100.0)::int else least(c.value,aft) end;
        applied:=true;
      end if;
    end if;
  end if;
  if cerr is not null and p_strict then return jsonb_build_object('ok',false,'error',cerr); end if;
  return jsonb_build_object('ok',true,'product_code',p.code,'product_name',p.name,
    'original_cents',base,'promo_discount_cents',promo,'coupon_discount_cents',cdisc,
    'discount_cents',promo+cdisc,'final_cents',aft-cdisc,'free',(aft-cdisc)=0,
    'coupon_code',case when applied then ccode end,'coupon_id',case when applied then c.id end,
    'coupon_kind',case when applied then c.kind end,'coupon_value',case when applied then c.value end,
    'coupon_error',cerr);
end $$;

-- ========== 6) Pedido e entrega (somente servidor) ==========
create or replace function public.deliver_order(p_order uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare o public.payments%rowtype;
begin
  select * into o from public.payments where id=p_order for update;
  if not found then raise exception 'Pedido não encontrado'; end if;
  if o.delivered_at is not null then return false; end if;
  if o.status<>'approved' then raise exception 'Pedido sem pagamento confirmado'; end if;
  insert into public.entitlements(user_id,product_code,experience_id,source,order_id,quantity)
    values(o.user_id,o.product_code,o.experience_id,
      case when o.provider<>'free' then 'payment' when o.coupon_id is not null then 'coupon' else 'promo' end,o.id,1)
    on conflict (order_id) do nothing;
  if o.product_code='qr_custom' and o.experience_id is not null then
    update public.experiences set qr_custom_paid=true where id=o.experience_id; end if;
  update public.payments set delivered_at=now(),updated_at=now() where id=o.id;
  insert into public.payment_events(payment_id,event_key,from_status,to_status,source,detail)
    values(o.id,'delivered:'||o.id,o.status,o.status,'system','Recurso liberado ao usuário') on conflict (event_key) do nothing;
  return true;
end $$;

create or replace function public.revoke_order(p_order uuid, p_reason text default 'Estorno') returns void
language plpgsql security definer set search_path=public as $$
declare o public.payments%rowtype;
begin
  select * into o from public.payments where id=p_order for update;
  if not found then return; end if;
  update public.entitlements set revoked_at=now(), revoked_reason=p_reason where order_id=o.id and revoked_at is null;
  if o.product_code='qr_custom' and o.experience_id is not null and not exists(
      select 1 from public.entitlements e where e.experience_id=o.experience_id and e.product_code='qr_custom'
        and e.revoked_at is null and (e.expires_at is null or e.expires_at>now())) then
    update public.experiences set qr_custom_paid=false where id=o.experience_id; end if;
end $$;

create or replace function public.create_order(p_uid uuid,p_code text,p_exp uuid,p_coupon text,p_provider text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare q jsonb; p public.products; o public.payments; fin int; free boolean; prov text;
begin
  if p_provider not in ('mercadopago','pix_manual','free') then raise exception 'Método de pagamento inválido'; end if;
  if btrim(coalesce(p_coupon,''))<>'' then
    perform 1 from public.coupons where code=upper(btrim(p_coupon)) for update;
  end if;
  q:=public.compute_quote(p_uid,p_code,p_coupon,true);
  if not (q->>'ok')::boolean then raise exception '%', q->>'error'; end if;
  select * into p from public.products where code=p_code;
  if p_code='qr_custom' then
    if p_exp is null or not exists(select 1 from public.experiences where id=p_exp and owner=p_uid) then
      raise exception 'Experiência não encontrada'; end if;
  else p_exp:=null; end if;
  fin:=(q->>'final_cents')::int; free:=(fin=0);
  if not free and p_provider='free' then raise exception 'Método de pagamento inválido'; end if;
  prov:=case when free then 'free' else p_provider end;
  insert into public.payments(experience_id,user_id,amount_cents,purpose,provider,status,paid_at,product_code,
      original_cents,discount_cents,coupon_code,coupon_id,snapshot)
    values(p_exp,p_uid,fin,p_code,prov,case when free then 'approved' else 'pending' end,case when free then now() end,p_code,
      (q->>'original_cents')::int,(q->>'discount_cents')::int,q->>'coupon_code',nullif(q->>'coupon_id','')::uuid,
      jsonb_build_object('product',jsonb_build_object('code',p.code,'name',p.name,'price_cents',p.price_cents,
        'promo_percent',p.promo_percent,'promo_fixed_cents',p.promo_fixed_cents,'promo_starts',p.promo_starts,
        'promo_ends',p.promo_ends,'lock_stage',p.lock_stage,'included_qty',p.included_qty),
        'quote',q-'coupon_id','created_at',now()))
    returning * into o;
  if nullif(q->>'coupon_id','') is not null then
    insert into public.coupon_redemptions(coupon_id,user_id,order_id,discount_cents)
      values((q->>'coupon_id')::uuid,p_uid,o.id,(q->>'coupon_discount_cents')::int); end if;
  insert into public.payment_events(payment_id,event_key,from_status,to_status,source,detail)
    values(o.id,'created:'||o.id,null,o.status,'checkout',
      case when free then 'Pedido gratuito criado e liberado' else 'Pedido criado' end) on conflict (event_key) do nothing;
  if free then perform public.deliver_order(o.id); end if;
  return jsonb_build_object('order_id',o.id,'amount_cents',fin,'free',free,'status',o.status);
end $$;

-- ========== 7) Bloqueio de publicação no servidor ==========
create or replace function public.gate_publish() returns trigger
language plpgsql security definer set search_path=public as $$
declare p public.products; cnt int; e public.entitlements%rowtype;
begin
  if auth.uid() is null or public.is_primary_admin() then return new; end if;
  select * into p from public.products where code='publish_experience' and active and deleted_at is null and lock_stage in ('publish','link');
  if not found then return new; end if;
  if p.price_cents - public._promo_discount(p,new.owner) <= 0 then return new; end if;
  select count(*) into cnt from public.experiences where owner=new.owner;
  if cnt < p.included_qty then return new; end if;
  select * into e from public.entitlements
    where user_id=new.owner and product_code='publish_experience' and revoked_at is null
      and (expires_at is null or expires_at>now()) and consumed<quantity
    order by created_at limit 1 for update;
  if not found then raise exception 'PAGAMENTO_NECESSARIO:publish_experience'; end if;
  update public.entitlements set consumed=consumed+1 where id=e.id;
  return new;
end $$;
drop trigger if exists gate_publish on public.experiences;
create trigger gate_publish before insert on public.experiences for each row execute function public.gate_publish();

-- ========== 8) Funções para o usuário ==========
create or replace function public.get_catalog() returns jsonb
language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('code',p.code,'name',p.name,'description',p.description,
    'price_cents',p.price_cents,'current_cents',greatest(0,p.price_cents-public._promo_discount(p,auth.uid())),
    'promo_active',public._promo_discount(p,auth.uid())>0,'lock_stage',p.lock_stage,'included_qty',p.included_qty) order by p.sort),'[]'::jsonb)
  from public.products p where p.deleted_at is null and p.active and p.wired
$$;

create or replace function public.quote_product(p_code text,p_coupon text default null) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare q jsonb; own uuid;
begin
  if auth.uid() is null then raise exception 'Faça login'; end if;
  select id into own from public.payments where user_id=auth.uid() and product_code=p_code and status='pending' order by created_at desc limit 1;
  q:=public.compute_quote(auth.uid(),p_code,p_coupon,false,own);
  return q-'coupon_id';
end $$;

create or replace function public.my_credit(p_code text) returns integer
language sql stable security definer set search_path=public as $$
  select coalesce(sum(quantity-consumed),0)::int from public.entitlements
  where user_id=auth.uid() and product_code=p_code and revoked_at is null and (expires_at is null or expires_at>now())
$$;

create or replace function public.my_orders()
returns table(id uuid,product_code text,product_name text,original_cents integer,discount_cents integer,amount_cents integer,
  coupon_code text,provider text,status text,delivered boolean,created_at timestamptz,paid_at timestamptz)
language sql stable security definer set search_path=public as $$
  select o.id,o.product_code,coalesce(o.snapshot->'product'->>'name',pr.name,o.product_code),coalesce(o.original_cents,o.amount_cents),
    o.discount_cents,o.amount_cents,o.coupon_code,o.provider,o.status,o.delivered_at is not null,o.created_at,o.paid_at
  from public.payments o left join public.products pr on pr.code=o.product_code
  where o.user_id=auth.uid() order by o.created_at desc limit 100
$$;

-- ========== 9) Administração: produtos ==========
create or replace function public.admin_products_list() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(to_jsonb(p) order by p.sort,p.created_at) from public.products p where p.deleted_at is null),'[]'::jsonb);
end $$;

create or replace function public.admin_product_save(p jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare cur public.products; pid uuid:=nullif(p->>'id','')::uuid; cd text:=lower(btrim(coalesce(p->>'code','')));
  nm text:=btrim(coalesce(p->>'name','')); ds text:=btrim(coalesce(p->>'description',''));
  pr int; pp int:=nullif(p->>'promo_percent','')::int; pf int:=nullif(p->>'promo_fixed_cents','')::int;
  ps timestamptz:=nullif(p->>'promo_starts','')::timestamptz; pe timestamptz:=nullif(p->>'promo_ends','')::timestamptz;
  pn int:=nullif(p->>'promo_new_users_days','')::int; st text:=coalesce(nullif(p->>'lock_stage',''),'none');
  iq int:=coalesce(nullif(p->>'included_qty','')::int,0); ex int:=nullif(p->>'extra_unit_cents','')::int;
  ac boolean:=coalesce((p->>'active')::boolean,false); so int:=coalesce(nullif(p->>'sort','')::int,100);
  lim jsonb:=coalesce(p->'limits','{}'::jsonb); detail text; res public.products;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  pr:=nullif(p->>'price_cents','')::int;
  if pr is null or pr<0 or pr>1000000 then raise exception 'Preço inválido (de R$ 0,00 a R$ 10.000,00)'; end if;
  if length(nm)<2 or length(nm)>80 then raise exception 'Informe um nome com 2 a 80 caracteres'; end if;
  if pp is not null and pf is not null then raise exception 'Use desconto percentual OU valor fixo, não os dois'; end if;
  if pp is not null and (pp<1 or pp>100) then raise exception 'Desconto percentual deve ficar entre 1 e 100'; end if;
  if pf is not null and pf<=0 then raise exception 'Desconto fixo inválido'; end if;
  if ps is not null and pe is not null and pe<=ps then raise exception 'A promoção deve terminar depois de começar'; end if;
  if iq<0 then raise exception 'Quantidade incluída inválida'; end if;
  if st not in ('none','create','publish','generate','export','download','link') then raise exception 'Etapa de bloqueio inválida'; end if;
  if pid is not null then
    select * into cur from public.products where id=pid and deleted_at is null;
    if not found then raise exception 'Produto não encontrado'; end if;
    cd:=cur.code;
  elsif cd<>'' then
    select * into cur from public.products where code=cd;
    if found and cur.deleted_at is null then raise exception 'Já existe um produto com este código'; end if;
  end if;
  if cd !~ '^[a-z0-9_]{3,40}$' then raise exception 'Código inválido (use letras minúsculas, números e _; 3 a 40 caracteres)'; end if;
  if cd='qr_custom' then st:='download'; end if;
  if cd='publish_experience' then
    if st not in ('none','publish') then raise exception 'Para publicar, as etapas permitidas são "nenhuma" ou "publicação"'; end if;
    if pr>0 and st<>'publish' then raise exception 'Para cobrar a publicação, escolha o bloqueio na etapa de publicação'; end if;
  end if;
  if cur.id is null then
    insert into public.products(code,name,description,price_cents,active,wired,lock_stage,included_qty,extra_unit_cents,limits,
        promo_percent,promo_fixed_cents,promo_starts,promo_ends,promo_new_users_days,sort)
      values(cd,nm,ds,pr,ac,false,st,iq,ex,lim,pp,pf,ps,pe,pn,so) returning * into res;
    detail:='criado: '||cd||' por '||pr||' centavos';
  else
    detail:=format('preço %s→%s centavos; ativo %s→%s',cur.price_cents,pr,cur.active,ac);
    update public.products set name=nm,description=ds,price_cents=pr,active=ac,lock_stage=st,included_qty=iq,extra_unit_cents=ex,limits=lim,
        promo_percent=pp,promo_fixed_cents=pf,promo_starts=ps,promo_ends=pe,promo_new_users_days=pn,sort=so,deleted_at=null,updated_at=now()
      where id=cur.id returning * into res;
  end if;
  if res.code='qr_custom' then
    update public.settings set value=jsonb_build_object('price_cents',0,'qr_custom_cents',greatest(100,res.price_cents)) where key='billing'; end if;
  insert into public.admin_audit(actor,action,record_type,record_id,detail) values(auth.uid(),case when cur.id is null then 'CREATE' else 'UPDATE' end,'products',res.code,detail);
  return to_jsonb(res);
end $$;

create or replace function public.admin_product_delete(p_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare cur public.products;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  select * into cur from public.products where id=p_id and deleted_at is null;
  if not found then raise exception 'Produto não encontrado'; end if;
  if cur.wired then raise exception 'Este produto está conectado a um recurso do sistema: desative-o em vez de excluir'; end if;
  update public.products set deleted_at=now(),active=false,updated_at=now() where id=p_id;
  insert into public.admin_audit(actor,action,record_type,record_id,detail) values(auth.uid(),'DELETE','products',cur.code,'exclusão lógica');
end $$;

-- ========== 10) Administração: cupons ==========
create or replace function public.admin_coupons_list() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object(
      'uses',(select count(*) from public.coupon_redemptions r join public.payments o on o.id=r.order_id where r.coupon_id=c.id and o.status in ('pending','in_process','approved')),
      'orders_approved',(select count(*) from public.coupon_redemptions r join public.payments o on o.id=r.order_id where r.coupon_id=c.id and o.status='approved'),
      'discount_given_cents',(select coalesce(sum(r.discount_cents),0) from public.coupon_redemptions r join public.payments o on o.id=r.order_id where r.coupon_id=c.id and o.status='approved'))
    order by c.created_at desc) from public.coupons c where c.deleted_at is null),'[]'::jsonb);
end $$;

create or replace function public.admin_coupon_save(p jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare cid uuid:=nullif(p->>'id','')::uuid; cd text:=upper(btrim(coalesce(p->>'code',''))); kd text:=coalesce(p->>'kind','');
  v int:=coalesce(nullif(p->>'value','')::int,0); mu int:=nullif(p->>'max_uses','')::int; pl int:=coalesce(nullif(p->>'per_user_limit','')::int,1);
  sa timestamptz:=nullif(p->>'starts_at','')::timestamptz; ea timestamptz:=nullif(p->>'ends_at','')::timestamptz;
  prods text[]; users uuid[]; res public.coupons; unk text;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if cd !~ '^[A-Z0-9_-]{3,30}$' then raise exception 'Código inválido (3 a 30 letras, números, - ou _)'; end if;
  if kd not in ('percent','fixed','free') then raise exception 'Tipo de cupom inválido'; end if;
  if kd='free' then v:=0;
  elsif kd='percent' and (v<1 or v>100) then raise exception 'Percentual deve ficar entre 1 e 100';
  elsif kd='fixed' and v<=0 then raise exception 'Informe o valor do desconto em centavos'; end if;
  if mu is not null and mu<=0 then raise exception 'Limite de usos inválido'; end if;
  if pl<=0 then raise exception 'Limite por usuário inválido'; end if;
  if sa is not null and ea is not null and ea<=sa then raise exception 'A validade deve terminar depois de começar'; end if;
  select array_agg(x) into prods from jsonb_array_elements_text(coalesce(p->'product_codes','[]'::jsonb)) x;
  if prods is not null then
    select string_agg(x,', ') into unk from unnest(prods) x where not exists(select 1 from public.products where code=x and deleted_at is null);
    if unk is not null then raise exception 'Produto desconhecido: %',unk; end if;
  end if;
  select array_agg(x::uuid) into users from jsonb_array_elements_text(coalesce(p->'allowed_user_ids','[]'::jsonb)) x;
  if cid is null then
    insert into public.coupons(code,kind,value,product_codes,max_uses,per_user_limit,starts_at,ends_at,allowed_user_ids,active,note)
      values(cd,kd,v,prods,mu,pl,sa,ea,users,coalesce((p->>'active')::boolean,true),left(coalesce(p->>'note',''),300)) returning * into res;
  else
    update public.coupons set code=cd,kind=kd,value=v,product_codes=prods,max_uses=mu,per_user_limit=pl,starts_at=sa,ends_at=ea,
      allowed_user_ids=users,active=coalesce((p->>'active')::boolean,true),note=left(coalesce(p->>'note',''),300)
      where id=cid and deleted_at is null returning * into res;
    if not found then raise exception 'Cupom não encontrado'; end if;
  end if;
  insert into public.admin_audit(actor,action,record_type,record_id,detail)
    values(auth.uid(),case when cid is null then 'CREATE' else 'UPDATE' end,'coupons',res.code,format('%s %s; ativo=%s',kd,v,res.active));
  return to_jsonb(res);
exception when unique_violation then raise exception 'Já existe um cupom com este código';
end $$;

create or replace function public.admin_coupon_delete(p_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare c public.coupons;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  update public.coupons set deleted_at=now(),active=false where id=p_id and deleted_at is null returning * into c;
  if not found then raise exception 'Cupom não encontrado'; end if;
  insert into public.admin_audit(actor,action,record_type,record_id,detail) values(auth.uid(),'DELETE','coupons',c.code,'exclusão lógica');
end $$;

-- ========== 11) Administração: cortesias e liberações ==========
create or replace function public.admin_grant_entitlement(p_user uuid,p_product text,p_experience uuid,p_reason text,p_expires timestamptz default null,p_quantity integer default 1)
returns uuid language plpgsql security definer set search_path=public as $$
declare e uuid; why text:=btrim(coalesce(p_reason,''));
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if length(why)<5 then raise exception 'Informe a justificativa da cortesia (mínimo 5 caracteres)'; end if;
  if coalesce(p_quantity,1)<1 or coalesce(p_quantity,1)>100 then raise exception 'Quantidade inválida'; end if;
  if p_expires is not null and p_expires<=now() then raise exception 'A validade deve estar no futuro'; end if;
  if not exists(select 1 from auth.users where id=p_user) then raise exception 'Usuário não encontrado'; end if;
  if not exists(select 1 from public.products where code=p_product and deleted_at is null) then raise exception 'Produto não encontrado'; end if;
  if p_product='qr_custom' then
    if p_experience is null or not exists(select 1 from public.experiences where id=p_experience and owner=p_user) then
      raise exception 'Escolha uma experiência deste usuário para liberar o QR personalizado'; end if;
  else p_experience:=null; end if;
  insert into public.entitlements(user_id,product_code,experience_id,source,quantity,granted_by,reason,expires_at)
    values(p_user,p_product,p_experience,'courtesy',coalesce(p_quantity,1),auth.uid(),why,p_expires) returning id into e;
  if p_product='qr_custom' then update public.experiences set qr_custom_paid=true where id=p_experience; end if;
  insert into public.admin_audit(actor,action,record_type,record_id,detail)
    values(auth.uid(),'GRANT','entitlements',e::text,format('cortesia %s para %s: %s',p_product,p_user,why));
  return e;
end $$;

create or replace function public.admin_revoke_entitlement(p_id uuid,p_reason text) returns void
language plpgsql security definer set search_path=public as $$
declare e public.entitlements; why text:=btrim(coalesce(p_reason,''));
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if length(why)<5 then raise exception 'Informe o motivo da revogação (mínimo 5 caracteres)'; end if;
  update public.entitlements set revoked_at=now(),revoked_reason=why where id=p_id and revoked_at is null returning * into e;
  if not found then raise exception 'Liberação não encontrada ou já revogada'; end if;
  if e.product_code='qr_custom' and e.experience_id is not null and not exists(
      select 1 from public.entitlements x where x.experience_id=e.experience_id and x.product_code='qr_custom'
        and x.revoked_at is null and (x.expires_at is null or x.expires_at>now())) then
    update public.experiences set qr_custom_paid=false where id=e.experience_id; end if;
  insert into public.admin_audit(actor,action,record_type,record_id,detail) values(auth.uid(),'REVOKE','entitlements',p_id::text,why);
end $$;

create or replace function public.admin_entitlements(p_q text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
    select jsonb_build_object('id',e.id,'user_email',u.email,'user_id',e.user_id,'product_code',e.product_code,'experience_id',e.experience_id,
      'source',e.source,'quantity',e.quantity,'consumed',e.consumed,'reason',e.reason,'granted_by_email',g.email,
      'expires_at',e.expires_at,'revoked_at',e.revoked_at,'revoked_reason',e.revoked_reason,'created_at',e.created_at) x
    from public.entitlements e left join auth.users u on u.id=e.user_id left join auth.users g on g.id=e.granted_by
    where coalesce(p_q,'')='' or u.email ilike '%'||p_q||'%' order by e.created_at desc limit 200) t),'[]'::jsonb);
end $$;

-- ========== 12) Funções existentes atualizadas ==========
create or replace function public.admin_save_settings(p_themes jsonb,p_billing jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare price int:=greatest(100,coalesce((p_billing->>'qr_custom_cents')::integer,699));
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  insert into public.settings(key,value) values
    ('themes',coalesce(p_themes,'{}'::jsonb)),
    ('billing',jsonb_build_object('price_cents',0,'qr_custom_cents',price))
  on conflict(key) do update set value=excluded.value;
  update public.products set price_cents=price,updated_at=now() where code='qr_custom' and price_cents<>price;
end $$;

drop function if exists public.admin_orders(text,text,date,date);
create function public.admin_orders(p_status text default null,p_q text default null,p_from date default null,p_to date default null)
returns table(id uuid,experience_id uuid,user_email text,exp_title text,product text,product_code text,amount_cents integer,
  original_cents integer,discount_cents integer,coupon_code text,provider text,provider_ref text,status text,status_detail text,
  created_at timestamptz,paid_at timestamptz,delivered boolean)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query
    select p.id,p.experience_id,u.email::text,e.title,coalesce(p.snapshot->'product'->>'name',pr.name,'Histórico anterior'),p.product_code,
      p.amount_cents,coalesce(p.original_cents,p.amount_cents),p.discount_cents,p.coupon_code,p.provider,p.provider_ref,p.status,p.status_detail,
      p.created_at,p.paid_at,p.delivered_at is not null
    from public.payments p
    left join auth.users u on u.id=p.user_id
    left join public.experiences e on e.id=p.experience_id
    left join public.products pr on pr.code=p.product_code
    where (coalesce(p_status,'')='' or p.status=p_status)
      and (coalesce(p_q,'')='' or u.email ilike '%'||p_q||'%' or p.id::text ilike '%'||p_q||'%' or coalesce(p.provider_ref,'') ilike '%'||p_q||'%' or coalesce(p.coupon_code,'') ilike '%'||p_q||'%')
      and (p_from is null or p.created_at>=p_from::timestamptz)
      and (p_to is null or p.created_at<(p_to+1)::timestamptz)
    order by p.created_at desc limit 500;
end $$;

create or replace function public.admin_confirm_manual_payment(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare pay public.payments%rowtype;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  select * into pay from public.payments where id=p_id for update;
  if not found then raise exception 'Pedido não encontrado'; end if;
  if pay.provider<>'pix_manual' then raise exception 'Somente pedidos de Pix por chave própria podem ser confirmados manualmente'; end if;
  if pay.status not in ('pending','in_process') then raise exception 'Este pedido não está aguardando confirmação'; end if;
  update public.payments set status='approved',paid_at=now(),confirmed_by=auth.uid(),
    status_detail='Confirmação manual do administrador',updated_at=now() where id=p_id;
  insert into public.payment_events(payment_id,event_key,from_status,to_status,source,detail)
    values(p_id,'manual-confirm:'||p_id,pay.status,'approved','admin','Confirmação manual autorizada pelo admin principal');
  perform public.deliver_order(p_id);
  insert into public.admin_audit(actor,action,record_type,record_id)
    values(auth.uid(),'CONFIRM_MANUAL','payments',p_id::text);
end $$;

drop function if exists public.admin_audit_log();
create function public.admin_audit_log()
returns table(id bigint,actor uuid,action text,record_type text,record_id text,created_at timestamptz,detail text)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query select a.id,a.actor,a.action,a.record_type,a.record_id,a.created_at,a.detail
    from public.admin_audit a order by a.created_at desc limit 500;
end $$;

create or replace function public.admin_payment_report(p_from date default null,p_to date default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare f timestamptz:=coalesce(p_from,(now()-interval '30 days')::date)::timestamptz;
        t timestamptz:=(coalesce(p_to,now()::date)+1)::timestamptz; r jsonb;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'orders',(select count(*) from public.payments where created_at>=f and created_at<t),
    'confirmed',(select count(*) from public.payments where status='approved' and provider<>'free' and paid_at>=f and paid_at<t),
    'free_orders',(select count(*) from public.payments where status='approved' and provider='free' and paid_at>=f and paid_at<t),
    'pending',(select count(*) from public.payments where status in ('pending','in_process') and created_at>=f and created_at<t),
    'rejected',(select count(*) from public.payments where status in ('rejected','cancelled','expired') and created_at>=f and created_at<t),
    'refunded',(select count(*) from public.payments where status in ('refunded','charged_back') and created_at>=f and created_at<t),
    'revenue_cents',(select coalesce(sum(amount_cents),0) from public.payments where status='approved' and provider<>'free' and paid_at>=f and paid_at<t),
    'discounts_cents',(select coalesce(sum(discount_cents),0) from public.payments where status='approved' and paid_at>=f and paid_at<t),
    'refunded_cents',(select coalesce(sum(amount_cents),0) from public.payments where status in ('refunded','charged_back') and created_at>=f and created_at<t),
    'daily',coalesce((select jsonb_agg(jsonb_build_object('day',d.day,'sold',d.sold,'revenue_cents',d.rev) order by d.day)
        from (select (paid_at at time zone 'America/Sao_Paulo')::date as day, count(*) as sold, sum(amount_cents) as rev
              from public.payments where status='approved' and provider<>'free' and paid_at>=f and paid_at<t group by 1) d),'[]'::jsonb)
  ) into r;
  return r;
end $$;

-- ========== 13) Permissões ==========
do $$
declare fn text;
begin
  foreach fn in array array['_promo_discount(public.products,uuid)','compute_quote(uuid,text,text,boolean,uuid)','deliver_order(uuid)',
      'revoke_order(uuid,text)','create_order(uuid,text,uuid,text,text)','gate_publish()'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',fn);
  end loop;
  foreach fn in array array['compute_quote(uuid,text,text,boolean,uuid)','deliver_order(uuid)','revoke_order(uuid,text)','create_order(uuid,text,uuid,text,text)'] loop
    execute format('grant execute on function public.%s to service_role',fn);
  end loop;
  foreach fn in array array['quote_product(text,text)','my_credit(text)','my_orders()','admin_products_list()','admin_product_save(jsonb)',
      'admin_product_delete(uuid)','admin_coupons_list()','admin_coupon_save(jsonb)','admin_coupon_delete(uuid)',
      'admin_grant_entitlement(uuid,text,uuid,text,timestamptz,integer)','admin_revoke_entitlement(uuid,text)','admin_entitlements(text)',
      'admin_orders(text,text,date,date)','admin_confirm_manual_payment(uuid)','admin_audit_log()','admin_payment_report(date,date)',
      'admin_save_settings(jsonb,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon',fn);
    execute format('grant execute on function public.%s to authenticated',fn);
  end loop;
  revoke all on function public.get_catalog() from public;
  grant execute on function public.get_catalog() to anon, authenticated;
end $$;

-- ========== 14) Privilégio mínimo nas tabelas (aplicado depois do módulo) ==========
-- O app só escreve direto em experiences e music; o resto passa por funções do servidor.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
revoke insert, update, delete on all tables in schema public from anon;
revoke insert, update, delete on public.payments, public.plans, public.subscriptions, public.experience_views,
  public.profiles, public.settings from authenticated;
