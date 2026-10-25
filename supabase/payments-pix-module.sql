-- AMORIA: módulo de Pagamentos e Pix (Mercado Pago + chave Pix própria)
-- Seguro para reexecutar. Não apaga dados.

-- 1) Configuração privada de recebimento (nunca exposta ao navegador público)
create table if not exists public.payment_settings (
  slot boolean primary key default true check (slot),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.payment_settings enable row level security;
revoke all on public.payment_settings from anon, authenticated;

-- 2) Histórico de mudanças de estado dos pedidos
create table if not exists public.payment_events (
  id bigint generated always as identity primary key,
  payment_id uuid references public.payments(id) on delete set null,
  event_key text unique,
  from_status text,
  to_status text,
  source text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists payment_events_payment_idx on public.payment_events(payment_id);
create index if not exists payment_events_created_idx on public.payment_events(created_at desc);
alter table public.payment_events enable row level security;
revoke all on public.payment_events from anon, authenticated;

alter table public.payments
  add column if not exists status_detail text,
  add column if not exists confirmed_by uuid,
  add column if not exists updated_at timestamptz not null default now();
create index if not exists payments_status_created_idx on public.payments(status, created_at desc);

-- 3) Preço público: somente o valor. Dados de recebimento saem do settings público.
update public.settings
set value = jsonb_build_object('price_cents',0,'qr_custom_cents',699)
where key = 'billing';

create or replace function public.admin_save_settings(p_themes jsonb,p_billing jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  insert into public.settings(key,value) values
    ('themes',coalesce(p_themes,'{}'::jsonb)),
    ('billing',jsonb_build_object('price_cents',0,
      'qr_custom_cents',greatest(100,coalesce((p_billing->>'qr_custom_cents')::integer,699))))
  on conflict(key) do update set value=excluded.value;
end $$;

-- 4) Validadores de CPF/CNPJ (internos)
create or replace function public._valid_cpf(c text) returns boolean
language plpgsql immutable set search_path=public as $$
declare s int; r int; i int; d int[];
begin
  if c !~ '^\d{11}$' or c ~ '^(\d)\1{10}$' then return false; end if;
  for i in 1..11 loop d[i]:=substr(c,i,1)::int; end loop;
  s:=0; for i in 1..9 loop s:=s+d[i]*(11-i); end loop;
  r:=(s*10)%11; if r=10 then r:=0; end if; if r<>d[10] then return false; end if;
  s:=0; for i in 1..10 loop s:=s+d[i]*(12-i); end loop;
  r:=(s*10)%11; if r=10 then r:=0; end if;
  return r=d[11];
end $$;
create or replace function public._valid_cnpj(c text) returns boolean
language plpgsql immutable set search_path=public as $$
declare w1 int[]:=array[5,4,3,2,9,8,7,6,5,4,3,2]; w2 int[]:=array[6,5,4,3,2,9,8,7,6,5,4,3,2];
  s int; r int; i int; d int[];
begin
  if c !~ '^\d{14}$' or c ~ '^(\d)\1{13}$' then return false; end if;
  for i in 1..14 loop d[i]:=substr(c,i,1)::int; end loop;
  s:=0; for i in 1..12 loop s:=s+d[i]*w1[i]; end loop;
  r:=s%11; r:=case when r<2 then 0 else 11-r end; if r<>d[13] then return false; end if;
  s:=0; for i in 1..13 loop s:=s+d[i]*w2[i]; end loop;
  r:=s%11; r:=case when r<2 then 0 else 11-r end;
  return r=d[14];
end $$;
revoke all on function public._valid_cpf(text) from public,anon,authenticated;
revoke all on function public._valid_cnpj(text) from public,anon,authenticated;

-- 5) Configuração de recebimento (somente admin principal)
create or replace function public.admin_payment_settings_get()
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object('mp_enabled',true,'own_enabled',false,'key_type','','key','',
    'holder','','bank','','city','','display_name','','instructions','')
    || coalesce((select data from public.payment_settings where slot),'{}'::jsonb);
end $$;

create or replace function public.admin_payment_settings_save(p jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  mp boolean:=coalesce((p->>'mp_enabled')::boolean,false);
  own boolean:=coalesce((p->>'own_enabled')::boolean,false);
  kt text:=lower(btrim(coalesce(p->>'key_type','')));
  k text:=btrim(coalesce(p->>'key',''));
  holder text:=btrim(coalesce(p->>'holder',''));
  city text:=btrim(coalesce(p->>'city',''));
  digits text; out jsonb;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  if kt not in ('','cpf','cnpj','email','phone','random') then raise exception 'Tipo de chave inválido'; end if;
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
    if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Chave aleatória inválida (formato UUID)'; end if;
  else
    k:='';
  end if;
  if own then
    if kt='' or k='' then raise exception 'Informe o tipo e a chave Pix'; end if;
    if holder='' then raise exception 'Informe o nome do titular'; end if;
    if city='' then raise exception 'Informe a cidade do recebedor'; end if;
  end if;
  if length(holder)>60 or length(city)>40 then raise exception 'Nome do titular ou cidade muito longos'; end if;
  out:=jsonb_build_object('mp_enabled',mp,'own_enabled',own,'key_type',kt,'key',k,'holder',holder,
    'bank',left(btrim(coalesce(p->>'bank','')),60),'city',city,
    'display_name',left(btrim(coalesce(p->>'display_name','')),25),
    'instructions',left(btrim(coalesce(p->>'instructions','')),500));
  insert into public.payment_settings(slot,data) values(true,out)
    on conflict(slot) do update set data=excluded.data, updated_at=now();
  insert into public.admin_audit(actor,action,record_type,record_id)
    values(auth.uid(),'UPDATE','payment_settings','pix');
  return out;
end $$;

-- 6) Pedidos, transações e relatório
create or replace function public.admin_orders(p_status text default null,p_q text default null,p_from date default null,p_to date default null)
returns table(id uuid,experience_id uuid,user_email text,exp_title text,product text,amount_cents integer,
  provider text,provider_ref text,status text,status_detail text,created_at timestamptz,paid_at timestamptz,released boolean)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query
    select p.id,p.experience_id,u.email::text,e.title,
      case p.purpose when 'qr_custom' then 'QR personalizado' else 'Histórico anterior' end,
      p.amount_cents,p.provider,p.provider_ref,p.status,p.status_detail,p.created_at,p.paid_at,coalesce(e.qr_custom_paid,false)
    from public.payments p
    left join auth.users u on u.id=p.user_id
    left join public.experiences e on e.id=p.experience_id
    where (coalesce(p_status,'')='' or p.status=p_status)
      and (coalesce(p_q,'')='' or u.email ilike '%'||p_q||'%' or p.id::text ilike '%'||p_q||'%' or coalesce(p.provider_ref,'') ilike '%'||p_q||'%')
      and (p_from is null or p.created_at>=p_from::timestamptz)
      and (p_to is null or p.created_at<(p_to+1)::timestamptz)
    order by p.created_at desc limit 500;
