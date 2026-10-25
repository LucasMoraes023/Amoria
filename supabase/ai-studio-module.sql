-- ========== AMORIA AI STUDIO: configuração, uso, cotas e custo ==========
-- Seguro para reexecutar. IA nasce DESLIGADA. Nada aqui é acessível pelo navegador (RLS sem policies + privilégios revogados).
create table if not exists public.ai_settings (
  slot boolean primary key default true check (slot),
  text_enabled boolean not null default false,
  text_model text not null default 'claude-haiku-5-5' check (text_model ~ '^[A-Za-z0-9._:-]{3,80}$'),
  max_tokens integer not null default 800 check (max_tokens between 100 and 2000),
  daily_text_limit integer not null default 20 check (daily_text_limit between 1 and 500),
  image_enabled boolean not null default false,
  image_model text not null default 'gpt-image-1' check (image_model ~ '^[A-Za-z0-9._:-]{3,80}$'),
  daily_image_limit integer not null default 3 check (daily_image_limit between 1 and 100),
  price_in_cents_per_mtok numeric check (price_in_cents_per_mtok is null or price_in_cents_per_mtok >= 0),
  price_out_cents_per_mtok numeric check (price_out_cents_per_mtok is null or price_out_cents_per_mtok >= 0),
  price_image_cents numeric check (price_image_cents is null or price_image_cents >= 0),
  monthly_budget_cents integer check (monthly_budget_cents is null or monthly_budget_cents > 0),
  updated_at timestamptz not null default now()
);
insert into public.ai_settings(slot) values (true) on conflict (slot) do nothing;
alter table public.ai_settings enable row level security;
revoke all on public.ai_settings from anon, authenticated;

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('text','image')),
  tool text not null,
  model text,
  status text not null check (status in ('pending','ok','error')),
  error text,
  input_tokens integer,
  output_tokens integer,
  cost_cents numeric,
  result_url text,
  result_path text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_usage_user_idx on public.ai_usage(user_id, created_at desc);
create index if not exists ai_usage_created_idx on public.ai_usage(created_at desc);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

