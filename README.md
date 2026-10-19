# AMORIA
App de experiências românticas criado por Lucas Moraes. Frontend estático, autenticação e dados no Supabase, funções serverless no Netlify.

## Comportamento
- Criar, editar, visualizar e publicar experiências é gratuito para usuários autenticados.
- Links públicos existentes continuam abrindo sem login; experiências secretas, com senha, agendadas ou de contas bloqueadas mantêm suas proteções.
- O QR padrão é gratuito. O QR personalizado é opcional, custa inicialmente R$ 6,99 e é cobrado uma única vez.
- A foto decorativa fica fora dos módulos do QR. O gerador usa correção de erro alta e uma margem de segurança de pelo menos quatro módulos.
- Dados antigos de pagamentos, assinaturas e planos não são apagados. As assinaturas não são usadas para conceder recursos e os pagamentos antigos permanecem identificados como histórico.

## Atualizar uma instalação existente
1. Faça deploy do código atualizado no Netlify sem recriar o projeto Supabase.
2. No Supabase, abra o SQL Editor e execute uma vez `supabase/free-experiences-qr-addon.sql`. A migração é incremental: remove o limite e a exigência de pagamento para abrir declarações, desativa o efeito de planos/assinaturas, acrescenta a licença do QR personalizado e endurece RLS. Não apaga nem reescreve perfis, experiências, mídias, pagamentos, planos ou assinaturas antigas.
3. Preserve a configuração de vídeos existente. Se ainda não foi habilitada, execute uma vez `supabase/video-support.sql`.
4. Confira Authentication > URL Configuration e mantenha o domínio publicado em Site URL e Redirect URLs.
5. Em `config.js`, configure a URL do projeto e a chave `anon public` do Supabase. Essa chave é pública por projeto; nunca use a service-role key no frontend.

Não execute `schema.sql` novamente em uma instalação existente. Para uma instalação nova, execute `supabase/schema.sql` primeiro e depois a migração `free-experiences-qr-addon.sql`.

## Administrador principal
As contas que já tinham `profiles.role = 'admin'` são preservadas na allowlist; nenhuma conta é escolhida por nome ou promovida automaticamente como administrador principal. As operações críticas ficam desabilitadas até configurar explicitamente a identidade autenticada do Lucas.

1. Crie/confirme a conta AMORIA que pertence ao administrador principal.
2. No Supabase Authentication > Users, copie o UUID dessa conta e confirme a identidade por um canal confiável. Não use o nome de exibição como prova.
3. No SQL Editor, substitua `UUID-VERIFICADO` abaixo pelo UUID conferido e execute:

```sql
begin;
insert into public.admin_allowlist(user_id)
values ('UUID-VERIFICADO')
on conflict (user_id) do nothing;

update public.profiles
set role = 'admin'
where id = 'UUID-VERIFICADO';

insert into public.admin_identity(slot, user_id)
values (true, 'UUID-VERIFICADO')
on conflict (slot) do update
set user_id = excluded.user_id, configured_at = now();
commit;
```

O UUID é uma autorização manual explícita e a identidade autenticada continua sendo conferida no banco para cada ação administrativa. Usuários comuns não podem alterar `role`, `plan` ou a licença QR. A troca de administrador principal deve ser feita no SQL Editor, nunca no navegador. As demais contas admin preexistentes são mantidas, mas operações críticas e leitura administrativa de dados pessoais ficam limitadas à identidade principal.

## Pagamento do QR personalizado
Configure no painel Netlify > Site configuration > Environment variables, nos contextos de deploy que serão usados:

- `SUPABASE_URL`: URL do mesmo projeto Supabase usado em `config.js`.
- `SUPABASE_SERVICE_ROLE_KEY`: chave service-role do projeto, somente no ambiente server-side do Netlify.
- `MP_ACCESS_TOKEN`: access token do Mercado Pago. Use credencial de teste para validar sandbox e credencial de produção para cobrar de verdade.

O Netlify fornece `URL` e, em deploys de preview, `DEPLOY_PRIME_URL`. Uma dessas URLs também é necessária para registrar o webhook. Sem as três credenciais e uma URL de deploy, a função informa que o pagamento está desabilitado e o QR padrão continua gratuito.

O preço inicial fica em `settings.billing.qr_custom_cents` (699 centavos), editável por administrador principal em Admin > Configurações. O editor e a prévia continuam disponíveis quando o checkout está desabilitado; a compra fica sinalizada como temporariamente indisponível. Antes da primeira publicação, a prévia visual usa a página inicial pública do AMORIA (indicada como exemplo), nunca um slug provisório; o QR definitivo só é criado após existir um link publicado.

O backend cria uma cobrança PIX Mercado Pago idempotente e o webhook consulta a API do provedor, conferindo o status, o meio de pagamento, a referência, a moeda, o valor e a associação entre pagamento, experiência e proprietário antes de liberar o adicional. A volta do navegador à página de publicação ou o recebimento de um código PIX não confirma a compra: somente o webhook atualiza `qr_custom_paid`, protegido também pelo trigger do banco. A tabela mantém no máximo um pagamento pendente de QR personalizado por experiência. Nenhuma chave secreta fica no cliente. Configure alertas/webhooks adicionais somente se exigidos pela conta Mercado Pago; a função já envia `notification_url` para `/.netlify/functions/mp-webhook`.

## Execução e validação local
O site é estático; para testar rotas e service worker, sirva a raiz do repositório por HTTP. Login, publicação na nuvem e checkout exigem Supabase e as configurações Netlify acima. O fluxo de pagamento deve ser testado com credenciais e usuário comprador de teste do Mercado Pago; não use pagamentos reais como teste.

Não há manifesto de dependências neste repositório. `node --check` pode verificar as funções Netlify; os testes abaixo verificam o JavaScript do editor e simulam as chamadas server-side. A configuração e o resultado de chamadas reais dependem das credenciais externas.

Os testes de regressão sem dependências externas podem ser executados com `node --test tests/qr-payment.test.js`. As chamadas do Supabase e do Mercado Pago nesses testes são simuladas; validar uma cobrança real/sandbox ainda exige as credenciais e contas de teste configuradas acima.

## Recursos preservados
- Autenticação por e-mail/senha, recuperação de senha, sessões Supabase e rotas públicas existentes.
- Experiências, histórico de visitas, fotos, vídeos, músicas, temas, estatísticas e contas existentes.
- Ferramenta de música e controles de usuários/experiências no painel administrativo.
- O painel não simula indicadores: métricas e pagamentos são lidos do banco. Logs operacionais de Functions permanecem no painel Netlify; tentativas de autenticação ficam nos logs do Supabase.