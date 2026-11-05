-- AMORIA · 2026-11-01 · 002 · Modelo comercial definitivo.
--   GRÁTIS: criar, editar, salvar, publicar e compartilhar o link da experiência.
--   PAGO (ou liberado por CÓDIGO): baixar o QR Code padrão (qr_normal) e o QR Code personalizado (qr_custom).
--   Fonte única de preços: public.products. Cortesia somente por código (nada de liberação manual).
-- Idempotente. Não apaga dados. Rode depois da 001.

-- 0) Colunas de revogação de códigos (usadas pela cotação abaixo)
alter table public.coupons
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_reason text,
  add column if not exists revoked_by uuid;

-- 1) Produtos: qr_normal e qr_custom vendáveis; publicar nunca é vendável
create or replace function public.products_guard() returns trigger language plpgsql as $$
begin
  if new.code = 'publish_experience' then
    new.active := false; new.price_cents := 0; new.wired := false; new.lock_stage := 'none';
    new.promo_percent := null; new.promo_fixed_cents := null;
  end if;
  if new.code in ('qr_normal','qr_custom') then new.lock_stage := 'download'; new.wired := true; end if;
  if new.active and new.lock_stage not in ('none','download') then
    raise exception 'Criar, editar, publicar e compartilhar o link são sempre gratuitos. Só o download do QR Code pode ser cobrado.';
  end if;
  return new;
end $$;
drop trigger if exists products_guard on public.products;
create trigger products_guard before insert or update on public.products
  for each row execute function public.products_guard();

insert into public.products(code,name,description,price_cents,active,wired,lock_stage,sort)
values ('qr_normal','QR Code padrão','Arquivo do QR Code da sua experiência (PNG, JPG ou PDF) para imprimir ou presentear.',299,true,true,'download',5)
on conflict (code) do nothing;
update public.products set wired=true, lock_stage='download', updated_at=now()
  where code='qr_custom' and (not wired or lock_stage<>'download');
update public.products set name=name where code='publish_experience';  -- dispara o guard e força "gratuito, inativo"

-- A antiga trava de publicação vira no-op: publicar é sempre gratuito, em qualquer configuração.
create or replace function public.gate_publish() returns trigger
language plpgsql security definer set search_path=public as $$
begin return new; end $$;

-- 2) Histórico de downloads (quem baixou, qual QR, em qual formato)
create table if not exists public.qr_downloads(
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  experience_id uuid references public.experiences(id) on delete set null,
  kind text not null check (kind in ('normal','custom')),
  format text not null check (format in ('png','jpg','pdf')),
  created_at timestamptz not null default now()
);
create index if not exists qr_downloads_user_idx on public.qr_downloads(user_id, created_at desc);
create index if not exists qr_downloads_exp_idx on public.qr_downloads(experience_id);
alter table public.qr_downloads enable row level security;
drop policy if exists qr_downloads_own_read on public.qr_downloads;
create policy qr_downloads_own_read on public.qr_downloads for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.qr_downloads from anon, authenticated;
grant select on public.qr_downloads to authenticated;