create or replace function public.ai_quota(p_uid uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.ai_settings; tu int; iu int; spent numeric;
begin
  select * into s from public.ai_settings where slot;
  select count(*) filter (where kind='text'), count(*) filter (where kind='image') into tu, iu
    from public.ai_usage where user_id=p_uid and created_at>now()-interval '24 hours'
      and (status='ok' or (status='pending' and created_at>now()-interval '6 minutes'));
  select coalesce(sum(cost_cents),0) into spent from public.ai_usage where status='ok' and created_at>=date_trunc('month',now());
  return jsonb_build_object('text_enabled',s.text_enabled,'image_enabled',s.image_enabled,
    'text_limit',s.daily_text_limit,'text_used',tu,'image_limit',s.daily_image_limit,'image_used',iu,
    'budget_cents',s.monthly_budget_cents,'spent_cents',spent,
    'budget_ok',(s.monthly_budget_cents is null or spent<s.monthly_budget_cents));
end $$;

create or replace function public.ai_begin(p_uid uuid,p_kind text,p_tool text,p_model text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare q jsonb; id bigint;
begin
  if p_kind not in ('text','image') then raise exception 'Tipo inválido'; end if;
  perform pg_advisory_xact_lock(hashtext('ai:'||p_uid::text));
  q:=public.ai_quota(p_uid);
  if p_kind='text' and not (q->>'text_enabled')::boolean then return jsonb_build_object('ok',false,'reason','disabled'); end if;
  if p_kind='image' and not (q->>'image_enabled')::boolean then return jsonb_build_object('ok',false,'reason','disabled'); end if;
  if not (q->>'budget_ok')::boolean then return jsonb_build_object('ok',false,'reason','budget'); end if;
  if p_kind='text' and (q->>'text_used')::int>=(q->>'text_limit')::int then return jsonb_build_object('ok',false,'reason','limit','limit',q->'text_limit'); end if;
  if p_kind='image' and (q->>'image_used')::int>=(q->>'image_limit')::int then return jsonb_build_object('ok',false,'reason','limit','limit',q->'image_limit'); end if;
  insert into public.ai_usage(user_id,kind,tool,model,status) values(p_uid,p_kind,left(p_tool,40),left(p_model,80),'pending') returning ai_usage.id into id;
  return jsonb_build_object('ok',true,'id',id);
end $$;

create or replace function public.ai_finish(p_id bigint,p_status text,p_error text,p_in integer,p_out integer,p_url text default null,p_path text default null) returns void
language plpgsql security definer set search_path=public as $$
declare u public.ai_usage; s public.ai_settings; cost numeric;
begin
  if p_status not in ('ok','error') then raise exception 'Estado inválido'; end if;
  select * into u from public.ai_usage where id=p_id for update;
  if not found or u.status<>'pending' then return; end if;
  select * into s from public.ai_settings where slot;
  if p_status='ok' then
    if u.kind='image' then cost:=s.price_image_cents;
    elsif s.price_in_cents_per_mtok is not null and s.price_out_cents_per_mtok is not null then
      cost:=(coalesce(p_in,0)*s.price_in_cents_per_mtok+coalesce(p_out,0)*s.price_out_cents_per_mtok)/1000000.0;
    end if;
  end if;
  update public.ai_usage set status=p_status,error=left(p_error,300),input_tokens=p_in,output_tokens=p_out,cost_cents=cost,
    result_url=p_url,result_path=p_path,finished_at=now() where id=p_id;
end $$;

create or replace function public.admin_ai_settings_get() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  return (select to_jsonb(s)-'slot' from public.ai_settings s where slot);
end $$;

create or replace function public.admin_ai_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.ai_settings; mb int;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  mb:=nullif(p->>'monthly_budget_cents','')::int;
  update public.ai_settings set
    text_enabled=coalesce((p->>'text_enabled')::boolean,false),
    text_model=btrim(coalesce(nullif(p->>'text_model',''),'claude-haiku-5-5')),
    max_tokens=coalesce(nullif(p->>'max_tokens','')::int,800),
    daily_text_limit=coalesce(nullif(p->>'daily_text_limit','')::int,20),
    image_enabled=coalesce((p->>'image_enabled')::boolean,false),
    image_model=btrim(coalesce(nullif(p->>'image_model',''),'gpt-image-1')),
    daily_image_limit=coalesce(nullif(p->>'daily_image_limit','')::int,3),
    price_in_cents_per_mtok=nullif(p->>'price_in_cents_per_mtok','')::numeric,
    price_out_cents_per_mtok=nullif(p->>'price_out_cents_per_mtok','')::numeric,
    price_image_cents=nullif(p->>'price_image_cents','')::numeric,
    monthly_budget_cents=mb,updated_at=now()
  where slot returning * into s;
  insert into public.admin_audit(actor,action,record_type,record_id,detail)
    values(auth.uid(),'UPDATE','ai_settings','ai',format('texto=%s modelo=%s; imagens=%s modelo=%s; limites %s/%s por dia; orçamento=%s',s.text_enabled,s.text_model,s.image_enabled,s.image_model,s.daily_text_limit,s.daily_image_limit,coalesce(s.monthly_budget_cents::text,'sem teto')));
  return to_jsonb(s)-'slot';
exception when check_violation then raise exception 'Valor fora do permitido (modelo, limites, tokens ou preços)';
end $$;

create or replace function public.admin_ai_report(p_from date default null,p_to date default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare f timestamptz:=coalesce(p_from,(now()-interval '30 days')::date)::timestamptz; t timestamptz:=(coalesce(p_to,now()::date)+1)::timestamptz; r jsonb; q jsonb;
begin
  if not public.is_primary_admin() then raise exception 'forbidden'; end if;
  q:=public.ai_quota(null);
  select jsonb_build_object(
    'calls_ok',(select count(*) from public.ai_usage where status='ok' and created_at>=f and created_at<t),
    'calls_error',(select count(*) from public.ai_usage where status='error' and created_at>=f and created_at<t),
    'users',(select count(distinct user_id) from public.ai_usage where created_at>=f and created_at<t),
    'input_tokens',(select coalesce(sum(input_tokens),0) from public.ai_usage where status='ok' and created_at>=f and created_at<t),
    'output_tokens',(select coalesce(sum(output_tokens),0) from public.ai_usage where status='ok' and created_at>=f and created_at<t),
    'cost_cents',(select sum(cost_cents) from public.ai_usage where status='ok' and created_at>=f and created_at<t),
    'cost_unknown_calls',(select count(*) from public.ai_usage where status='ok' and cost_cents is null and created_at>=f and created_at<t),
    'budget_cents',q->'budget_cents','spent_month_cents',q->'spent_cents',
    'by_tool',coalesce((select jsonb_agg(x order by (x->>'calls')::int desc) from (
        select jsonb_build_object('tool',tool,'kind',kind,'calls',count(*),'errors',count(*) filter (where status='error'),'cost_cents',sum(cost_cents)) x
        from public.ai_usage where created_at>=f and created_at<t and status<>'pending' group by tool,kind) b),'[]'::jsonb),
    'recent_errors',coalesce((select jsonb_agg(jsonb_build_object('at',created_at,'tool',tool,'model',model,'error',error) order by created_at desc) from (
        select * from public.ai_usage where status='error' order by created_at desc limit 15) e),'[]'::jsonb)
  ) into r;
  return r;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array['ai_quota(uuid)','ai_begin(uuid,text,text,text)','ai_finish(bigint,text,text,integer,integer,text,text)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',fn);
    execute format('grant execute on function public.%s to service_role',fn);
  end loop;
  foreach fn in array array['admin_ai_settings_get()','admin_ai_settings_save(jsonb)','admin_ai_report(date,date)'] loop
    execute format('revoke all on function public.%s from public,anon',fn);
    execute format('grant execute on function public.%s to authenticated',fn);
  end loop;
end $$;
