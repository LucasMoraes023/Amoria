# AMORIA — Netlify + Supabase + cobrança PIX
App criado por Lucas Moraes.

Criar e visualizar é grátis. O **link e o QR Code só são liberados depois do pagamento** (PIX via Mercado Pago, dinheiro direto na SUA conta). O bloqueio é feito no servidor (Supabase), não só na tela.

## 1. Supabase
1. supabase.com > New project (Free).
2. SQL Editor > cole **todo** o `supabase/schema.sql` > Run. (Se já tinha rodado as etapas 1 e 2, rode só o bloco "ETAPA 3".)
3. Authentication > URL Configuration: coloque o endereço final do Netlify em Site URL e Redirect URLs.
4. Project Settings > API: copie **Project URL**, **anon public** e **service_role** (esta última é SECRETA: nunca vai para o `config.js`).

## 2. config.js
`window.AMORIA={url:"https://xxxx.supabase.co",key:"SUA_CHAVE_ANON"};`

## 3. Mercado Pago (PIX automático)
1. mercadopago.com.br/developers > Suas integrações > Criar aplicação.
2. Copie o **Access Token de produção**.
3. Não precisa configurar webhook à mão: o app já envia a URL em cada cobrança.

## 4. Netlify (com Functions)
As Functions (`netlify/functions`) precisam de deploy por **GitHub** (recomendado) ou **Netlify CLI** (`netlify deploy --prod`). O arrastar-e-soltar pode não publicar as Functions; nesse caso funciona o modo manual abaixo.
Site settings > Environment variables:
- `SUPABASE_URL` = Project URL
- `SUPABASE_SERVICE_ROLE_KEY` = chave service_role
- `MP_ACCESS_TOKEN` = Access Token do Mercado Pago
Faça um novo deploy depois de salvar as variáveis.

## 5. Virar administrador
Crie sua conta no site e rode no SQL Editor:
`update public.profiles set role='admin' where id=(select id from auth.users where email='SEU@EMAIL.COM');`

## 6. Painel ADM > Ajustes > Cobrança
- **Preço por liberação** (R$). Coloque 0 para deixar tudo grátis.
- **Chave PIX e WhatsApp** (modo manual): se o PIX automático falhar ou as Functions não estiverem no ar, o cliente vê sua chave, paga e envia o comprovante pelo WhatsApp. Você confere e clica **Liberar** em Painel ADM > Experiências.
- Resumo mostra pagamentos aprovados e receita.
- Contas Premium e admin não pagam por experiência.

## Novidades de apresentação
- **Modo cinema**: abertura com fotos em tela cheia (zoom suave) e frases animadas; dá para pular.
- Galerias: carrossel, **polaroid** e **mosaico**. Barra de progresso na leitura.
- Novos temas (Ouro real, Neon), efeitos (confete, neve, borboletas, rosas) e tipos (amizade, agradecimento, desculpas, mãe).
- Créditos "App criado por Lucas Moraes" no site, no fim de cada surpresa e no QR para impressão.

## Avisos
- Sem Supabase (config.js vazio) o app roda em modo local e **não cobra**: a cobrança só existe com Supabase.
- Links antigos em formato longo (`#/amor/P....`) deixam de abrir quando a cobrança está ligada; use os links curtos novos.
- Projetos Free do Supabase pausam após 7 dias sem uso.
- A chave PIX digitada no painel fica legível pelo site (é a que o cliente precisa ver). Nunca coloque segredos ali.
- Música: use só faixas livres ou licenciadas.
