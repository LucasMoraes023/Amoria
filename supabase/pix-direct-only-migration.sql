-- AMORIA: força Pix direto como único meio de pagamento.
-- Migração aditiva: preserva pedidos e configurações existentes.
update public.payment_settings
set data = jsonb_set(jsonb_set(coalesce(data,'{}'::jsonb),'{mp_enabled}','false'::jsonb,true),'{own_enabled}','true'::jsonb,true),
    updated_at=now()
where slot=true;

create or replace function public.admin_payment_settings_get()
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object('mp_enabled',false,'own_enabled',true,'key_type','','key','',
    'holder','','bank','','city','','display_name','','instructions','','whatsapp','')
    || coalesce((select data from public.payment_settings where slot),'{}'::jsonb)
    || jsonb_build_object('mp_enabled',false,'own_enabled',true);
end $$;

create or replace function public.admin_payment_settings_save(p jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  kt text:=lower(btrim(coalesce(p->>'key_type','')));
  k text:=btrim(coalesce(p->>'key',''));
  holder text:=btrim(coalesce(p->>'holder',''));
  city text:=btrim(coalesce(p->>'city',''));
  digits text; out jsonb;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if kt not in ('cpf','cnpj','email','phone','random') then raise exception 'Tipo de chave inválido'; end if;
  if kt='cpf' then
    k:=regexp_replace(k,'\D','','g');
    if not public._valid_cpf(k) then raise exception 'CPF inválido'; end if;
  elsif kt='cnpj' then
    k:=regexp_replace(k,'\D','','g');
    if not public._valid_cnpj(k) then raise exception 'CNPJ inválido'; end if;
  elsif kt='email' then
    k:=lower(k);
    if k !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(k)>77 then raise exception 'E-mail inválido'; end if;
  elsif kt='phone' then
    digits:=regexp_replace(k,'\D','','g');
    if digits ~ '^55\d{10,11}$' then k:='+'||digits;
    elsif digits ~ '^\d{10,11}$' then k:='+55'||digits;
    else raise exception 'Telefone inválido: informe DDD + número'; end if;
  elsif kt='random' then
    k:=lower(k);
    if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Chave aleatória inválida'; end if;
  end if;
  if holder='' or city='' then raise exception 'Informe o titular e a cidade'; end if;
  if length(holder)>60 or length(city)>40 then raise exception 'Titular ou cidade muito longos'; end if;
  out:=jsonb_build_object('mp_enabled',false,'own_enabled',true,'key_type',kt,'key',k,'holder',holder,
    'bank',left(btrim(coalesce(p->>'bank','')),60),
    'city',city,'display_name',left(btrim(coalesce(p->>'display_name','')),25),
    'instructions',left(btrim(coalesce(p->>'instructions','')),500),
    'whatsapp',left(btrim(coalesce(p->>'whatsapp','')),20));
  insert into public.payment_settings(slot,data) values(true,out)
    on conflict(slot) do update set data=excluded.data,updated_at=now();
  insert into public.admin_audit(actor,action,record_type,record_id)
    values(auth.uid(),'UPDATE','payment_settings','pix_direct');
  return out;
end $$;

revoke all on function public.admin_payment_settings_get() from public,anon;
revoke all on function public.admin_payment_settings_save(jsonb) from public,anon;
grant execute on function public.admin_payment_settings_get() to authenticated;
grant execute on function public.admin_payment_settings_save(jsonb) to authenticated;
