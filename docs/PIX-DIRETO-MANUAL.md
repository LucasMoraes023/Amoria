# AMORIA — Pix direto (branch de auditoria)

## O que mudou nesta branch
- Checkout do site passa a aceitar somente Pix por chave própria.
- O payload Pix é montado com o valor calculado no servidor e um TXID vinculado ao pedido.
- O pedido permanece pendente; consultar o status não aprova o pagamento.
- O Mercado Pago foi removido do checkout, do módulo compartilhado e o endpoint de webhook foi excluído.
- O painel de pagamentos mostra configuração da chave, pedidos, transações e relatórios.

## Antes de ativar
1. Faça backup do projeto e do banco Supabase.
2. Configure no Netlify apenas `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` para as funções de pagamento.
3. No Supabase SQL Editor, revise e execute `supabase/pix-direct-only-migration.sql` após as migrações anteriores do módulo de pagamentos.
4. Confirme que o usuário administrador principal está cadastrado em `admin_identity`.
5. Faça deploy de preview, não produção, e configure chave Pix, titular, cidade e preços no painel ADM.
6. Teste geração do QR, código copia-e-cola, pedido pendente, cancelamento e confirmação manual em ambiente de teste.

## Confirmação de pagamento
A chave Pix não fornece confirmação automática. O administrador deve abrir o aplicativo bancário, localizar o crédito correspondente e só então usar “Confirmar recebimento” no pedido. Não aprove com base apenas em imagem ou PDF de comprovante enviado pelo comprador.

## Limitações e validação pendente
- Esta branch ainda não foi executada em ambiente Netlify/Supabase; não há confirmação de build ou teste de ponta a ponta.
- Não há upload/armazenamento de comprovante de pagamento implementado nesta alteração; a aprovação manual depende da conferência no banco.
- A migração SQL precisa ser aplicada manualmente e validada no Supabase antes do uso.
- A integração Pix não é um PSP nem uma API bancária: o QR contém chave/valor/TXID, sem conciliação automática.
- A branch não foi mesclada na principal e não foi publicada no site.

## Variáveis que não devem mais ser necessárias para pagamentos
`MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` não são usados pelo novo fluxo. Remova-os do Netlify somente depois de confirmar que nenhuma outra função do projeto depende deles.
