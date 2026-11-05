-- AMORIA · 2026-11-01 · 003 · Códigos de cortesia (única forma de cortesia), histórico, revogação, AMORIA1 e status do sistema.
-- Idempotente. Não apaga dados. Rode depois da 002.

-- 1) Lista de códigos com uso, restante e situação calculados no banco
create or replace function public.admin_coupons_list() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
    select to_jsonb(c) || jsonb_build_object(
      'uses', u.uses, 'orders_approved', u.approved, 'discount_given_cents', u.disc,
      'remaining', case when c.max_uses is null then null else greatest(c.max_uses - u.uses, 0) end,
      'status', case when c.revoked_at is not null then 'revogado'
                     when not c.active then 'inativo'
                     when c.ends_at is not null and now() > c.ends_at then 'expirado'
                     when c.starts_at is not null and now() < c.starts_at then 'agendado'
                     when c.max_uses is not null and u.uses >= c.max_uses then 'esgotado'
                     else 'ativo' end) as x
    from public.coupons c
    cross join lateral (
      select count(*) filter (where o.status in ('pending','in_process','approved')) as uses,
             count(*) filter (where o.status = 'approved') as approved,
             coalesce(sum(r.discount_cents) filter (where o.status = 'approved'), 0) as disc
      from public.coupon_redemptions r join public.payments o on o.id = r.order_id where r.coupon_id = c.id) u
    where c.deleted_at is null) t), '[]'::jsonb);
end $$;

