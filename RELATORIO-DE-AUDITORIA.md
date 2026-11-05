# AMORIA — Relatório de Auditoria

Auditoria técnica completa do pacote `amoria-atualizacao-1.zip` e do repositório `LucasMoraes023/Amoria` (último commit `4614b2b`, 25/10/2026). Data desta versão: 01/11/2026.

## 1. Resumo

- **41 problemas encontrados** (4 altos, 23 médios, 14 baixos).
- **38 corrigidos**, **2 mitigados** e **1 documentado** como risco residual (S15).
- **130 testes automatizados executados, 130 aprovados, 0 reprovados** (antes das correções: 77 testes, 64 aprovados e 13 reprovados).
- **Nenhum pagamento real foi feito ou simulado como real.** O Mercado Pago, a OpenAI, a Anthropic e o Supabase de produção NÃO foram acessados; foram usados simuladores nos testes e um PostgreSQL real descartável para o SQL.
- O que não pôde ser verificado (cadastro/login reais, upload e reprodução de vídeo, Pix real, aparência em celular Android) está listado com franqueza na seção 6 e em `PENDENCIAS-REAIS.md`.

## 2. O que foi inspecionado

- Pacote `amoria-atualizacao-1.zip` (24 arquivos) e clone do repositório (comparados: o `index.html` era idêntico; o ZIP não trazia `netlify.toml`, `sw.js`, `manifest`, `schema.sql`, `free-experiences-qr-addon.sql`, `video-support.sql` nem `qr-payment.test.js`).
- Front-end: `index.html` (CSS + marcação) e todo o JavaScript (≈ 166 KB), service worker, manifesto.
- Servidor: 11 Functions do Netlify e 3 bibliotecas (`payments`, `pix`, `ai`).
- Banco: 6 arquivos SQL (tabelas, RLS, funções, buckets) aplicados de verdade em PostgreSQL 16.
- Testes existentes (5 arquivos) e dependências.

Métodos: leitura de todo o código; análise estática (ESLint `no-undef`, verificação de botões sem função: 0); execução do SQL real, inclusive reexecução e ordens trocadas; provas de falha no código original; testes novos.

## 3. Arquitetura encontrada

- Site estático (HTML + `app.js`) com Supabase (Auth, Postgres com RLS, Storage) e Netlify Functions para o que exige segredo (pagamento, IA).
- A lógica comercial (preço, promoção, códigos, pedidos, liberações) vive no banco, em funções `SECURITY DEFINER`. As Functions só chamam essas funções com a chave de serviço. Esse desenho foi preservado.
- Pagamento: Pix do Mercado Pago, confirmação por webhook + consulta direta à API.

## 4. Achados

Status: **Corrigido**, **Mitigado** (reduzido, depende de ação sua) ou **Documentado** (risco residual aceito).

### Segurança

**S01 · Alta · XSS armazenado na página pública (URL de foto)** — Corrigido
- Causa: A tela pública aceitava qualquer URL que apenas COMEÇASSE com o endereço do Storage e a colocava sem escape em src="...". Qualquer conta podia gravar uma foto com aspas e onerror=..., que executaria no navegador de quem abrisse o link (inclusive do administrador, com acesso ao token de sessão).
- Arquivos: app.js (start, openExp, cinema, dashFree, editor)
- Correção: safeUrl() estrito (mesma origem, bucket certo, sem consulta/fragmento, só caracteres seguros) + esc() em todo src. Vale também para vídeos e música.
- Prova: Prova executada no código original (URL maliciosa aceita) e testes front-checkout nº 6 e 7.

**S02 · Alta · Limite de uso do código podia ser "devolvido" apagando a experiência** — Corrigido
- Causa: payments.experience_id era ON DELETE CASCADE: ao apagar a experiência, o pedido e o resgate do código sumiam e o usuário voltava a ter usos. Com AMORIA1, bastava criar, resgatar 3, apagar e repetir.
- Arquivos: supabase/migrations/20261101_001_base_hardening.sql
- Correção: payments.experience_id e payments.user_id passam a ON DELETE SET NULL: o histórico financeiro e os resgates ficam.
- Prova: Prova executada no banco antigo (3º resgate passou após apagar) e 2 testes de SQL (exclusão de experiência e de conta).

