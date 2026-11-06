-- AMORIA: checkout combinado Publicação + QR personalizado.
-- Execute somente este arquivo no Supabase SQL Editor.

insert into public.products(code,name,description,price_cents,active,wired,lock_stage,sort)
values('publish_qr_custom','Experiência + QR Code personalizado','Publicação da experiência + QR Code personalizado em um único pagamento.',1,true,true,'publish',15)
on conflict(code) do update set name=excluded.name,description=excluded.description,active=true,wired=true,lock_stage='publish',updated_at=now();

update public.coupons set product_codes=array_append(coalesce(product_codes,'{}'::text[]),'publish_qr_custom')
where code='AMORIA1' and not ('publish_qr_custom'=any(coalesce(product_codes,'{}'::text[])));

create or replace function public.compute_quote(p_uid uuid, p_code text, p_coupon text default null, p_strict boolean default false, p_exclude uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.products; c public.coupons; base int; promo int; aft int; cdisc int:=0; cerr text;
  ccode text:=upper(btrim(coalesce(p_coupon,''))); used_total int; used_user int; applied boolean:=false;
begin
  if p_code='publish_qr_custom' then
    select * into p from public.products where code=p_code and deleted_at is null;
    if not found or not p.active or not p.wired then return jsonb_build_object('ok',false,'error','Produto indisponível no momento'); end if;
    select coalesce(sum(price_cents),0)::int into base from public.products where code in ('publish_experience','qr_custom') and deleted_at is null;
    if base<100 then return jsonb_build_object('ok',false,'error','Os preços de publicação e QR personalizado não estão configurados'); end if;
  else
    select * into p from public.products where code=p_code and deleted_at is null;
  end if;
  if not found or not p.active or not p.wired then
    return jsonb_build_object('ok',false,'error','Produto indisponível no momento'); end if;
  if p_code<>'publish_qr_custom' then base:=p.price_cents; end if;
  promo:=public._promo_discount(p,p_uid); aft:=base-promo;
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
  if o.experience_id is not null then
    if o.product_code='qr_custom' then
      update public.experiences set qr_custom_paid=true where id=o.experience_id;
    elsif o.product_code='publish_qr_custom' then
      update public.experiences set paid=true, paid_at=now(), qr_custom_paid=true where id=o.experience_id;
    elsif o.product_code='publish_experience' then
      update public.experiences
         set paid=true,
             paid_at=now(),
             qr_custom_paid=case when coalesce((content->>'qrCustom')::boolean,false) then true else qr_custom_paid end
       where id=o.experience_id;
    end if;
  end if;
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
  if o.product_code in ('qr_custom','publish_qr_custom') and o.experience_id is not null and not exists(
      select 1 from public.entitlements e where e.experience_id=o.experience_id and e.product_code='qr_custom'
        and e.revoked_at is null and (e.expires_at is null or e.expires_at>now())) then
    update public.experiences set qr_custom_paid=false where id=o.experience_id; end if;
  if o.product_code='publish_qr_custom' and o.experience_id is not null then
    update public.experiences set paid=false, paid_at=null where id=o.experience_id;
  end if;
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
  if p_code in ('qr_custom','qr_standard','publish_experience','publish_qr_custom') then
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

-- Publicar experiências nunca exige pagamento nem consome créditos.

create or replace function public.admin_products_list() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(to_jsonb(p) order by p.sort,p.created_at) from public.products p where p.deleted_at is null and p.code<>'publish_qr_custom'),'[]'::jsonb);
end $$;