-- 2) Criar/editar código (cortesia grátis, desconto % ou desconto fixo)
create or replace function public.admin_coupon_save(p jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare cid uuid:=nullif(p->>'id','')::uuid; cd text:=upper(btrim(coalesce(p->>'code',''))); kd text:=coalesce(p->>'kind','');
  v int:=coalesce(nullif(p->>'value','')::int,0); mu int:=nullif(p->>'max_uses','')::int; pl int:=coalesce(nullif(p->>'per_user_limit','')::int,1);
  sa timestamptz:=nullif(p->>'starts_at','')::timestamptz; ea timestamptz:=nullif(p->>'ends_at','')::timestamptz;
  prods text[]; users uuid[]; res public.coupons; cur public.coupons; unk text;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if cd !~ '^[A-Z0-9_-]{3,30}$' then raise exception 'Código inválido (3 a 30 letras, números, - ou _)'; end if;
  if kd not in ('percent','fixed','free') then raise exception 'Tipo de código inválido'; end if;
  if kd='free' then v:=0;
  elsif kd='percent' and (v<1 or v>100) then raise exception 'Percentual deve ficar entre 1 e 100';
  elsif kd='fixed' and v<=0 then raise exception 'Informe o valor do desconto em centavos'; end if;
  if mu is not null and mu<=0 then raise exception 'Limite total de usos inválido'; end if;
  if pl<=0 then raise exception 'Limite por pessoa inválido'; end if;
  if sa is not null and ea is not null and ea<=sa then raise exception 'A validade deve terminar depois de começar'; end if;
  select array_agg(x) into prods from jsonb_array_elements_text(coalesce(p->'product_codes','[]'::jsonb)) x;
  if kd='free' and (prods is null or cardinality(prods)=0) then raise exception 'Escolha ao menos um produto permitido para o código de cortesia'; end if;
  if prods is not null then
    select string_agg(x,', ') into unk from unnest(prods) x where not exists(select 1 from public.products where code=x and deleted_at is null);
    if unk is not null then raise exception 'Produto desconhecido: %',unk; end if;
  end if;
  select array_agg(x::uuid) into users from jsonb_array_elements_text(coalesce(p->'allowed_user_ids','[]'::jsonb)) x;
  if cid is null then
    insert into public.coupons(code,kind,value,product_codes,max_uses,per_user_limit,starts_at,ends_at,allowed_user_ids,active,note)
      values(cd,kd,v,prods,mu,pl,sa,ea,users,coalesce((p->>'active')::boolean,true),left(coalesce(p->>'note',''),300)) returning * into res;
  else
    select * into cur from public.coupons where id=cid and deleted_at is null;
    if not found then raise exception 'Código não encontrado'; end if;
    if cur.revoked_at is not null then raise exception 'Código revogado não pode ser editado. Crie um novo código.'; end if;
    update public.coupons set code=cd,kind=kd,value=v,product_codes=prods,max_uses=mu,per_user_limit=pl,starts_at=sa,ends_at=ea,
      allowed_user_ids=users,active=coalesce((p->>'active')::boolean,true),note=left(coalesce(p->>'note',''),300)
      where id=cid returning * into res;
  end if;
  insert into public.admin_audit(actor,action,record_type,record_id,detail)
    values(auth.uid(),case when cid is null then 'CREATE' else 'UPDATE' end,'coupons',res.code,
      format('%s %s; ativo=%s; máx=%s; por pessoa=%s',kd,v,res.active,coalesce(mu::text,'sem limite'),pl));
  return to_jsonb(res);
exception when unique_violation then raise exception 'Já existe um código com este nome';
end $$;

-- 3) Revogar um código (definitivo). Opcionalmente cancela também as liberações já concedidas por ele.
create or replace function public.admin_coupon_revoke(p_id uuid, p_reason text, p_revoke_grants boolean default false) returns jsonb
language plpgsql security definer set search_path=public as $$
declare c public.coupons; why text:=btrim(coalesce(p_reason,'')); r record; n int:=0;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if length(why)<5 then raise exception 'Informe o motivo da revogação (mínimo 5 caracteres)'; end if;
  update public.coupons set active=false, revoked_at=coalesce(revoked_at,now()), revoked_reason=why, revoked_by=auth.uid()
    where id=p_id and deleted_at is null returning * into c;
  if not found then raise exception 'Código não encontrado'; end if;
  if p_revoke_grants then
    for r in select o.id from public.coupon_redemptions cr join public.payments o on o.id=cr.order_id
             where cr.coupon_id=c.id and o.status='approved' loop
      perform public.revoke_order(r.id, 'Código revogado: '||why);
      update public.payments set status='cancelled', status_detail='Código revogado', updated_at=now() where id=r.id;
      insert into public.payment_events(payment_id,event_key,from_status,to_status,source,detail)
        values(r.id,'coupon-revoked:'||r.id,'approved','cancelled','admin','Liberação cancelada pela revogação do código '||c.code) on conflict (event_key) do nothing;
      n:=n+1;
    end loop;
  end if;
  insert into public.admin_audit(actor,action,record_type,record_id,detail)
    values(auth.uid(),'REVOKE','coupons',c.code,format('%s; liberações canceladas: %s',why,n));
  return jsonb_build_object('revoked',true,'grants_revoked',n);
end $$;

-- 4) Histórico de utilização (quem usou qual código, para qual produto/experiência, e o estado da liberação)
create or replace function public.admin_coupon_history(p_id uuid default null)
returns table(redeemed_at timestamptz, coupon_code text, coupon_kind text, user_id uuid, user_email text, product_code text,
  experience_id uuid, experience_title text, order_id uuid, order_status text, amount_cents integer, discount_cents integer, benefit_revoked boolean)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query
    select r.created_at, c.code, c.kind, r.user_id, u.email::text, o.product_code, o.experience_id, e.title, o.id, o.status,
           o.amount_cents, r.discount_cents, coalesce(en.revoked_at is not null, false)
    from public.coupon_redemptions r
    join public.coupons c on c.id=r.coupon_id
    join public.payments o on o.id=r.order_id
    left join auth.users u on u.id=r.user_id
    left join public.experiences e on e.id=o.experience_id
    left join public.entitlements en on en.order_id=o.id
    where p_id is null or r.coupon_id=p_id
    order by r.created_at desc limit 500;
