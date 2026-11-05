# Configuração do Supabase

Tudo é feito pelo navegador do celular: **supabase.com → seu projeto → SQL Editor**.

> Este pacote **não altera o banco sozinho**. Os arquivos `.sql` só passam a valer depois que **você** os executa no SQL Editor. A aba **Admin → Backend** mostra o que já foi aplicado.

## 1. Qual caminho seguir

**A) Seu banco já está em uso (caso normal):** rode **somente** os 3 arquivos de `supabase/migrations/`, nesta ordem:

1. `20261101_001_base_hardening.sql`
2. `20261101_002_commercial_model.sql`
3. `20261101_003_courtesy_codes.sql`

**B) Projeto novo e vazio:** rode, nesta ordem, `schema.sql`, `free-experiences-qr-addon.sql`, `video-support.sql`, `payments-pix-module.sql`, `catalog-access-module.sql`, `ai-studio-module.sql` e depois os 3 acima.

Não reexecute os arquivos antigos em banco existente (estão marcados como LEGADO no topo).

## 2. Como executar um arquivo

1. No GitHub, abra o arquivo → botão **Raw** → toque e segure → **Selecionar tudo** → **Copiar**.
2. Supabase → **SQL Editor → New query** → cole → **Run**.
3. Deve aparecer "Success". Se aparecer erro, **pare** e me envie a mensagem. A 001 recusa rodar (com explicação) se faltar algum módulo anterior; nada é alterado nesse caso.

As migrações são idempotentes: rodar de novo não duplica nem desfaz ajustes seus (preços, código AMORIA1 editado, etc.).

## 3. Conferir

Cole no SQL Editor:

```sql
select id, applied_at from public.app_migrations order by id;
select code, price_cents, active from public.products where code in ('qr_normal','qr_custom','publish_experience');
select code, kind, per_user_limit, max_uses, active from public.coupons where code = 'AMORIA1';
```

Esperado: 3 migrações; `qr_normal` ativo; `qr_custom` ativo; `publish_experience` **inativo e com preço 0**; AMORIA1 do tipo `free`, `per_user_limit = 3`.

## 4. O que as migrações fazem (sem apagar dados)

**001** — registro de migrações; tabela de limite de tentativas; o histórico de pagamentos deixa de sumir quando uma experiência ou conta é excluída; limpa `settings.billing` (preço e dados de recebimento saem da leitura pública).
**002** — produtos `qr_normal` (preço inicial **R$ 2,99**, ajuste no painel) e `qr_custom` (mantém o seu preço); publicar nunca pode ser cobrado; regras de download, histórico de downloads, cotação com limite de tentativas; **desativa** a cortesia manual e a confirmação manual de Pix.
**003** — gestão de códigos (listar, criar/editar, revogar, histórico), código **AMORIA1**, status do sistema para o painel e link público mais robusto.

Nada é apagado: pedidos, liberações, usuários e experiências existentes continuam como estão. Liberações antigas (inclusive QR personalizado já pago) continuam valendo.

## 5. Administrador principal

O painel exige o administrador principal. Se ainda não configurou: **Authentication → Users**, copie o **UUID** da sua conta e rode:

```sql
insert into public.admin_allowlist(user_id) values ('COLE-O-UUID-AQUI') on conflict do nothing;
insert into public.admin_identity(slot, user_id) values (true, 'COLE-O-UUID-AQUI')
on conflict (slot) do update set user_id = excluded.user_id, configured_at = now();
```

## 6. Ajustes recomendados em Authentication

- **Confirm email** ligado (reduz contas descartáveis, que somam 3 usos do AMORIA1 cada uma).
- Tamanho mínimo de senha 8+.
- Se houver abuso: ligue **CAPTCHA** (Authentication → Attack Protection).

## 7. Armazenamento (Storage) — limites reais

| Bucket | Aceita | Limite por arquivo |
|---|---|---|
| `photos` | somente JPEG | 2 MB |
| `amoria-videos` | MP4 ou WebM | 25 MB |
| `music` | MP3, M4A, OGG, WAV, AAC | 8 MB |

- O plano gratuito do Supabase tem limite total de armazenamento e de tamanho de arquivo; confira os valores atuais na página de preços/uso do seu projeto.
- Vídeo: use MP4 (H.264/AAC) ou WebM. Vídeos do iPhone em HEVC/.mov podem não tocar em todos os aparelhos e não são aceitos pelo bucket.
- Imagens de IA são salvas em JPEG dentro de `photos` (por isso o provedor precisa entregar JPEG; veja `VARIAVEIS-DE-AMBIENTE.md`).

## 8. Reverter

- **Código:** sempre possível (GitHub + Netlify; veja `INSTRUCOES-DE-IMPLANTACAO.md`).
- **Banco:** as mudanças são compatíveis com o código antigo e normalmente **não precisam** ser desfeitas. Antes de rodar, faça cópia: Supabase → Database → Backups (se o seu plano tiver) ou **Table Editor → Export CSV** das tabelas `payments`, `coupons`, `coupon_redemptions`, `entitlements`, `experiences`.
- Para voltar o preço do QR personalizado: **Admin → Preços e acesso**. Para pausar o AMORIA1: **Admin → Preços e acesso → Códigos**.
- Reverter as chaves estrangeiras de `payments` para "apagar junto" **não é recomendado** (reabre a falha de abuso dos códigos).
