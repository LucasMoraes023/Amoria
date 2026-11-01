// Configuração do Pix direto. Somente o administrador principal acessa.
const { buildPixPayload, checkPixPayload } = require('../lib/pix');
const L = require('../lib/payments');
const { R } = L;
exports.handler = async ev => {
  const e = L.env();
  if (!e.SU || !e.SK) return R(503, { error: 'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas no Netlify' });
  try {
    const u = await L.getUser(ev);
    if (!u) return R(401, { error: 'Faça login' });
    if (!(await L.isPrimaryAdmin(u.id))) return R(403, { error: 'Acesso restrito ao administrador principal' });
    const cfg = await L.readConfig();
    if (ev.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(ev.body || '{}'); } catch {}
      if (body.target !== 'pix_direct') return R(400, { error: 'Alvo inválido' });
      try {
        const code = buildPixPayload({ key: cfg.key, name: cfg.display_name || cfg.holder, city: cfg.city, amountCents: 100, txid: 'TESTE' });
        return R(200, { ok: checkPixPayload(code), detail: 'Pix de teste de R$ 1,00 gerado e validado estruturalmente. Não é um pagamento.' });
      } catch (err) { return R(200, { ok: false, detail: err.message }); }
    }
    if (ev.httpMethod !== 'GET') return R(405, { error: 'Método inválido' });
    return R(200, { supabase: 'configurado', pix_direct: L.ownReady(cfg) ? 'configurado' : (cfg.own_enabled ? 'incompleto' : 'desativado'), missing: ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].filter(k => !process.env[k]) });
  } catch (err) {
    console.error('[payment-config] failed:', err.message || 'unknown');
    return R(500, { error: 'Falha ao consultar a configuração Pix' });
  }
};
