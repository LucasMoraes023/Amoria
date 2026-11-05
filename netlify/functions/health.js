// Verificação das variáveis do Netlify: diz só SE o formato está certo; nunca devolve valores.
// Abra /.netlify/functions/health no navegador depois do deploy. Não depende de nenhum outro arquivo.
const jwtRole = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).role || 'desconhecido'; } catch { return null; } };

exports.handler = async () => {
  const e = { SU: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), SK: process.env.SUPABASE_SERVICE_ROLE_KEY, MP: process.env.MP_ACCESS_TOKEN, WS: process.env.MP_WEBHOOK_SECRET, SITE: process.env.URL || process.env.DEPLOY_PRIME_URL };
  let key = 'ausente';
  if (e.SK) {
    if (/^sb_secret_/.test(e.SK)) key = 'ok (formato novo sb_secret)';
    else { const r = jwtRole(e.SK); key = r === 'service_role' ? 'ok (service_role)' : r === 'anon' ? 'ERRADA: é a chave anon pública; use a service_role em Supabase > Settings > API' : r ? 'papel inesperado: ' + r : 'formato inválido'; }
  }
  const mp = !e.MP ? 'ausente' : /^APP_USR-/.test(e.MP) ? 'ok (produção)' : /^TEST-/.test(e.MP) ? 'ok (teste)' : 'formato inesperado: use o Access Token do Mercado Pago (começa com APP_USR- ou TEST-), não a Public Key';
  const url = !e.SU ? 'ausente' : /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(e.SU) ? 'ok' : 'formato inesperado (esperado: https://SEU-PROJETO.supabase.co)';
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ supabase_url: url, supabase_service_key: key, mp_access_token: mp, webhook_secret: e.WS ? 'configurado' : 'ausente (recomendado)', anthropic_api_key: process.env.ANTHROPIC_API_KEY ? 'configurado' : 'ausente (IA de texto desligada)', openai_api_key: process.env.OPENAI_API_KEY ? 'configurado' : 'ausente (fundos com IA desligados)', site_url: e.SITE ? 'ok' : 'ausente' }) };
};
