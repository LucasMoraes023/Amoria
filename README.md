# AMORIA — Netlify + Supabase, pagamento por criação (PIX manual com QR Code)
App criado por Lucas Moraes.

Não existe plano grátis nem Premium: **cada criação é paga**. O criador monta e visualiza, mas o **link e o QR Code só são liberados depois do pagamento**. O bloqueio é feito no servidor (Supabase), não só na tela.

## Como funciona a cobrança
1. A pessoa cria a surpresa e toca em publicar.
2. Aparece o **QR Code PIX** (com o valor já preenchido) e o "copia e cola".
3. Ela paga e toca em **Enviar comprovante no WhatsApp** (abre a conversa com você).
4. Você confere no seu banco e libera em **Admin > Experiências > Liberar**.
5. A tela dela atualiza sozinha e mostra o link e o QR Code (com botões para enviar ao próprio WhatsApp ou e-mail).

## 1. Supabase
1. supabase.com > New project.
2. SQL Editor > cole **todo** o `supabase/schema.sql` > Run. (Se já rodou antes, rode só os blocos das etapas novas: ETAPA 3 e ETAPA 4.)
3. Authentication > URL Configuration: coloque o endereço do Netlify em Site URL e Redirect URLs.
4. Project Settings > API: copie a **Project URL** e a chave **anon public**.

## 2. config.js
`window.AMORIA={url:"https://xxxx.supabase.co",key:"SUA_CHAVE_ANON"};`

## 3. Netlify
Importe o repositório do GitHub. Build command vazio, publish directory `.`. **Não precisa de variáveis de ambiente.**

## 4. Virar administrador
Crie sua conta no site e rode no SQL Editor:
`update public.profiles set role='admin' where id=(select id from auth.users where email='SEU@EMAIL.COM');`

## 5. Admin > Ajustes > Cobrança
- **Preço por criação** (mínimo R$ 1,00)
- **Chave PIX** (CPF só números, e-mail, celular com +55 ou chave aleatória)
- **Nome do recebedor** e **Cidade** (como no seu banco)
- **WhatsApp** (com DDD): é para ele que a pessoa envia o comprovante. Sem isso, ela não tem como falar com você.

## Avisos
- Sem Supabase (config.js vazio) o app roda em modo local e **não cobra**.
- Projetos Free do Supabase pausam após 7 dias sem uso.
- A chave PIX e o WhatsApp ficam visíveis no site (o cliente precisa deles). Nunca coloque segredos nesses campos.
- Música: use só faixas livres ou licenciadas.
