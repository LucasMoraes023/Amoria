-- AMORIA · 2026-11-01 · 001 · Registro de migrações, limite de tentativas e integridade do histórico financeiro.
-- Idempotente (pode rodar mais de uma vez). Não apaga dados. Rode DEPOIS dos módulos antigos e ANTES da 002.

-- 0) Pré-requisito: os módulos anteriores precisam ter sido aplicados. Se faltar algo, avisa com clareza em vez de falhar no meio.
do $$
declare missing text[] := '{}'; t text;
begin
  foreach t in array array['profiles','experiences','payments','settings','admin_identity','admin_allowlist','payment_events','products','coupons','coupon_redemptions','entitlements'] loop
    if to_regclass('public.' || t) is null then missing := missing || t; end if;
  end loop;
  if cardinality(missing) > 0 then
    raise exception 'Faltam tabelas de módulos anteriores (%). Rode primeiro, nesta ordem: schema.sql, free-experiences-qr-addon.sql, video-support.sql, payments-pix-module.sql, catalog-access-module.sql, ai-studio-module.sql (veja CONFIGURACAO-SUPABASE.md).', array_to_string(missing, ', ');
  end if;
end $$;

-- 1) Registro das migrações aplicadas (o painel admin lê esta tabela para mostrar o estado REAL do banco)
create table if not exists public.app_migrations(
  id text primary key,
  description text not null default '',
  applied_at timestamptz not null default now()
);
alter table public.app_migrations enable row level security;
revoke all on public.app_migrations from anon, authenticated;

create or replace function public._mig(p_id text, p_desc text) returns void
language sql security definer set search_path=public as $$
  insert into public.app_migrations(id, description) values (p_id, p_desc) on conflict (id) do nothing $$;
revoke all on function public._mig(text,text) from public, anon, authenticated;

-- 2) Limite de tentativas (usado pela validação de códigos). Só funções internas escrevem aqui.
create table if not exists public.rate_events(
  id bigint generated always as identity primary key,
  bucket text not null,
  at timestamptz not null default now()
);
create index if not exists rate_events_bucket_at_idx on public.rate_events(bucket, at desc);
alter table public.rate_events enable row level security;
revoke all on public.rate_events from anon, authenticated;

create or replace function public._rate_count(p_bucket text, p_window interval) returns integer
language sql stable security definer set search_path=public as $$
  select count(*)::int from public.rate_events where bucket=p_bucket and at>now()-p_window $$;
create or replace function public._rate_hit(p_bucket text) returns void
language plpgsql security definer set search_path=public as $$
begin
  insert into public.rate_events(bucket) values (p_bucket);
  if random() < 0.02 then delete from public.rate_events where at < now() - interval '2 days'; end if;
end $$;
revoke all on function public._rate_count(text,interval) from public, anon, authenticated;
revoke all on function public._rate_hit(text) from public, anon, authenticated;

-- 3) O histórico financeiro NÃO pode sumir quando uma experiência ou conta é excluída.
--    (Antes: payments.experience_id/user_id eram ON DELETE CASCADE. Apagar a experiência apagava o pagamento e o
--     resgate do código, o que "devolvia" os usos do código e permitia resgatar de novo. Agora vira NULL.)
do $$
declare r record;
begin
  for r in
    select c.conname, a.attname, c.confrelid::regclass::text as ref
    from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    where c.conrelid='public.payments'::regclass and c.contype='f' and c.confdeltype='c'
      and a.attname in ('experience_id','user_id')
  loop
    execute format('alter table public.payments drop constraint %I', r.conname);
    execute format('alter table public.payments add constraint %I foreign key (%I) references %s(id) on delete set null',
      r.conname, r.attname, r.ref);
  end loop;
end $$;

-- 4) Preço NÃO fica mais em settings.billing (fonte única: public.products). Remove dados de recebimento que eram públicos.
update public.settings
set value = jsonb_build_object('price_cents', 0, 'info', 'Os preços ficam em public.products (Admin > Preços e acesso).')
where key = 'billing' and value is distinct from
  jsonb_build_object('price_cents', 0, 'info', 'Os preços ficam em public.products (Admin > Preços e acesso).');

select public._mig('20261101_001', 'Registro de migrações, limite de tentativas, histórico financeiro preservado, billing sem preços');
