# Variáveis de ambiente (Netlify)

Onde configurar: **Netlify → seu site → Site configuration → Environment variables**.
Depois de mudar qualquer variável, faça um novo deploy (**Deploys → Trigger deploy → Deploy site**).
Modelo sem segredos: `variaveis-exemplo.txt`.

**Regra de ouro:** estes valores são segredos. Nunca os coloque no GitHub, no `config.js` ou em mensagens. O `config.js` só tem a URL e a chave **anon** do Supabase, que são públicas por desenho.

## Obrigatórias para pagamento

**SUPABASE_URL**
- É o endereço do projeto, ex.: `https://xxxx.supabase.co`.
- Onde achar: Supabase → Project Settings → API → Project URL.

**SUPABASE_SERVICE_ROLE_KEY**
- Chave de serviço (poderosa). Só no Netlify, nunca no site.
- Onde achar: Supabase → Project Settings → API → `service_role` (ou "Secret key"). **Não use a chave `anon`**: a aba Backend do painel avisa se você colocar a errada.

**MP_ACCESS_TOKEN**
- Credencial de produção do Mercado Pago (começa com `APP_USR-`).
- Onde achar: Mercado Pago Developers → Suas integrações → sua aplicação → Credenciais de produção.

## Recomendada

**MP_WEBHOOK_SECRET**
- "Assinatura secreta" do webhook, para validar que a notificação veio do Mercado Pago.
- Onde achar: Mercado Pago Developers → sua aplicação → Webhooks → Configurar notificações (modo produção) → assinatura secreta.
- Sem ela o sistema continua seguro (o servidor sempre consulta o pagamento na API antes de liberar), mas o painel mostra "webhook SEM assinatura".

## Opcionais (IA)

**ANTHROPIC_API_KEY** — frases e textos (modelo configurável no painel; padrão `claude-haiku-5-5`).
**OPENAI_API_KEY** — fundos românticos por imagem (modelo configurável; use um modelo `gpt-image`; a OpenAI pode exigir verificação da organização para esse modelo).
**AI_TEXT_TIMEOUT_MS** — tempo máximo da IA de texto (3000 a 24000; padrão 8500). Só aumente se você também ampliar o tempo limite das Functions no Netlify.

A IA nasce **desligada** no banco. Para usar: configure a chave aqui e ligue em **Admin → IA**.

## Definidas pelo Netlify (não crie)

**URL** e **DEPLOY_PRIME_URL**: endereço do site. São usadas para o webhook do Pix e para a geração de imagem em segundo plano.

## Como conferir se está certo

1. Abra `https://SEU-SITE/.netlify/functions/health`: mostra, para cada variável, "ok", "ausente" ou o problema de formato. Nunca mostra os valores.
2. No app, entre como administrador principal → **Admin → Backend**: mostra também se a credencial do Mercado Pago é válida e se as migrações do banco foram aplicadas.
