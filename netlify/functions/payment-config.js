// Estado da integração de pagamentos para o painel admin. Só o admin principal acessa.
// Nunca devolve o valor de nenhum segredo; apenas "configurado", "ausente" ou "falha".
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
      try { body = JSON.parse(ev.body || '{}'); } catch { body = {}; }
      if (body.target === 'mercadopago') {
        if (!e.MP) return R(200, { ok: false, detail: 'MP_ACCESS_TOKEN ausente no Netlify' });
        const c = await L.mpCheck(true);
        return R(200, { ok: c.ok, detail: c.ok ? 'Credencial aceita pelo Mercado Pago' : 'Falha na validação (HTTP ' + c.status + ')' });
      }
      if (body.target === 'own_key') {
        try {
          const code = buildPixPayload({ key: cfg.key, name: cfg.display_name || cfg.holder, city: cfg.city, amountCents: 100, txid: 'TESTE' });
          return R(200, { ok: checkPixPayload(code), detail: 'Código de teste de R$ 1,00 gerado e verificado (CRC e estrutura). Não é um pagamento.', code });
        } catch (err) { return R(200, { ok: false, detail: err.message }); }
      }
      return R(400, { error: 'Alvo inválido' });
    }
    const mp = !e.MP ? 'ausente' : ((await L.mpCheck(true)).ok ? 'configurado' : 'falha_validacao');
    return R(200, {
      supabase: 'configurado',
      mercadopago: mp,
      webhook_secret: e.WS ? 'configurado' : 'ausente',
      site_url: e.SITE || null,
      webhook_url: e.SITE ? e.SITE + '/.netlify/functions/mp-webhook' : null,
      own_key: L.ownReady(cfg) ? 'configurado' : (cfg.own_enabled ? 'incompleto' : 'desativado'),
      missing: ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET'].filter(k => !process.env[k])
    });
  } catch (err) { return R(500, { error: 'Falha ao consultar a integração' }); }
};
