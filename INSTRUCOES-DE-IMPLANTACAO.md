# Instruções de implantação (pelo celular Android)

Tempo estimado: 30 a 40 minutos. Faça na ordem. **Nada aqui mexe em dados reais sem você mandar.**

## 0. Antes de começar

- Descompacte o ZIP no celular (app Arquivos) para ter as pastas à mão.
- Anote o endereço atual do site no Netlify. O deploy atual **continua guardado**: se algo der errado, você volta com um toque (item 8).
- Faça o backup do item 8 de `CONFIGURACAO-SUPABASE.md`.

## 1. GitHub: atualizar os arquivos

No navegador (modo "Site para computador"), abra o repositório `LucasMoraes023/Amoria`.

Para cada pasta abaixo: entre na pasta do repositório → **Add file → Upload files** → escolha os arquivos da pasta correspondente do ZIP → **Commit changes**. Arquivos de mesmo nome são substituídos.

**Obrigatórios para o site:**

1. Raiz: `index.html`, `app.js`, `sw.js`, `netlify.toml`, `404.html`, `manifest.webmanifest`, `icon.svg`, `.gitignore` (o `config.js` do pacote só muda a forma de escrever o endereço do Supabase; pode enviar ou manter o do repositório, o resultado é o mesmo).
2. Pasta `vendor/`: `qrcode.js`, `supabase.js`, `VERSOES.txt`.
3. Pasta `scripts/`: `build.js`.
4. Pasta `netlify/functions/`: todos os arquivos `.js` (inclui os novos `admin-status.js`).
5. Pasta `netlify/lib/`: `ai.js`, `payments.js`, `pix.js`.
6. Pasta `supabase/` e `supabase/migrations/`: todos os `.sql`.

**Recomendados:** os documentos `.md` da raiz, `variaveis-exemplo.txt` e a pasta `tests/`.

**Remover do repositório:** o arquivo `amoria-completo.zip` (abra o arquivo → ícone de lixeira → Commit). Ele é um pacote antigo e faz o teste de segredos reprovar. Com o novo build ele não vai para o site, mas não deve ficar versionado.

Se preferir não subir `tests/` e `backup-original/` agora, o site funciona do mesmo jeito.

## 2. Banco de dados (Supabase)

Siga `CONFIGURACAO-SUPABASE.md`: rode as 3 migrações em ordem e confira com as 3 consultas.

## 3. Variáveis (Netlify)

Siga `VARIAVEIS-DE-AMBIENTE.md`. As obrigatórias para pagamento são `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `MP_ACCESS_TOKEN`. Recomendada: `MP_WEBHOOK_SECRET`.

## 4. Deploy

Ao enviar para o GitHub, o Netlify publica sozinho. Acompanhe em **Deploys**; deve terminar "Published". Se o build falhar, abra o log: a mensagem começa com `BUILD FALHOU:` e diz o motivo.

## 5. Webhook do Mercado Pago

Siga `CONFIGURACAO-NETLIFY.md` (seção Webhook).

## 6. Conferir (checklist, 10 minutos)

1. `https://SEU-SITE/.netlify/functions/health` → variáveis "ok".
2. Abra o site, entre com sua conta, abra **Admin → Backend**: migrações ✅, credencial do Mercado Pago ✅.
3. **Admin → Segurança**: todos ✅.
4. **Admin → Preços e acesso**: confira os preços de `QR Code padrão` e `QR Code personalizado`. (O padrão veio com R$ 2,99; ajuste se quiser.)
5. Crie e publique uma experiência: deve ser **grátis**, sem pedir pagamento.
6. Abra **Link e QR Code → Abrir o QR Code e baixar**: deve mostrar os dois cartões com "Liberar o download".
7. Em "Liberar", digite o código `AMORIA1` e **Aplicar código**: deve aparecer "Liberar gratuitamente". Libere e baixe PNG, JPG e PDF.
8. Abra o link público em outro navegador (sem login) e confira fotos e vídeo.
9. Teste a leitura do QR baixado com a câmera de outro celular.

## 7. Teste de pagamento real (somente com a sua autorização)

Eu **não** fiz transação real. Para validar com dinheiro de verdade:

1. Em **Admin → Preços e acesso**, deixe o preço do QR padrão em um valor baixo (ex.: R$ 1,00).
2. Com uma conta de teste (sem código), peça **Liberar o download** e pague o Pix.
3. Confirme: a tela libera sozinha em segundos; em **Admin → Pagamentos e Pix → Pedidos** aparece "approved".
4. No painel do Mercado Pago, **estorne** o pagamento: o download deve voltar a ficar bloqueado e o pedido aparecer como estornado.
5. Restaure o preço.

## 8. Reverter (rollback)

- **Site:** Netlify → Deploys → escolha o deploy anterior → **Publish deploy**.
- **GitHub:** abra o commit da atualização → **Revert**. Os arquivos originais também estão em `backup-original/` (mesmos caminhos).
- **Banco:** normalmente não precisa (veja `CONFIGURACAO-SUPABASE.md`, seção 8).
- **Só a segurança de navegador (CSP) causou problema:** remova a linha `Content-Security-Policy` do `netlify.toml`.
