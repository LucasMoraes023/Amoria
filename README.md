# AMORIA
App de experiências românticas criado por Lucas Moraes. Frontend estático, autenticação e dados no Supabase, funções serverless no Netlify.

## Comportamento
- Criar, editar e visualizar experiências é gratuito para usuários autenticados; publicar/liberar uma experiência usa o produto `publish_experience` e o pagamento Pix configurado no ADM.
- Links públicos existentes continuam abrindo sem login; experiências secretas, com senha, agendadas ou de contas bloqueadas mantêm suas proteções.
- Baixar o QR simples ou personalizado exige uma liberação avulsa por experiência. O preço inicial de cada opção é R$ 6,99; o administrador principal pode ajustar os produtos em Admin > Preços e acesso.
- O código de cortesia `AMORIA1` pode liberar até três downloads por usuário, combinando QR simples e personalizado. O código é aplicado no checkout e não concede acesso automaticamente.
- A foto decorativa fica fora dos módulos do QR. O gerador usa correção de erro alta e uma margem de segurança de pelo menos quatro módulos.
- Dados antigos de pagamentos, assinaturas e planos não são apagados. As assinaturas não são usadas para conceder recursos e os pagamentos antigos permanecem identificados como histórico.

## Atualizar uma instalação existente
1. Faça backup do banco antes de aplicar migrações.
2. No Supabase SQL Editor, execute `supabase/free-experiences-qr-addon.sql` se ainda não tiver sido aplicada.
3. Execute `supabase/catalog-access-module.sql` e depois `supabase/payments-pix-module.sql`. O catálogo cria os produtos, pedidos, cupons e direitos de acesso; o módulo de pagamentos adiciona a configuração privada do Pix, confirmação manual e relatórios.
4. Se a instalação já passou por versões antigas de pagamento, execute `supabase/pix-direct-only-migration.sql` depois dos dois módulos acima para garantir Pix direto como único método e preservar o WhatsApp configurado.
5. Preserve a configuração de vídeos existente. Se ainda não foi habilitada, execute uma vez `supabase/video-support.sql`.
6. Faça deploy do código atualizado no Netlify sem recriar o projeto Supabase.
7. Confira Authentication > URL Configuration e mantenha o domínio publicado em Site URL e Redirect URLs.
8. Em `config.js`, configure a URL do projeto e a chave `anon public` do Supabase. Essa chave é pública por projeto; nunca use a service-role key no frontend.

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

## Pagamentos e downloads de QR — Pix direto

O checkout desta branch aceita somente Pix por chave própria. O servidor calcula o preço a partir do catálogo do banco, cria o pedido e monta o BR Code com valor e identificador do pedido. O navegador não escolhe nem altera o valor.

A confirmação é manual: o pedido fica pendente até o administrador principal conferir o crédito efetivo no aplicativo/extrato bancário e aprovar no painel. A imagem ou PDF de comprovante enviado pelo comprador, por si só, nunca comprova que o dinheiro entrou. Não existe conciliação bancária automática.

No Netlify, configure somente:
- `SUPABASE_URL`: URL do projeto Supabase usado no frontend.
- `SUPABASE_SERVICE_ROLE_KEY`: chave service-role do mesmo projeto, exclusivamente no ambiente server-side.

No painel ADM > Pagamentos e Pix, informe tipo e chave Pix, titular, cidade e instruções. Ajuste os preços em Admin > Preços e acesso. O QR padrão e o personalizado são produtos avulsos; criar/publicar a experiência e compartilhar o link continuam gratuitos.

A migração `supabase/pix-direct-only-migration.sql` força `mp_enabled=false` e `own_enabled=true` na configuração. Ela deve ser revisada e aplicada somente depois das migrações base `payments-pix-module.sql` e `catalog-access-module.sql`. Não execute no banco de produção sem backup e autorização.

`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e o endpoint `mp-webhook` não fazem parte do novo fluxo de pagamento. Remova as variáveis antigas do Netlify apenas depois de confirmar que nenhum outro componente do projeto as utiliza.

## Execução e validação local
O site é estático; para testar rotas e service worker, sirva a raiz do repositório por HTTP. Login, publicação na nuvem e checkout exigem Supabase e as configurações Netlify acima. O fluxo de pagamento deve ser testado com um usuário comprador de teste e a chave Pix configurada no ADM. Não use pagamentos reais para validar o sistema.

Não há manifesto de dependências neste repositório. `node --check` pode verificar as funções Netlify; os testes abaixo verificam o JavaScript do editor e simulam as chamadas server-side. A configuração e o resultado de chamadas reais dependem das credenciais externas.

Os testes de regressão sem dependências externas podem ser executados com `node --test tests/*.test.js`. As chamadas do Supabase e do provedor Pix nesses testes são simuladas; validar uma cobrança real exige uma conta recebedora de teste e conferência manual do crédito. Não use pagamentos reais para testar.

## Recursos preservados
- Autenticação por e-mail/senha, recuperação de senha, sessões Supabase e rotas públicas existentes.
- Experiências, histórico de visitas, fotos, vídeos, músicas, temas, estatísticas e contas existentes.
- Ferramenta de música e controles de usuários/experiências no painel administrativo.
- O painel não simula indicadores: métricas e pagamentos são lidos do banco. Logs operacionais de Functions permanecem no painel Netlify; tentativas de autenticação ficam nos logs do Supabase.

<!-- netlify-deploy-sync: 2026-11-06 -->