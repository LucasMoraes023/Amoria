# Configuração do Netlify

## O que o `netlify.toml` faz

- **Build:** roda `node scripts/build.js` e publica a pasta `dist/`. Ela contém só: `index.html`, `app.js`, `config.js`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `404.html` e `vendor/`. SQL, funções, testes e documentos não são publicados como arquivos do site.
- **Functions:** continuam em `netlify/functions` (detecção automática).
- **Cabeçalhos de segurança:** CSP (scripts só do próprio site), HSTS, X-Frame-Options, Permissions-Policy, Referrer-Policy e nosniff.
- `sw.js` e `index.html` sempre revalidam, para atualizações chegarem logo.

## Passo a passo (pelo celular)

1. Netlify → seu site → **Site configuration → Build & deploy → Continuous deployment**: confirme que o repositório é `LucasMoraes023/Amoria` e a branch é a principal.
2. **Build settings:** deixe **Build command** e **Publish directory** em branco para valer o `netlify.toml` (ou `node scripts/build.js` e `dist`).
3. **Environment variables:** cadastre as variáveis de `VARIAVEIS-DE-AMBIENTE.md`.
4. **Deploys → Trigger deploy → Clear cache and deploy site.**
5. Abra `/.netlify/functions/health` e confira.

## Webhook do Mercado Pago

- Endereço a cadastrar: `https://SEU-SITE.netlify.app/.netlify/functions/mp-webhook` (o painel mostra o endereço exato em **Admin → Backend**).
- Evento: **Pagamentos**. Modo: produção.
- Copie a assinatura secreta para `MP_WEBHOOK_SECRET`.
- Cada Pix criado pelo app também informa esse endereço ao Mercado Pago (campo `notification_url`).

## Tempo limite das Functions

- A IA de texto usa até 8,5 s (padrão do Netlify é 10 s). Se quiser textos longos, aumente o tempo limite em **Site configuration → Functions** e depois ajuste `AI_TEXT_TIMEOUT_MS`.
- A imagem por IA roda em segundo plano (`ai-image-background`, até 15 min) e a tela consulta o resultado.

## Logs

**Netlify → Logs → Functions**. O webhook registra uma linha por notificação (sem dados pessoais).

## Se algo quebrar depois do deploy

- Netlify → **Deploys** → escolha o deploy anterior → **Publish deploy** (volta na hora, sem mexer no GitHub).
- Se a tela ficar em branco e o console falar de "Content Security Policy": remova temporariamente o cabeçalho `Content-Security-Policy` do `netlify.toml` e me avise (a CSP não foi testada em navegador real).

## Domínio próprio

A CSP permite `https://*.supabase.co`. Se você usar domínio próprio no Supabase, inclua-o em `connect-src` e `img-src` no `netlify.toml`.
