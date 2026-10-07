# AMORIA — Netlify + Supabase, pagamento por criação (PIX manual com QR Code)
App criado por Lucas Moraes.

Não existe plano grátis nem Premium: **cada criação é paga**. O criador monta e visualiza, mas o **link e o QR Code só são liberados depois do pagamento**. O bloqueio é feito no servidor (Supabase), não só na tela.

## Como funciona a cobrança
1. A pessoa entra ou cria uma conta para acessar a área principal e começar uma surpresa.
2. A pessoa cria a surpresa e toca em publicar.
3. Pode criar quantas experiências quiser. Para cada experiência, aparece o **QR Code PIX** (com o valor já preenchido) e o "copia e cola".
4. Ela paga e toca em **Enviar comprovante no WhatsApp** (abre a conversa com você).
5. Você confere no seu banco e libera em **Admin > Experiências > Liberar**.
6. A tela dela atualiza sozinha e mostra o link e o QR Code (com botões para enviar ao próprio WhatsApp ou e-mail).

A autenticação é obrigatória antes de acessar a página inicial ou criar experiências. Os links públicos de experiências continuam podendo ser abertos sem login.

## 1. Supabase
1. supabase.com > New project.
2. SQL Editor > cole **todo** o `supabase/schema.sql` > Run. (Se já rodou antes, rode só os blocos das etapas novas: ETAPA 3 e ETAPA 4.)
3. Para habilitar vídeos, abra `supabase/video-support.sql` no SQL Editor e execute-o uma vez. Isso adiciona um bucket separado e não altera as experiências existentes.
4. Authentication > URL Configuration: coloque o endereço do Netlify em Site URL e Redirect URLs.
5. Project Settings > API: copie a **Project URL** e a chave **anon public**.

## Recursos de criação
- O editor oferece modelos de apresentação, apresentação automática de fotos e uma biblioteca de frases prontas.
- Vídeos: até 3 arquivos MP4 ou WebM de até 25 MB cada. Execute a migração indicada acima uma vez para criar o bucket isolado de vídeos.
- Presente digital: mensagem opcional e link externo seguro (HTTP/HTTPS).
- QR Code personalizado é opcional: o cliente pode escolher cores e texto de moldura com prévia antes de publicar. Se selecionado, soma-se uma única vez R$ 6,99 ao preço normal por criação; o PIX mostra o total junto. O QR estilizado é disponibilizado após a liberação normal do pagamento.
- Os novos dados de experiência são armazenados no conteúdo existente em JSON, sem recriar nem alterar tabelas. Experiências já publicadas mantêm os padrões atuais.

### Atualizar um projeto já existente
Se o site mostrar "Limite do seu plano atingido" ao criar outra experiência, no SQL Editor do Supabase abra e execute uma vez o arquivo [`supabase/unlimited-experiences.sql`](./supabase/unlimited-experiences.sql). A atualização remove o limite do banco e mantém a proteção: cada experiência nova fica sem link público até você aprovar o pagamento dela em **Admin > Experiências > Liberar**. O link e o QR Code de compartilhamento só aparecem depois da liberação. O QR Code PIX para pagamento continua disponível antes disso.

Para adicionar suporte a vídeos sem recriar o banco nem alterar experiências existentes, execute uma vez [`supabase/video-support.sql`](./supabase/video-support.sql) no SQL Editor. Cada experiência pode incluir até 3 vídeos MP4 ou WebM, de até 25 MB cada.

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
- O Supabase deve estar configurado em `config.js` para entrar e criar experiências. Sem essa configuração, o app informa como habilitar a autenticação; experiências públicas existentes continuam abrindo.
- Projetos Free do Supabase pausam após 7 dias sem uso.
- A chave PIX e o WhatsApp ficam visíveis no site (o cliente precisa deles). Nunca coloque segredos nesses campos.
- Música: use só faixas livres ou licenciadas.
