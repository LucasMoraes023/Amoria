-- AMORIA — correção definitiva da liberação de pedidos
-- Execute este SQL no Supabase > SQL Editor.
-- Corrige Pix manual e permite liberar novamente pedidos já confirmados.

create or replace function public.admin_confirm_manual_payment(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare pay public.payments%rowtype;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;

  select * into pay
  from public.payments
  where id=p_id
  for update;

  if not found then raise exception 'Pedido não encontrado'; end if;

  if pay.provider<>'pix_manual' then
    raise exception 'Somente pedidos de Pix por chave própria podem ser confirmados manualmente';
  end if;

  if pay.status not in ('pending','in_process') then
    raise exception 'Este pedido não está aguardando confirmação';
  end if;

  update public.payments
  set status='approved',
      paid_at=now(),
      confirmed_by=auth.uid(),
      status_detail='Confirmação manual do administrador',
      updated_at=now()
  where id=p_id;

  -- Entrega real do pedido: libera o recurso correto.
  perform public.deliver_order(p_id);

  insert into public.payment_events(payment_id,event_key,from_status,to_status,source,detail)
  values(
    p_id,
    'manual-confirm:'||p_id,
    pay.status,
    'approved',
    'admin',
    'Confirmação manual autorizada pelo admin principal'
  )
  on conflict (event_key) do nothing;

  insert into public.admin_audit(actor,action,record_type,record_id)
  values(auth.uid(),'CONFIRM_MANUAL','payments',p_id::text);
end $$;

create or replace function public.admin_release_order(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare pay public.payments%rowtype;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;

  select * into pay
  from public.payments
  where id=p_id
  for update;

  if not found then raise exception 'Pedido não encontrado'; end if;

  if pay.status<>'approved' then
    raise exception 'Somente pedidos confirmados podem ser liberados';
  end if;

  if pay.delivered_at is not null then
    return;
  end if;

  perform public.deliver_order(p_id);
end $$;

grant execute on function public.admin_confirm_manual_payment(uuid) to authenticated;
grant execute on function public.admin_release_order(uuid) to authenticated;

-- Garante que pagamento da publicação também libera o QR personalizado
-- quando a experiência foi criada com qrCustom=true.
create or replace function public.deliver_order(p_order uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare o public.payments%rowtype;
begin
  select * into o from public.payments where id=p_order for update;

  if not found then raise exception 'Pedido não encontrado'; end if;
  if o.delivered_at is not null then return false; end if;
  if o.status<>'approved' then raise exception 'Pedido sem pagamento confirmado'; end if;

  insert into public.entitlements(user_id,product_code,experience_id,source,order_id,quantity)
  values(
    o.user_id,
    o.product_code,
    o.experience_id,
    case
      when o.provider<>'free' then 'payment'
      when o.coupon_id is not null then 'coupon'
      else 'promo'
    end,
    o.id,
    1
  )
  on conflict (order_id) do nothing;

  if o.experience_id is not null then
    if o.product_code='qr_custom' then
      update public.experiences
      set qr_custom_paid=true
      where id=o.experience_id;

    elsif o.product_code='publish_experience' then
      update public.experiences
      set paid=true,
          paid_at=coalesce(paid_at,now()),
          qr_custom_paid=case
            when coalesce((content->>'qrCustom')::boolean,false)
            then true
            else qr_custom_paid
          end
      where id=o.experience_id;
    end if;
  end if;

  update public.payments
  set delivered_at=now(),
      updated_at=now()
  where id=o.id;

  insert into public.payment_events(
    payment_id,event_key,from_status,to_status,source,detail
  )
  values(
    o.id,
    'delivered:'||o.id,
    o.status,
    o.status,
    'system',
    'Recurso liberado ao usuário'
  )
  on conflict (event_key) do nothing;

  return true;
end $$;

grant execute on function public.deliver_order(uuid) to service_role;
