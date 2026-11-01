# AMORIA
App de experiências românticas criado por Lucas Moraes. Frontend estático, autenticação e dados no Supabase, funções serverless no Netlify.

## Comportamento
- Criar, editar, visualizar e publicar experiências é gratuito para usuários autenticados.
- Links públicos existentes continuam abrindo sem login; experiências secretas, com senha, agendadas ou de contas bloqueadas mantêm suas proteções.
- Baixar o QR simples ou personalizado exige uma liberação avulsa por experiência. O preço inicial de cada opção é R$ 6,99; o administrador principal pode ajustar os produtos em Admin > Preços e acesso.
- O código de cortesia `AMORIA1` pode liberar até três downloads por usuário, combinando QR simples e personalizado. O código é aplicado no checkout e não concede acesso automaticamente.
- A foto decorativa fica fora dos módulos do QR. O gerador usa correção de erro alta e uma margem de segurança de pelo menos quatro módulos.
- Dados antigos de pagamentos, assinaturas e planos não são apagados. As assinaturas não são usadas para conceder recursos e os pagamentos antigos permanecem identificados como histórico.

## Atualizar uma instalação existente
1. Faça backup do banco antes de aplicar migrações.
2. No Supabase SQL Editor, execute `supabase/free-experiences-qr-addon.sql` se ainda não tiver sido aplicada.
3. Execute `supabase/payments-pix-module.sql` e, em seguida, `supabase/catalog-access-module.sql`. Os módulos são incrementais e preservam experiências e histórico; o catálogo mantém a publicação gratuita, cria os produtos de download, configura `AMORIA1` e substitui a concessão manual de cortesias pelo resgate de códigos.
4. Preserve a configuração de vídeos existente. Se ainda não foi habilitada, execute uma vez `supabase/video-support.sql`.
5. Faça deploy do código atualizado no Netlify sem recriar o projeto Supabase.
6. Confira Authentication > URL Configuration e mantenha o domínio publicado em Site URL e Redirect URLs.
7. Em `config.js`, configure a URL do projeto e a chave `anon public` do Supabase. Essa chave é pública por projeto; nunca use a service-role key no frontend.

Não execute `schema.sql` novamente em uma instalação existente. Para uma instalação nova, execute `supabase/schema.sql`, `supabase/free-experiences-qr-addon.sql`, `supabase/payments-pix-module.sql` e `supabase/catalog-access-module.sql`, nessa ordem. Execute `supabase/video-support.sql` quando o recurso de vídeo for necessário.

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

## Pagamentos e downloads de QR
Configure no painel Netlify > Site configuration > Environment variables, nos contextos de deploy que serão usados:

- `SUPABASE_URL`: URL do mesmo projeto Supabase usado em `config.js`.
- `SUPABASE_SERVICE_ROLE_KEY`: chave service-role do projeto, somente no ambiente server-side do Netlify.
- `MP_ACCESS_TOKEN`: access token do Mercado Pago.
- `MP_WEBHOOK_SECRET`: segredo de assinatura configurado para as notificações de pagamento no Mercado Pago.

O Netlify fornece `URL` e, em deploys de preview, `DEPLOY_PRIME_URL`; uma URL de deploy também é necessária para registrar o webhook. O checkout Mercado Pago só é anunciado quando essas variáveis estão configuradas e o token foi validado. Para Pix por chave própria, configure e teste a chave no painel; os pedidos ficam pendentes até o administrador principal confirmar o recebimento.

O catálogo inicial cobra R$ 6,99 pelo QR simples e pelo QR personalizado, uma única vez por experiência; os preços podem ser ajustados em Admin > Preços e acesso. Criar e publicar a experiência e compartilhar seu link continuam gratuitos. O download é liberado somente depois da confirmação do pagamento ou do resgate de um código válido. O editor e as prévias continuam disponíveis quando o checkout está desabilitado.

O backend calcula preços e cupons no banco, cria cobranças PIX Mercado Pago com chave de idempotência e valida a assinatura do webhook. Antes de liberar o download, consulta o provedor e confere estado, meio de pagamento, referência, moeda, valor e vínculo da experiência ao proprietário. A volta do navegador ou a exibição de um código PIX não confirma pagamento. Nenhuma chave secreta fica no cliente; a função registra `/.netlify/functions/mp-webhook` como `notification_url`.

## Execução e validação local
O site é estático; para testar rotas e service worker, sirva a raiz do repositório por HTTP. Login, publicação na nuvem e checkout exigem Supabase e as configurações Netlify acima. O fluxo de pagamento deve ser testado com credenciais e usuário comprador de teste do Mercado Pago; não use pagamentos reais como teste.

Não há manifesto de dependências neste repositório. `node --check` pode verificar as funções Netlify; os testes abaixo verificam o JavaScript do editor e simulam as chamadas server-side. A configuração e o resultado de chamadas reais dependem das credenciais externas.

Os testes de regressão sem dependências externas podem ser executados com `node --test tests/*.test.js`. As chamadas do Supabase e do Mercado Pago nesses testes são simuladas; validar uma cobrança real/sandbox ainda exige as credenciais e contas de teste configuradas acima. Não use pagamentos reais para testar.

## Recursos preservados
- Autenticação por e-mail/senha, recuperação de senha, sessões Supabase e rotas públicas existentes.
- Experiências, histórico de visitas, fotos, vídeos, músicas, temas, estatísticas e contas existentes.
- Ferramenta de música e controles de usuários/experiências no painel administrativo.
- O painel não simula indicadores: métricas e pagamentos são lidos do banco. Logs operacionais de Functions permanecem no painel Netlify; tentativas de autenticação ficam nos logs do Supabase.