// Estado das integrações para o painel (somente administrador principal). Nunca devolve valores de segredos:
// só "ok", "ausente" ou o problema de formato. A parte do BANCO (migrações, RLS) vem do RPC admin_system_status,
// chamado pelo próprio painel com a sessão do administrador.
const L = require('../lib/payments');
const { R } = L;

const jwtRole = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).role || 'desconhecido'; } catch { return null; } };

exports.handler = async ev => {
  const e = L.env();
  if (!e.SU || !e.SK) return R(503, { error: 'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas no Netlify' });
  try {
    const u = await L.getUser(ev);
    if (!u) return R(401, { error: 'Faça login' });
    if (!(await L.isPrimaryAdmin(u.id))) return R(403, { error: 'Acesso restrito ao administrador principal' });
    const key = !e.SK ? 'ausente' : /^sb_secret_/.test(e.SK) ? 'ok' : (jwtRole(e.SK) === 'service_role' ? 'ok' : jwtRole(e.SK) === 'anon' ? 'ERRADA: é a chave anon; use a service_role' : 'formato inválido');
    const mpEnv = !e.MP ? 'ausente' : /^(APP_USR|TEST)-/.test(e.MP) ? 'ok' : 'formato inesperado (use o Access Token)';
    let mp = { configurado: !!e.MP, valido: false, http: 0 };
    if (e.MP) { const c = await L.mpCheck(true); mp = { configurado: true, valido: !!c.ok, http: c.status }; }
    const cfg = await L.readConfig();
    return R(200, {
      site_url: e.SITE || null,
      webhook_url: e.SITE ? e.SITE + '/.netlify/functions/mp-webhook' : null,
      variaveis: {
        SUPABASE_URL: /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(e.SU) ? 'ok' : 'formato inesperado',
        SUPABASE_SERVICE_ROLE_KEY: key,
        MP_ACCESS_TOKEN: mpEnv,
        MP_WEBHOOK_SECRET: e.WS ? 'configurado' : 'ausente (recomendado)',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'configurado' : 'ausente (IA de texto indisponível)',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'configurado' : 'ausente (fundos com IA indisponíveis)',
        URL: e.SITE ? 'ok' : 'ausente (necessária para o webhook e fundos com IA)'
      },
      mercadopago: { ...mp, habilitado_no_painel: !!cfg.mp_enabled, webhook_assinado: !!e.WS },
      observacao: 'Logs de erro das Functions ficam em Netlify > Logs > Functions. Nenhum valor secreto é exibido aqui.'
    });
  } catch { return R(500, { error: 'Falha ao consultar o status' }); }
};
