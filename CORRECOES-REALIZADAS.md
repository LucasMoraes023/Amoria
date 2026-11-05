# Correções realizadas

Resumo do que mudou em relação ao pacote `amoria-atualizacao-1.zip` + repositório (commit `4614b2b`). Os motivos e as provas de cada problema estão em `RELATORIO-DE-AUDITORIA.md` (IDs S01…T05).

## Decisões de produto (conflitos explicados)

Onde o pedido conflitava com a arquitetura existente, escolhi a solução mais segura que preserva o objetivo do produto:

1. **Pix por chave própria (confirmação manual) foi descontinuado.** Um QR Pix estático não avisa o servidor quando o dinheiro entra; a única forma de "confirmar" era o administrador clicar em um botão, o que é exatamente uma liberação administrativa paralela (e polui a receita). Agora só vale o Pix do Mercado Pago, confirmado pelo servidor. Dados antigos foram preservados; pedidos antigos pendentes podem ser cancelados em *Pagamentos e Pix → Pedidos*. Se um dia quiser voltar com a chave própria, decida como confirmar sem botão manual.
2. **Cortesia só por código.** A tela "Cortesias" (liberar por e-mail), a função de liberar direto a um usuário e o botão de confirmar recebimento foram desativados no banco (recusam com mensagem, sem permissão) e removidos do painel. O recurso "revogar uma liberação" continua existindo (remove benefício, não concede).
3. **Quatro "unidades" definidas para os códigos:** 1 uso = 1 QR liberado (uma experiência + um tipo de QR); depois de liberado, baixar de novo é ilimitado e não consome outro uso; o QR personalizado inclui o padrão; apagar a experiência **não** devolve usos.
4. **Preço inicial do QR padrão: R$ 2,99** (você não havia definido um valor; é só o ponto de partida, ajuste em *Preços e acesso*). O personalizado mantém o preço que já estava configurado.
5. **Editor antigo de QR (passo Publicar) removido.** O Estúdio de QR Codes já fazia tudo e mais. Quem já pagou o QR personalizado mantém o direito de baixar.
6. **Publicar é grátis em qualquer configuração:** mesmo que alguém tente ativar cobrança de publicação (pelo painel ou por SQL), o banco força "inativo e grátis".
7. **O download do QR é gerado no navegador** (o QR é só a codificação de um link público). O servidor decide quem tem direito e registra cada download, mas ninguém consegue impedir que alguém gere um QR por conta própria a partir do link público. Isso é inerente ao produto e está dito com todas as letras na auditoria.

## O que foi preservado

Experiências, usuários, fotos, vídeos, tabelas e dados existentes; a identidade visual; todos os modelos do Estúdio; a IA (texto e imagem); o painel (usuários, experiências, pagamentos, relatórios, IA); as migrações antigas (como histórico). Nenhum dado é apagado pelas migrações novas.

## Arquivos

**Criados:** `app.js` (o JavaScript que estava dentro do `index.html`, agora externo para permitir CSP sem script inline), `scripts/build.js`, `404.html`, `vendor/` (bibliotecas fixas), `netlify/functions/admin-status.js`, `supabase/migrations/` (3 arquivos), `variaveis-exemplo.txt`, os 8 documentos, e os testes novos (`tests/checkout.sql.test.js`, `tests/front-studio.test.js`, `tests/front-smoke.test.js`, `tests/pix-unit.test.js`, `tests/static.test.js`, `tests/sql/*`, `tests/helpers/*`, `tests/package.json`).

**Alterados:** `index.html` (scripts locais, estilos novos), `sw.js`, `netlify.toml`, `.gitignore`, `README.md`, `netlify/lib/payments.js`, `netlify/lib/ai.js`, `netlify/functions/create-payment.js` (reescrito), `mp-webhook.js`, `payment-config.js`, `ai-image-background.js`, `health.js`, os 6 SQL antigos (apenas o cabeçalho "LEGADO" e, em `payments-pix-module.sql`, a trava contra zerar o preço), `tests/ai-studio.test.js`, `tests/front-checkout.test.js` (reescrito), `tests/no-secrets.test.js`.

**Removidos:** `tests/qr-payment.test.js` (12 de 14 reprovavam; testava a arquitetura antiga) e `tests/pix-payments.test.js` (banco falso em JavaScript e modelo antigo; os 4 testes unitários foram para `pix-unit.test.js` e o restante foi substituído por testes com SQL real). Nenhum teste foi alterado só para passar: cada troca está explicada no relatório (T01 a T05). Os originais de tudo que foi alterado ou removido estão em `backup-original/`.

## Mudanças por área

**Banco (SQL novo, `supabase/migrations/`)**
- Registro de migrações (`app_migrations`) e checagem de pré-requisitos.
- Histórico financeiro preservado ao excluir experiência/conta (corrige o abuso dos códigos).
- Limite de tentativas de código (8 erros / 15 min por usuário) e mensagens que não vazam regras.
- Produtos `qr_normal` e `qr_custom`; publicação não cobrável; preço só em `products`.
- Direito de download calculado no banco (`my_download_access`, `authorize_qr_download`) e histórico de downloads (`qr_downloads`).
- Cotação/pedido reescritos: exigem experiência própria, impedem cobrança em dobro e serializam o resgate de cada código.
- Códigos: listar com estado, criar/editar, **revogar** (opcionalmente cancelando liberações), **histórico de uso**; AMORIA1 criado sem sobrescrever.
- Status do sistema para o painel (`admin_system_status`).

**Servidor (Netlify)**
- Checkout só com Mercado Pago, para `qr_normal` e `qr_custom`; preço e código sempre calculados no servidor; webhook associa também por `external_reference`; logs sem dados pessoais.
- IA: imagem em JPEG (compatível com o armazenamento), formato conferido pelos bytes; tempo da IA de texto configurável.
- Novo `admin-status` (variáveis, credencial do Mercado Pago, endereço do webhook) sem revelar valores.

**Front-end**
- Tela após publicar: link grátis + caminho para baixar o QR; nenhum QR baixável de graça.
- Estúdio: aba Exportar com os dois produtos, prévia do arquivo final, PNG/JPG/PDF, tamanho de impressão e sangria, controle de tamanho do QR, verificação do QR antes de entregar e confirmação de direito no servidor.
- Compra: campo único de código (sem lista), Pix com "copia e cola", aviso de que o QR do Pix não é o QR da experiência.
- Painel: Preços e acesso (produtos + códigos com histórico/revogação), Segurança e Backend com estado real, Pix só Mercado Pago.
- Segurança: URLs de mídia validadas, endereços aleatórios seguros, sem CDN, sem script inline.