end $$;

create or replace function public.admin_payment_events(p_limit integer default 300)
returns table(id bigint,payment_id uuid,from_status text,to_status text,source text,detail text,created_at timestamptz,provider text,amount_cents integer)
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return query
    select v.id,v.payment_id,v.from_status,v.to_status,v.source,v.detail,v.created_at,p.provider,p.amount_cents
    from public.payment_events v left join public.payments p on p.id=v.payment_id
    order by v.created_at desc limit greatest(1,least(coalesce(p_limit,300),1000));
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
  update public.experiences set qr_custom_paid=true where id=pay.experience_id;
  insert into public.payment_events(payment_id,event_key,from_status,to_status,source,detail)
    values(p_id,'manual-confirm:'||p_id,pay.status,'approved','admin','Confirmação manual autorizada pelo admin principal');
  insert into public.admin_audit(actor,action,record_type,record_id)
    values(auth.uid(),'CONFIRM_MANUAL','payments',p_id::text);
end $$;

create or replace function public.admin_cancel_manual_payment(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare pay public.payments%rowtype;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  select * into pay from public.payments where id=p_id for update;
  if not found then raise exception 'Pedido não encontrado'; end if;
  if pay.provider<>'pix_manual' or pay.status not in ('pending','in_process') then
    raise exception 'Somente pedidos manuais pendentes podem ser cancelados'; end if;
  update public.payments set status='cancelled',status_detail='Cancelado pelo administrador',updated_at=now() where id=p_id;
  insert into public.payment_events(payment_id,event_key,from_status,to_status,source,detail)
    values(p_id,'manual-cancel:'||p_id,pay.status,'cancelled','admin','Cancelado pelo admin principal');
  insert into public.admin_audit(actor,action,record_type,record_id)
    values(auth.uid(),'CANCEL_MANUAL','payments',p_id::text);
end $$;

create or replace function public.admin_payment_report(p_from date default null,p_to date default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare f timestamptz:=coalesce(p_from,(now()-interval '30 days')::date)::timestamptz;
        t timestamptz:=(coalesce(p_to,now()::date)+1)::timestamptz; r jsonb;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'orders',(select count(*) from public.payments where purpose='qr_custom' and created_at>=f and created_at<t),
    'confirmed',(select count(*) from public.payments where purpose='qr_custom' and status='approved' and paid_at>=f and paid_at<t),
    'pending',(select count(*) from public.payments where purpose='qr_custom' and status in ('pending','in_process') and created_at>=f and created_at<t),
    'rejected',(select count(*) from public.payments where purpose='qr_custom' and status in ('rejected','cancelled','expired') and created_at>=f and created_at<t),
    'refunded',(select count(*) from public.payments where purpose='qr_custom' and status in ('refunded','charged_back') and created_at>=f and created_at<t),
    'revenue_cents',(select coalesce(sum(amount_cents),0) from public.payments where purpose='qr_custom' and status='approved' and paid_at>=f and paid_at<t),
    'refunded_cents',(select coalesce(sum(amount_cents),0) from public.payments where purpose='qr_custom' and status in ('refunded','charged_back') and created_at>=f and created_at<t),
    'daily',coalesce((select jsonb_agg(jsonb_build_object('day',d.day,'sold',d.sold,'revenue_cents',d.rev) order by d.day)
        from (select (paid_at at time zone 'America/Sao_Paulo')::date as day, count(*) as sold, sum(amount_cents) as rev
              from public.payments where purpose='qr_custom' and status='approved' and paid_at>=f and paid_at<t group by 1) d),'[]'::jsonb)
  ) into r;
  return r;
end $$;

-- 7) Permissões
do $$
declare fn text;
begin
  foreach fn in array array[
    'admin_payment_settings_get()','admin_payment_settings_save(jsonb)',
    'admin_orders(text,text,date,date)','admin_payment_events(integer)',
    'admin_confirm_manual_payment(uuid)','admin_cancel_manual_payment(uuid)',
    'admin_payment_report(date,date)','admin_save_settings(jsonb,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon',fn);
    execute format('grant execute on function public.%s to authenticated',fn);
  end loop;
end $$;