**S03 · Média · Sem proteção contra tentativas abusivas de código; mensagens revelavam regras internas** — Corrigido
- Causa: Qualquer usuário podia testar códigos sem limite e as mensagens diferenciavam "não vale para este produto", "ainda não começou", etc.
- Arquivos: 001 (rate_events), 002 (compute_quote)
- Correção: Bloqueio temporário após 8 erros em 15 min por usuário (e teto global); mensagens genéricas ("Código inválido ou indisponível"); só expirado/esgotado/limite próprio são específicos.
- Prova: Testes SQL: mensagens, bloqueio após 8 tentativas e usuário B não afetado.

**S04 · Média · Endereços de links "secretos" previsíveis** — Corrigido
- Causa: O endereço (slug) era gerado com Math.random() (não criptográfico), no máximo 8 caracteres.
- Arquivos: app.js
- Correção: newSlug(): crypto.getRandomValues, 12 caracteres a-z0-9 (aceito pelo banco).
- Prova: Teste front-checkout nº 8 (3000 endereços sem repetição, formato validado).

**S05 · Média · Cortesia manual por e-mail e confirmação manual de pagamento (contrariam o modelo definido)** — Corrigido
- Causa: O painel tinha a aba "Cortesias" (liberar benefício direto a um usuário) e o botão "Confirmar recebimento" do Pix por chave própria.
- Arquivos: 002 (admin_grant_entitlement, admin_confirm_manual_payment, admin_set_paid), app.js (painel)
- Correção: Funções passam a recusar com mensagem clara e perdem a permissão de execução; telas removidas. A única cortesia é o código.
- Prova: Teste SQL "não existe cortesia manual nem confirmação manual" e teste front que proíbe os nomes no código.

**S06 · Média · O site publicava o repositório inteiro (SQL, funções, testes) e o repo trazia um .zip baixável** — Corrigido
- Causa: netlify.toml usava publish = "." e o repositório contém amoria-completo.zip (32 KB), acessível por URL pública.
- Arquivos: netlify.toml, scripts/build.js, .gitignore
- Correção: Build com lista explícita de arquivos públicos (dist/): só index.html, app.js, config.js, sw.js, manifest, ícone, 404 e vendor/. Teste confere o conteúdo exato de dist/.
- Prova: Teste static nº 4. Confirmado também que o .zip versionado faz o teste no-secrets original reprovar (removê-lo do repositório é recomendado: PENDENCIAS-REAIS.md).

**S07 · Média · Bibliotecas de CDN sem versão fixa e sem integridade** — Corrigido
- Causa: supabase-js era carregado de @2 (sempre a última 2.x) e o qrcode-generator sem SRI.
- Arquivos: index.html, vendor/
- Correção: Bibliotecas copiadas para vendor/ com versão fixa (qrcode-generator 1.4.4, supabase-js 2.118.0) e sha256 registrado em vendor/VERSOES.txt; sem script de CDN.
- Prova: Testes static nº 1 e 2; npm audit sem vulnerabilidades conhecidas.

**S08 · Baixa · Faltavam CSP, X-Frame-Options, HSTS e Permissions-Policy** — Corrigido
- Causa: Só X-Content-Type-Options e Referrer-Policy existiam.
- Arquivos: netlify.toml
- Correção: CSP restritiva (scripts só do próprio site, sem inline, sem eval), frame-ancestors none, HSTS, Permissions-Policy. O JavaScript do HTML foi movido para app.js para permitir script-src 'self'.
- Prova: Teste static nº 3. LIMITAÇÃO: a CSP não foi exercitada em navegador real (ver PENDENCIAS-REAIS.md e o plano de reversão).