end $$;

-- 5) Código AMORIA1: 3 liberações gratuitas por usuário, QR padrão ou personalizado. Não altera se já existir.
insert into public.coupons(code,kind,value,product_codes,max_uses,per_user_limit,active,note)
values ('AMORIA1','free',0,array['qr_normal','qr_custom'],null,3,true,
        'Cortesia: 3 downloads gratuitos por usuário (QR padrão ou personalizado).')
on conflict (code) do nothing;

-- 6) Estado real do sistema (somente administrador principal): migrações, RLS, regras comerciais
create or replace function public.admin_system_status() returns jsonb
language plpgsql security definer set search_path=public as $$
declare no_rls text[]; mig jsonb;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  select coalesce(array_agg(c.relname order by c.relname), '{}') into no_rls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'applied_at',applied_at) order by id), '[]'::jsonb) into mig from public.app_migrations;
  return jsonb_build_object(
    'migrations', mig,
    'modules', jsonb_build_object(
      'free_addon', to_regclass('public.admin_identity') is not null,
      'payments', to_regclass('public.payment_events') is not null,
      'catalog', to_regclass('public.products') is not null,
      'ai', to_regclass('public.ai_settings') is not null,
      'videos', exists(select 1 from storage.buckets where id='amoria-videos')),
    'tables_without_rls', to_jsonb(no_rls),
    'primary_admin_configured', exists(select 1 from public.admin_identity),
    'admins', (select count(*) from public.admin_allowlist),
    'publish_is_free', not exists(select 1 from public.products where code='publish_experience' and (active or price_cents>0)),
    'manual_grants_disabled', true,
    'products', (select coalesce(jsonb_agg(jsonb_build_object('code',code,'price_cents',price_cents,'active',active) order by sort),'[]'::jsonb)
                 from public.products where code in ('qr_normal','qr_custom') and deleted_at is null),
    'amoria1', (select jsonb_build_object('active', active and revoked_at is null, 'per_user_limit', per_user_limit, 'max_uses', max_uses)
                from public.coupons where code='AMORIA1' and deleted_at is null),
    'pending_orders', (select count(*) from public.payments where status in ('pending','in_process')),
    'orders_not_delivered', (select count(*) from public.payments where status='approved' and delivered_at is null));
end $$;

-- 7) Link público mais robusto: conteúdo malformado não gera erro 500 para o visitante (mesma regra de antes)
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
    begin
      payload:=convert_from(decode(
        translate(substr(e.pub,3),'-_','+/')||repeat('=',(4-length(substr(e.pub,3))%4)%4),
        'base64'),'UTF8')::jsonb;
      payload:=payload-array['qrCustom','qrFg','qrBg','qrTitle','qrFooter','qrPhoto','qrFrame','qrMargin','qrSize','qrModel'];
      public_content:='P.'||regexp_replace(
        translate(regexp_replace(encode(convert_to(payload::text,'UTF8'),'base64'),E'\\s','','g'),'+/','-_'),
        '=+$','','g');
    exception when others then
      public_content:=e.pub;
    end;
  end if;
  update public.experiences set views=views+1,last_view=now() where id=e.id;
  insert into public.experience_views(experience_id) values(e.id);
  return jsonb_build_object('pub',public_content);
end $$;
grant execute on function public.get_experience(text) to anon, authenticated;

-- 8) Permissões
do $$
declare fn text;
begin
  foreach fn in array array['admin_coupons_list()','admin_coupon_save(jsonb)','admin_coupon_revoke(uuid,text,boolean)',
      'admin_coupon_history(uuid)','admin_system_status()'] loop
    execute format('revoke all on function public.%s from public,anon',fn);
    execute format('grant execute on function public.%s to authenticated',fn);
  end loop;
end $$;

select public._mig('20261101_003', 'Códigos de cortesia: histórico, revogação, AMORIA1, status real do sistema');