-- 3) Quem pode baixar o quê (a verdade vem do banco; o navegador só pergunta)
create or replace function public._download_access(p_uid uuid, p_exp uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare cu boolean; nr boolean;
begin
  cu := exists(select 1 from public.experiences e where e.id=p_exp and e.owner=p_uid and e.qr_custom_paid)
     or exists(select 1 from public.entitlements n where n.user_id=p_uid and n.experience_id=p_exp and n.product_code='qr_custom'
               and n.revoked_at is null and (n.expires_at is null or n.expires_at>now()));
  nr := cu or exists(select 1 from public.entitlements n where n.user_id=p_uid and n.experience_id=p_exp and n.product_code='qr_normal'
               and n.revoked_at is null and (n.expires_at is null or n.expires_at>now()));
  return jsonb_build_object('normal', nr, 'custom', cu);
end $$;

create or replace function public.my_download_access(p_exp uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if auth.uid() is null then raise exception 'Faça login'; end if;
  if not exists(select 1 from public.experiences where id=p_exp and owner=auth.uid()) then
    return jsonb_build_object('normal', false, 'custom', false); end if;
  return public._download_access(auth.uid(), p_exp);
end $$;

create or replace function public.authorize_qr_download(p_exp uuid, p_kind text, p_format text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare uid uuid := auth.uid(); acc jsonb;
begin
  if uid is null then raise exception 'Faça login'; end if;
  if p_kind not in ('normal','custom') or p_format not in ('png','jpg','pdf') then raise exception 'Pedido inválido'; end if;
  if exists(select 1 from public.profiles where id=uid and blocked) then raise exception 'Conta bloqueada'; end if;
  if not exists(select 1 from public.experiences where id=p_exp and owner=uid) then raise exception 'Experiência não encontrada'; end if;
  acc := public._download_access(uid, p_exp);
  if not (acc->>p_kind)::boolean then raise exception 'DOWNLOAD_NAO_LIBERADO'; end if;
  insert into public.qr_downloads(user_id, experience_id, kind, format) values (uid, p_exp, p_kind, p_format);
  return jsonb_build_object('ok', true);
end $$;

-- 4) Cotação (somente servidor): promoção + código, com limite de tentativas e mensagens que não vazam regras internas
create or replace function public.compute_quote(p_uid uuid, p_code text, p_coupon text default null, p_strict boolean default false, p_exclude uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.products; c public.coupons; base int; promo int; aft int; cdisc int:=0; cerr text; throttled boolean:=false;
  ccode text:=upper(btrim(coalesce(p_coupon,''))); used_total int; used_user int; applied boolean:=false;
  generic constant text:='Código inválido ou indisponível';
begin
  select * into p from public.products where code=p_code and deleted_at is null;
  if not found or not p.active or not p.wired then
    return jsonb_build_object('ok',false,'error','Produto indisponível no momento'); end if;
  base:=p.price_cents; promo:=public._promo_discount(p,p_uid); aft:=base-promo;
  if ccode<>'' then
    if p_uid is not null and (public._rate_count('coupon_fail:'||p_uid::text, interval '15 minutes')>=8
        or public._rate_count('coupon_fail:*', interval '15 minutes')>=500) then
      cerr:='Muitas tentativas com códigos inválidos. Aguarde alguns minutos e tente de novo.'; throttled:=true;
    else
      select * into c from public.coupons where code=ccode and deleted_at is null;
      if not found or not c.active or c.revoked_at is not null then cerr:=generic;
      elsif c.starts_at is not null and now()<c.starts_at then cerr:=generic;
      elsif c.ends_at is not null and now()>c.ends_at then cerr:='Código expirado';
      elsif c.product_codes is not null and not (p_code = any(c.product_codes)) then cerr:=generic;
      elsif c.allowed_user_ids is not null and (p_uid is null or not (p_uid = any(c.allowed_user_ids))) then cerr:=generic;
      else
        select count(*) into used_total from public.coupon_redemptions r join public.payments o on o.id=r.order_id
          where r.coupon_id=c.id and o.status in ('pending','in_process','approved') and r.order_id is distinct from p_exclude;
        select count(*) into used_user from public.coupon_redemptions r join public.payments o on o.id=r.order_id
          where r.coupon_id=c.id and r.user_id=p_uid and o.status in ('pending','in_process','approved') and r.order_id is distinct from p_exclude;
        if c.max_uses is not null and used_total>=c.max_uses then cerr:='Código esgotado';
        elsif p_uid is not null and used_user>=c.per_user_limit then cerr:='Você já utilizou este código o número máximo de vezes';
        else
          cdisc:=case c.kind when 'free' then aft when 'percent' then floor(aft*c.value/100.0)::int else least(c.value,aft) end;
          applied:=true;
        end if;
      end if;
    end if;
    if cerr is not null and not throttled and p_uid is not null then
      perform public._rate_hit('coupon_fail:'||p_uid::text);
      perform public._rate_hit('coupon_fail:*');
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

create or replace function public.quote_product(p_code text, p_coupon text default null) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare q jsonb; own uuid;
begin
  if auth.uid() is null then raise exception 'Faça login'; end if;
  select id into own from public.payments where user_id=auth.uid() and product_code=p_code and status='pending' order by created_at desc limit 1;
  q := public.compute_quote(auth.uid(), p_code, p_coupon, false, own);
  return q - 'coupon_id';
end $$;

-- 5) Pedido (somente servidor): serializa o resgate por código, impede cobrança em dobro e exige experiência própria
create or replace function public.create_order(p_uid uuid, p_code text, p_exp uuid, p_coupon text, p_provider text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare q jsonb; p public.products; o public.payments; fin int; free boolean; prov text; acc jsonb;
begin
  if p_provider not in ('mercadopago','free') then raise exception 'Método de pagamento inválido'; end if;
  if exists(select 1 from public.profiles where id=p_uid and blocked) then raise exception 'Conta bloqueada'; end if;
  if btrim(coalesce(p_coupon,''))<>'' then
    perform 1 from public.coupons where code=upper(btrim(p_coupon)) for update;   -- um resgate por vez por código
  end if;
  q := public.compute_quote(p_uid, p_code, p_coupon, true);
  if not (q->>'ok')::boolean then raise exception '%', q->>'error'; end if;
  select * into p from public.products where code=p_code;
  if p_code in ('qr_normal','qr_custom') then
    if p_exp is null or not exists(select 1 from public.experiences where id=p_exp and owner=p_uid) then
      raise exception 'Experiência não encontrada'; end if;
    acc := public._download_access(p_uid, p_exp);
    if (p_code='qr_custom' and (acc->>'custom')::boolean) or (p_code='qr_normal' and (acc->>'normal')::boolean) then
      raise exception 'Este QR Code já está liberado'; end if;
  else p_exp := null; end if;
  fin := (q->>'final_cents')::int; free := (fin=0);
  if not free and p_provider='free' then raise exception 'Método de pagamento inválido'; end if;
  prov := case when free then 'free' else p_provider end;
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

-- 6) Sem liberação administrativa direta: cortesia SOMENTE por código
create or replace function public.admin_grant_entitlement(p_user uuid,p_product text,p_experience uuid,p_reason text,p_expires timestamptz default null,p_quantity integer default 1)
returns uuid language plpgsql security definer set search_path=public as $$
begin raise exception 'Cortesia manual desativada. Use um código de cortesia (Admin > Códigos).'; end $$;
revoke all on function public.admin_grant_entitlement(uuid,text,uuid,text,timestamptz,integer) from public, anon, authenticated;

create or replace function public.admin_confirm_manual_payment(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin raise exception 'Confirmação manual desativada: pagamentos só são confirmados pelo Mercado Pago (webhook).'; end $$;
revoke all on function public.admin_confirm_manual_payment(uuid) from public, anon, authenticated;

create or replace function public.admin_set_paid(p_id uuid, p_paid boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if p_paid then raise exception 'Liberação manual desativada. O QR é liberado por pagamento confirmado ou por código de cortesia.'; end if;
  update public.experiences set qr_custom_paid=false where id=p_id;
  if not found then raise exception 'não encontrada'; end if;
  update public.entitlements set revoked_at=now(), revoked_reason='Revogado pelo administrador'
    where experience_id=p_id and product_code in ('qr_custom','qr_normal') and revoked_at is null;
  insert into public.admin_audit(actor,action,record_type,record_id,detail) values(auth.uid(),'REVOKE','experiences',p_id::text,'QR revogado');
end $$;

-- 7) Configurações do app: só temas (preços ficam exclusivamente em products)
create or replace function public.admin_save_settings(p_themes jsonb, p_billing jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  insert into public.settings(key,value) values ('themes',coalesce(p_themes,'{}'::jsonb))
  on conflict(key) do update set value=excluded.value;
end $$;

-- 8) Produtos (administração): sem trava de publicação e sem cópia de preço em settings
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
  if st not in ('none','download') then raise exception 'Só o download do QR Code pode ser cobrado'; end if;
  if pid is not null then
    select * into cur from public.products where id=pid and deleted_at is null;
    if not found then raise exception 'Produto não encontrado'; end if;
    cd:=cur.code;
  elsif cd<>'' then
    select * into cur from public.products where code=cd;
    if found and cur.deleted_at is null then raise exception 'Já existe um produto com este código'; end if;
  end if;
  if cd !~ '^[a-z0-9_]{3,40}$' then raise exception 'Código inválido (use letras minúsculas, números e _; 3 a 40 caracteres)'; end if;
  if cd='publish_experience' then raise exception 'Publicar a experiência é sempre gratuito'; end if;
  if cd in ('qr_normal','qr_custom') then st:='download'; end if;
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
  insert into public.admin_audit(actor,action,record_type,record_id,detail)
    values(auth.uid(),case when cur.id is null then 'CREATE' else 'UPDATE' end,'products',res.code,detail);
  return to_jsonb(res);
end $$;

-- 9) Painel: visão geral e relatório contam só dinheiro REAL (Mercado Pago); gratuitos aparecem separados
create or replace function public.admin_overview() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object('users',(select count(*) from public.profiles),
    'blocked',(select count(*) from public.profiles where blocked),
    'experiences',(select count(*) from public.experiences),
    'views',(select coalesce(sum(views),0) from public.experiences),
    'views7',(select count(*) from public.experience_views where viewed_at>now()-interval '7 days'),
    'paid',(select count(*) from public.payments where status='approved' and provider in ('mercadopago','pix_manual')),
    'revenue',(select coalesce(sum(amount_cents),0) from public.payments where status='approved' and provider in ('mercadopago','pix_manual')),
    'free_unlocks',(select count(*) from public.payments where status='approved' and provider='free'),
    'downloads',(select count(*) from public.qr_downloads),
    'codes_active',(select count(*) from public.coupons where deleted_at is null and active and revoked_at is null));
end $$;

create or replace function public.admin_payment_report(p_from date default null, p_to date default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare f timestamptz:=coalesce(p_from,(now()-interval '30 days')::date)::timestamptz;
        t timestamptz:=(coalesce(p_to,now()::date)+1)::timestamptz; r jsonb;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'orders',(select count(*) from public.payments where created_at>=f and created_at<t),
    'confirmed',(select count(*) from public.payments where status='approved' and provider in ('mercadopago','pix_manual') and paid_at>=f and paid_at<t),
    'free_orders',(select count(*) from public.payments where status='approved' and provider='free' and paid_at>=f and paid_at<t),
    'pending',(select count(*) from public.payments where status in ('pending','in_process') and created_at>=f and created_at<t),
    'rejected',(select count(*) from public.payments where status in ('rejected','cancelled','expired') and created_at>=f and created_at<t),
    'refunded',(select count(*) from public.payments where status in ('refunded','charged_back') and created_at>=f and created_at<t),
    'revenue_cents',(select coalesce(sum(amount_cents),0) from public.payments where status='approved' and provider in ('mercadopago','pix_manual') and paid_at>=f and paid_at<t),
    'discounts_cents',(select coalesce(sum(discount_cents),0) from public.payments where status='approved' and paid_at>=f and paid_at<t),
    'refunded_cents',(select coalesce(sum(amount_cents),0) from public.payments where status in ('refunded','charged_back') and created_at>=f and created_at<t),
    'downloads',(select count(*) from public.qr_downloads where created_at>=f and created_at<t),
    'daily',coalesce((select jsonb_agg(jsonb_build_object('day',d.day,'sold',d.sold,'revenue_cents',d.rev) order by d.day)
        from (select (paid_at at time zone 'America/Sao_Paulo')::date as day, count(*) as sold, sum(amount_cents) as rev
              from public.payments where status='approved' and provider in ('mercadopago','pix_manual') and paid_at>=f and paid_at<t group by 1) d),'[]'::jsonb)
  ) into r;
  return r;
end $$;

-- 10) Permissões
do $$
declare fn text;
begin
  foreach fn in array array['_download_access(uuid,uuid)','compute_quote(uuid,text,text,boolean,uuid)','create_order(uuid,text,uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',fn);
    execute format('grant execute on function public.%s to service_role',fn);
  end loop;
  foreach fn in array array['my_download_access(uuid)','authorize_qr_download(uuid,text,text)','quote_product(text,text)'] loop
    execute format('revoke all on function public.%s from public,anon',fn);
    execute format('grant execute on function public.%s to authenticated',fn);
  end loop;
  foreach fn in array array['admin_product_save(jsonb)','admin_overview()','admin_payment_report(date,date)','admin_save_settings(jsonb,jsonb)','admin_set_paid(uuid,boolean)'] loop
    execute format('revoke all on function public.%s from public,anon',fn);
    execute format('grant execute on function public.%s to authenticated',fn);
  end loop;
  revoke all on function public.products_guard() from public, anon, authenticated;
end $$;

select public._mig('20261101_002', 'Modelo comercial: criar/publicar grátis; download do QR (normal e personalizado) pago ou por código; preço só em products');