**S09 · Baixa · Service worker guardava respostas das Functions e respostas com erro** — Corrigido
- Causa: O fetch do sw.js guardava toda resposta do mesmo domínio, inclusive /.netlify/functions/* (preços, painel).
- Arquivos: sw.js
- Correção: Ignora /.netlify/, só guarda respostas OK do próprio domínio e pré-carrega os arquivos novos (funciona offline com as bibliotecas locais).
- Prova: Teste static nº 5.

**S10 · Média · A publicação poderia virar paga pelo painel** — Corrigido
- Causa: Existia a trava gate_publish e o produto publish_experience ativável pelo administrador.
- Arquivos: 002 (products_guard, gate_publish), app.js
- Correção: gate_publish vira no-op; trigger força publish_experience a "inativo, grátis"; o painel recusa cobrança fora do download do QR.
- Prova: Testes SQL nº 3 a 5 e checkout (publicar → 400).

**S11 · Média · Histórico financeiro apagado ao excluir uma conta** — Corrigido
- Causa: payments.user_id era ON DELETE CASCADE.
- Arquivos: 001
- Correção: SET NULL (ver S02).
- Prova: Teste SQL de exclusão de conta.

**S12 · Baixa · settings.billing (leitura pública) podia conter chave Pix e WhatsApp em bancos antigos** — Corrigido
- Causa: Versões anteriores gravavam esses dados na linha pública.
- Arquivos: 001
- Correção: A linha é sanitizada e deixa de ter preços (fonte única: products).
- Prova: Migração 001 aplicada em banco de teste com dados.

**S13 · Baixa · Link público respondia erro para conteúdo malformado** — Corrigido
- Causa: get_experience decodificava o conteúdo sem tratar falha.
- Arquivos: 003
- Correção: Tratamento de exceção: devolve o conteúdo sem derrubar a página.
- Prova: Teste SQL "link público: conteúdo malformado".

**S14 · Baixa · Webhook aceita notificação sem assinatura enquanto MP_WEBHOOK_SECRET não for configurado** — Mitigado
- Causa: A assinatura é opcional por desenho; mesmo assim nada é liberado só pela notificação: o servidor sempre consulta o pagamento na API do Mercado Pago antes de agir.
- Arquivos: netlify/functions/mp-webhook.js, admin-status.js
- Correção: Mantido o comportamento; o painel (aba Backend) mostra "webhook SEM assinatura" até o segredo ser cadastrado; logs sem dados pessoais.
- Prova: Testes checkout: assinatura inválida 401, válida 200; valor/moeda/referência divergentes não liberam.

**S15 · Baixa · Sem limite de visualizações anônimas nem cota de armazenamento por usuário** — Documentado
- Causa: get_experience registra cada visita; uploads só têm limite por arquivo.
- Arquivos: —
- Correção: Não alterado (exigiria decisão de produto e infraestrutura). Monitorar uso do Supabase.
- Prova: Registrado em PENDENCIAS-REAIS.md.

### Migrações

**M01 · Média · Preço duplicado em vários lugares e divergindo** — Corrigido
- Causa: O preço existia em settings.billing, products, constantes do front e valores padrão no SQL. Provado: após o administrador mudar para R$ 8,99, reexecutar um módulo voltava settings a R$ 6,99 enquanto products ficava em R$ 8,99.
- Arquivos: 002, app.js, create-payment.js
- Correção: Fonte única: public.products. Front lê preços do servidor; settings.billing não tem mais preço.
- Prova: Teste SQL "fonte única de preços" e teste front que proíbe valores fixos.

**M02 · Média · Reexecutar payments-pix-module.sql zerava o preço** — Corrigido
- Causa: Instrução UPDATE incondicional.
- Arquivos: supabase/payments-pix-module.sql
- Correção: Passa a atuar só quando não há valor; arquivo marcado como LEGADO.
- Prova: Cadeia completa reaplicada em banco de teste.

**M03 · Média · "Seguro para reexecutar" não era verdade para 2 dos 5 módulos SQL** — Mitigado
- Causa: free-experiences-qr-addon.sql e payments-pix-module.sql falham (mudança de assinatura de função) ou regridem quando rodados depois dos módulos mais novos.
- Arquivos: supabase/*.sql, supabase/migrations/
- Correção: Arquivos antigos marcados como LEGADO (só instalação nova). Novas migrações numeradas, idempotentes, com pré-requisitos checados e registro em app_migrations (o painel mostra o que foi aplicado).
- Prova: Teste SQL de idempotência e de pré-requisitos.

### Pagamentos

**P01 · Alta · O QR padrão era gratuito (contra o modelo definitivo)** — Corrigido
- Causa: A tela final entregava o QR padrão em PNG e PDF sem pagamento.
- Arquivos: app.js, 002
- Correção: Download do QR padrão e do personalizado só com pagamento confirmado ou código. O banco decide quem pode baixar e registra cada download.
- Prova: Testes SQL, front-studio (bloqueado não baixa nada) e fumaça.

**P02 · Média · Existia compra para PUBLICAR a experiência** — Corrigido
- Causa: Produto publish_experience e telas de compra antes de publicar.
- Arquivos: create-payment.js, app.js
- Correção: Removidos; o checkout só aceita qr_normal e qr_custom.
- Prova: Teste checkout nº 2.

**P03 · Média · Webhook que chegava antes de gravarmos o vínculo era ignorado** — Corrigido
- Causa: O pedido era procurado só por provider_ref, gravado depois da resposta do Mercado Pago.
- Arquivos: netlify/lib/payments.js
- Correção: Localiza também por external_reference e completa o vínculo.
- Prova: Teste checkout nº 6.

**P04 · Média · Pix por chave própria (código estático + confirmação manual)** — Corrigido
- Causa: Não há como o servidor comprovar o recebimento; vira liberação administrativa.
- Arquivos: payments.js, create-payment.js, painel
- Correção: Descontinuado: pagamento só pelo Mercado Pago. Dados antigos preservados; pedidos antigos pendentes podem ser cancelados no painel.
- Prova: Testes checkout (nunca cria pix_manual).

**P05 · Média · Receita e relatórios contavam liberações manuais e gratuitas como dinheiro** — Corrigido
- Causa: Somavam qualquer pagamento "approved".
- Arquivos: 002
- Correção: Receita só conta Mercado Pago (e o histórico do Pix manual); liberações por código aparecem separadas.
- Prova: Teste SQL de visão geral e relatório.

**P06 · Média · Código de cortesia indisponível quando o Mercado Pago não estava configurado** — Corrigido
- Causa: A tela de compra só aparecia com pagamento habilitado.
- Arquivos: create-payment.js, app.js
- Correção: O campo do código fica disponível sempre; só o botão de Pix depende do Mercado Pago.
- Prova: Teste checkout nº 9 e fumaça.

### IA

**A01 · Alta · Geração de imagem por IA falhava ao salvar** — Corrigido
- Causa: O bucket "photos" só aceita image/jpeg até 2 MB e a função gravava o PNG devolvido pelo provedor.
- Arquivos: netlify/lib/ai.js, ai-image-background.js
- Correção: Pede JPEG ao provedor (modelos gpt-image), confere o formato real pelos primeiros bytes e recusa PNG/arquivo grande com mensagem clara ANTES de enviar.
- Prova: Testes de IA (JPEG enviado; PNG e arquivo grande recusados). Não confirmado contra um Supabase/OpenAI reais (sem credenciais).

**A02 · Baixa · Tempo limite fixo de 8,5 s para IA de texto** — Corrigido
- Causa: Constante no código.
- Arquivos: ai.js
- Correção: Configurável por AI_TEXT_TIMEOUT_MS (3 a 24 s).
- Prova: Revisão de código.

### Front-end

**F01 · Média · Dois editores de QR personalizado (antigo e Estúdio) e código duplicado/morto** — Corrigido
- Causa: O passo Publicar ainda trazia o editor simples antigo, com funções próprias de desenho e impressão.
- Arquivos: app.js
- Correção: Editor antigo e funções ligadas a ele removidos; tudo passa pelo Estúdio de QR Codes. Quem já pagou o personalizado mantém o direito.
- Prova: ESLint sem referências quebradas; teste de fumaça do passo Publicar.

**F02 · Média · O Estúdio não exportava JPG** — Corrigido
- Causa: Só PNG e PDF.
- Arquivos: app.js
- Correção: PNG, JPG e PDF para QR padrão e personalizado, todos conferidos módulo a módulo antes de entregar.
- Prova: Teste front-studio (formatos, legibilidade e PDF válido).

**F03 · Média · A prévia não era o arquivo baixado nos tamanhos de impressão** — Corrigido
- Causa: Prévia mostrava só a arte; o arquivo era outra composição (folha com margens).
- Arquivos: app.js
- Correção: Prévia e arquivo usam a MESMA função; o teste compara os bytes do arquivo com a imagem da prévia.
- Prova: Teste front-studio "prévia = arquivo".

**F04 · Baixa · QR padrão com correção de erro mínima (L)** — Corrigido
- Causa: Menos tolerante a dobras e sujeira em papel.
- Arquivos: app.js
- Correção: Correção M, margem de 4 módulos, verificação módulo a módulo e leitura por decodificador independente nos testes.
- Prova: Testes front-studio.

**F05 · Baixa · Não havia controle de tamanho do QR na arte** — Corrigido
- Causa: Só o tamanho do modelo.
- Arquivos: app.js
- Correção: Controle real de 70% a 110% (limitado e validado).
- Prova: Teste front-studio de escala.

**F06 · Baixa · Copiar link sem alternativa quando a área de transferência falha** — Corrigido
- Causa: Exceção não tratada.
- Arquivos: app.js
- Correção: Alternativa com mensagem clara.
- Prova: Teste de fumaça.

**F07 · Média · Abas Segurança e Backend do painel não verificavam nada** — Corrigido
- Causa: Eram informativas.
- Arquivos: app.js, admin-status.js, 003
- Correção: Mostram o estado real: migrações aplicadas, RLS por tabela, regras comerciais, variáveis e credencial do Mercado Pago (sem revelar valores).
- Prova: Testes SQL e checkout (admin-status).

**F08 · Média · Painel com aba de Cortesias por e-mail, Cupons separados e preço em dois lugares** — Corrigido
- Causa: Telas antigas.
- Arquivos: app.js
- Correção: "Preços e acesso" com Produtos e Códigos (cortesia/desconto) com histórico e revogação; sem preço em Configurações.
- Prova: Teste de fumaça do painel.

**F09 · Baixa · Textos comerciais inconsistentes ("QR padrão grátis")** — Corrigido
- Causa: Textos antigos.
- Arquivos: app.js
- Correção: Atualizados para o modelo definitivo.
- Prova: Testes de fumaça e front.

**F10 · Baixa · Código morto e botões sem uso** — Corrigido
- Causa: pollQrCustom, qrEditorLegacy, tratadores sem botão.
- Arquivos: app.js
- Correção: Removidos; ESLint sem erros e nenhum botão sem função (93 ações, 93 tratadores).
- Prova: ESLint + verificador de ações.

### Testes

**T01 · Média · qr-payment.test.js: 12 de 14 reprovavam contra o código atual** — Corrigido
- Causa: Testava uma arquitetura anterior (funções que não existem mais) e o modelo antigo (QR padrão grátis).
- Arquivos: tests/
- Correção: Aposentado. As intenções de segurança (dono, valor, idempotência, webhook, pendente não libera) foram portadas para testes novos com SQL real.
- Prova: Linha de base: 14 testes, 12 reprovados.

**T02 · Média · Testes de pagamento presos a um banco falso em JavaScript e ao modelo antigo** — Corrigido
- Causa: 23 de 29 reprovaram assim que o modelo mudou, e nenhum executava o SQL.
- Arquivos: tests/
- Correção: Substituídos por 18 testes que rodam as Functions reais contra PostgreSQL real (só o Mercado Pago é simulado); 4 testes unitários mantidos.
- Prova: checkout.sql.test.js

**T03 · Baixa · Testes do front liam o script de dentro do index.html** — Corrigido
- Causa: O JavaScript foi para app.js.
- Arquivos: tests/
- Correção: Reescritos e ampliados (11 testes) + 13 do Estúdio + 8 de fumaça em DOM.
- Prova: front-*.test.js

**T04 · Baixa · Pacote enviado estava incompleto** — Corrigido
- Causa: Faltavam netlify.toml, sw.js, manifest, schema.sql etc. (o teste de segredos reprovava por isso).
- Arquivos: —
- Correção: Este pacote é completo e compatível com o repositório.
- Prova: no-secrets.test.js

**T05 · Média · Nenhum teste executava o SQL (RLS, limites, concorrência)** — Corrigido
- Causa: Toda a lógica comercial vive no banco.
- Arquivos: tests/sql/
- Correção: 34 testes em PostgreSQL real: RLS, permissões, limites, validade, revogação, simultaneidade, abuso por exclusão, pagamento e estorno.
- Prova: commercial.test.js

## 5. Evidências executadas

**Abuso do limite do código (S02)** — no banco ANTIGO, com um código de 1 uso por pessoa:

```
passo 1 (1º resgate)            true
passo 2 (2º resgate, limite 1)  ERRO: Você já utilizou este cupom
pedidos que restaram após apagar a experiência: 0
passo 3 (3º resgate APÓS apagar) true   <- limite burlado
```
No banco novo o mesmo roteiro é recusado (teste automatizado).

**XSS (S01)** — no código ANTIGO, a foto `…/photos/u/a" onerror="fetch(...)` passou pela validação e geraria `<img src="…a" onerror="fetch(...)">`. No código novo é descartada.

**Preço dividido (M01)** — após o administrador definir R$ 8,99, reexecutar `payments-pix-module.sql` deixou `products = 899` e `settings.billing = 699`.

**Reexecução dos módulos SQL (M03)** — `free-experiences-qr-addon.sql` e `payments-pix-module.sql` falham quando rodados depois dos módulos mais novos (mudança de assinatura de função).

## 6. Resultados dos testes

Como rodar: `cd tests && npm install && npm test` (precisa de Node 20+ e de um PostgreSQL 15+ para os testes de SQL; sem banco, esses testes ficam **bloqueados**, nunca aprovados).

| Arquivo | Testes | O que cobre |
|---|---|---|
| sql/commercial.test.js | 34 | SQL real: regras comerciais, códigos, RLS, permissões, simultaneidade |
| sql/upgrade.test.js | 6 | Atualização de banco com dados antigos: nada é apagado, direitos antigos continuam |
| checkout.sql.test.js | 18 | Functions reais + SQL real; Mercado Pago simulado |
| front-studio.test.js | 13 | Estúdio: QR legível por leitor independente, arquivos, liberação |
| front-checkout.test.js | 11 | Interface de pagamento, segurança de mídia, regras proibidas |
| front-smoke.test.js | 8 | Telas reais em DOM simulado, sem erros de execução |
| ai-studio.test.js | 20 | IA com provedores simulados |
| static.test.js | 8 | Scripts locais, CSP, build, migrações, documentação |
| no-secrets.test.js | 8 | Nenhum segredo no pacote |
| pix-unit.test.js | 4 | CRC/BR Code e assinatura do webhook |
| **Total** | **130** | **130 aprovados, 0 reprovados, 0 ignorados** |

Linha de base antes das correções: 77 testes (63 do ZIP + 14 do repositório), 64 aprovados, 13 reprovados (1 de segredos por pacote incompleto e 12 do `qr-payment.test.js` obsoleto).

**Limites honestos dos testes:** o desenho do QR foi testado com um canvas de verdade (Skia) em Node, não em navegador Android; fontes e aparência final no celular podem diferir. Pagamentos, IA e armazenamento foram simulados. Nenhum teste substitui conferir no seu celular (veja `INSTRUCOES-DE-IMPLANTACAO.md`).

### Os 34 testes obrigatórios do pedido

| Item | Resultado | Observação |
|---|---|---|
| 1 Cadastro | Não verificado | exige Supabase Auth real |
| 2 Login | Parcial | tela de entrada renderiza sem erro; autenticação real não testada |
| 3 Logout | Não verificado | exige Supabase Auth real |
| 4 Recuperação de acesso | Não verificado | exige e-mail real do Supabase |
| 5 Criação de experiência | Aprovado (parcial) | editor percorre todos os passos sem erro; gravação no banco testada em SQL |
| 6 Edição | Aprovado (parcial) | regras de dono no SQL; fluxo no navegador não testado |
| 7 Salvamento | Aprovado | SQL real |
| 8 Publicação gratuita | Aprovado | SQL + checkout (publicar nunca é cobrado) |
| 9 Compartilhamento | Aprovado (parcial) | link público funciona sem login (SQL); copiar link testado; compartilhar nativo não |
| 10 QR normal | Aprovado | legível em digital, A6, A5, A4 e outros |
| 11 QR personalizado | Aprovado | todos os modelos × temas × cores legíveis |
| 12 Prévia do editor | Aprovado (parcial) | prévia = arquivo, byte a byte; aparência no celular não testada |
| 13 Download do QR | Aprovado | PNG, JPG e PDF; liberados só com direito confirmado pelo servidor |
| 14 Código AMORIA1 | Aprovado | SQL, checkout e interface |
| 15 Limite de 3 usos | Aprovado | inclui 6 resgates simultâneos → 3 |
| 16 Código expirado | Aprovado | SQL e checkout |
| 17 Código inválido | Aprovado | SQL, checkout e interface |
| 18 Código revogado | Aprovado | SQL (com e sem cancelar liberações) |
| 19 Limite total | Aprovado | inclui corrida entre usuários |
| 20 Criação administrativa de códigos | Aprovado (parcial) | SQL real; painel carrega sem erro; envio do formulário não clicado |
| 21 Checkout | Aprovado (simulado) | Mercado Pago simulado |
| 22 Pix | Aprovado (simulado) | código/QR devolvidos pelo simulador; Pix real bloqueado por falta de credenciais |
| 23 Webhook | Aprovado (simulado) | assinatura válida/ inválida, duplicado, atrasado |
| 24 Pagamento aprovado | Aprovado (simulado) | libera uma única vez |
| 25 Pagamento pendente | Aprovado (simulado) | não libera |
| 26 Pagamento recusado | Aprovado (simulado) | recusado, expirado e estornado |
| 27 Liberação de download | Aprovado | servidor decide e registra |
| 28 Upload de fotos | Não verificado | exige Storage/navegador |
| 29 Upload e reprodução de vídeos | Não verificado | exige Storage/navegador |
| 30 Recursos de IA | Aprovado (simulado) | provedores simulados; real bloqueado por falta de chaves |
| 31 Acesso administrativo | Aprovado | só o administrador principal |
| 32 Bloqueio de acesso não autorizado | Aprovado | RLS, permissões e Functions 401/403 |
| 33 Persistência dos dados | Aprovado | SQL real; histórico preservado; atualização de banco com dados antigos sem perda |
| 34 Responsividade mobile | Não verificado | sem navegador/aparelho; só revisão estática |

Contagem dos 34: **15 aprovados sem ressalva**, **7 aprovados com simulador** (Mercado Pago/IA simulados), **5 aprovados parcialmente**, **1 parcial** e **6 não verificados** (cadastro, logout, recuperação de acesso, upload de fotos, upload/reprodução de vídeos e responsividade).

## 7. Limitações da auditoria

- Sem credenciais, **nada foi testado contra Mercado Pago, OpenAI, Anthropic ou o Supabase de produção**. Não houve transação real autorizada.
- Sem navegador/aparelho Android neste ambiente: layout, toque, fontes e a **CSP nova** não foram exercitados em navegador real.
- Não foi possível ver o estado atual do banco de produção; as migrações novas verificam pré-requisitos e o painel (aba Backend) mostra o que está aplicado.
- O download do QR é gerado no navegador (o QR é só a codificação de um link público). A cobrança impede a entrega pelo app e registra cada download; ela não impede quem criar um QR por conta própria a partir do link público. Isso é inerente ao produto.

