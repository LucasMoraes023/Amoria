// Utilidades compartilhadas das funções de pagamento (Netlify).
// Variáveis de ambiente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET (recomendada)
const crypto = require('crypto');
const { buildPixPayload } = require('./pix');

const env = () => ({
  SU: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  SK: process.env.SUPABASE_SERVICE_ROLE_KEY,
  MP: process.env.MP_ACCESS_TOKEN,
  WS: process.env.MP_WEBHOOK_SECRET,
  SITE: (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '')
});
const H = { 'Content-Type': 'application/json' };
const R = (c, o) => ({ statusCode: c, headers: H, body: JSON.stringify(o) });
const sb = (p, o = {}) => {
  const e = env();
  return fetch(e.SU + '/rest/v1/' + p, { ...o, headers: { apikey: e.SK, Authorization: 'Bearer ' + e.SK, 'Content-Type': 'application/json', Prefer: 'return=representation', ...o.headers } });
};
const rows = async r => { try { const j = await r.json(); return Array.isArray(j) ? j : []; } catch { return []; } };
const mpFetch = (path, o = {}) => fetch('https://api.mercadopago.com' + path, { ...o, headers: { Authorization: 'Bearer ' + env().MP, ...o.headers } });

async function getUser(ev) {
  const e = env(), h = ev.headers || {};
  const jwt = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const r = await fetch(e.SU + '/auth/v1/user', { headers: { apikey: e.SK, Authorization: 'Bearer ' + jwt } });
  const u = r.ok ? await r.json() : null;
  return u && u.id ? u : null;
}
async function isPrimaryAdmin(userId) {
  const r = await sb('admin_identity?user_id=eq.' + encodeURIComponent(userId) + '&select=user_id');
  return r.ok && (await rows(r)).length === 1;
}

const DEFAULT_CFG = { mp_enabled: true, own_enabled: false, key_type: '', key: '', holder: '', bank: '', city: '', display_name: '', instructions: '' };
async function readConfig() {
  const r = await sb('payment_settings?slot=eq.true&select=data');
  const [row] = r.ok ? await rows(r) : [];
  return { ...DEFAULT_CFG, ...((row && row.data) || {}) };
}
// Funções do banco (somente service role). O preço final SEMPRE é calculado no banco.
const rpc = (name, args) => sb('rpc/' + name, { method: 'POST', body: JSON.stringify(args) });
async function rpcJson(name, args) {
  const r = await rpc(name, args);
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { ok: r.ok, status: r.status, data: j };
}
async function quote(uid, code, coupon, strict, excludeOrder) {
  const r = await rpcJson('compute_quote', { p_uid: uid, p_code: code, p_coupon: coupon || null, p_strict: !!strict, p_exclude: excludeOrder || null });
  return r.ok && r.data ? r.data : { ok: false, error: 'Não foi possível calcular o preço' };
}

let mpCache = { at: 0, ok: false, status: 0 };
async function mpCheck(force) {
  if (!env().MP) return { ok: false, status: 0 };
  if (!force && Date.now() - mpCache.at < 60000) return mpCache;
  try { const r = await mpFetch('/users/me'); mpCache = { at: Date.now(), ok: r.ok, status: r.status }; }
  catch { mpCache = { at: Date.now(), ok: false, status: 0 }; }
  return mpCache;
}
const ownReady = cfg => {
  if (!cfg.own_enabled || !cfg.key_type || !cfg.key || !cfg.holder || !cfg.city) return false;
  try { buildPixPayload({ key: cfg.key, name: cfg.display_name || cfg.holder, city: cfg.city, amountCents: 100, txid: 'TESTE' }); return true; }
  catch { return false; }
};
async function availableMethods() {
  const e = env();
  if (!e.SU || !e.SK) return { mercadopago: false, own_key: false };
  const cfg = await readConfig();
  return {
    mercadopago: !!(e.MP && e.SITE && cfg.mp_enabled && (await mpCheck()).ok),
    own_key: ownReady(cfg)
  };
}

async function logEvent(paymentId, key, from, to, source, detail) {
  await sb('payment_events?on_conflict=event_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ payment_id: paymentId, event_key: key, from_status: from, to_status: to, source, detail })
  });
}

// Estado do Mercado Pago -> estado interno
function mapMpStatus(p) {
  switch (p.status) {
    case 'approved': return 'approved';
    case 'in_process': case 'authorized': case 'in_mediation': return 'in_process';
    case 'rejected': return 'rejected';
    case 'cancelled': return p.status_detail === 'expired' ? 'expired' : 'cancelled';
    case 'expired': return 'expired';
    case 'refunded': return 'refunded';
    case 'charged_back': return 'charged_back';
    default: return 'pending';
  }
}

// Aplica um pagamento já CONSULTADO na API do Mercado Pago. Idempotente.
async function applyMpPayment(p) {
  const [pay] = await rows(await sb('payments?provider_ref=eq.' + encodeURIComponent(String(p.id)) + '&select=id,experience_id,amount_cents,purpose,status,provider,delivered_at'));
  if (!pay || pay.provider !== 'mercadopago') return { ok: true, ignored: true };
  const next = mapMpStatus(p), key = 'mp:' + p.id + ':' + next;
  const ref = String(p.external_reference);
  if (ref !== String(pay.id) && ref !== String(pay.experience_id)) {
    await logEvent(pay.id, key + ':ref', pay.status, 'error', 'webhook', 'Referência do pedido divergente');
    return { ok: true, mismatch: 'reference' };
  }
  if (next === 'approved') {
    if (p.currency_id !== 'BRL' || Math.round(Number(p.transaction_amount) * 100) !== pay.amount_cents) {
      await logEvent(pay.id, key + ':amount', pay.status, 'error', 'webhook', 'Valor ou moeda divergente; adicional não liberado');
      return { ok: true, mismatch: 'amount' };
    }
    if (pay.status === 'approved') {
      if (pay.delivered_at) return { ok: true, duplicate: true };
      const heal = await rpcJson('deliver_order', { p_order: pay.id });
      return heal.ok ? { ok: true, released: true } : { ok: false, error: 'falha ao liberar adicional' };
    }
    const upd = await sb('payments?id=eq.' + pay.id + '&status=neq.approved', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved', paid_at: new Date().toISOString(), status_detail: null, updated_at: new Date().toISOString() })
    });
    if (!upd.ok) return { ok: false, error: 'falha ao registrar pagamento' };
    const delivered = await rpcJson('deliver_order', { p_order: pay.id });
    if (!delivered.ok) return { ok: false, error: 'falha ao liberar adicional' };
    await logEvent(pay.id, key, pay.status, 'approved', 'webhook', 'Confirmado pelo Mercado Pago');
    return { ok: true, released: true };
  }
  if (next === pay.status) return { ok: true, duplicate: true };
  if (pay.status === 'approved' && next !== 'refunded' && next !== 'charged_back') return { ok: true, ignored: true };
  const upd = await sb('payments?id=eq.' + pay.id, {
    method: 'PATCH', body: JSON.stringify({ status: next, status_detail: p.status_detail || null, updated_at: new Date().toISOString() })
  });
  if (!upd.ok) return { ok: false, error: 'falha ao atualizar pagamento' };
  if (next === 'refunded' || next === 'charged_back') {
    const revoked = await rpcJson('revoke_order', { p_order: pay.id, p_reason: next === 'refunded' ? 'Estorno' : 'Contestação' });
    if (!revoked.ok) return { ok: false, error: 'falha ao revogar adicional' };
  }
  await logEvent(pay.id, key, pay.status, next, 'webhook', p.status_detail || 'Atualização do Mercado Pago');
  return { ok: true, updated: next };
}

// Assinatura oficial das notificações do Mercado Pago (cabeçalho x-signature)
function verifyMpSignature({ secret, signature, requestId, dataId }) {
  if (!secret || !signature) return false;
  const parts = Object.fromEntries(String(signature).split(',').map(s => s.trim().split('=').map(x => x.trim())));
  if (!parts.ts || !parts.v1) return false;
  let manifest = '';
  if (dataId) manifest += 'id:' + (/^[a-z0-9]+$/i.test(String(dataId)) ? String(dataId).toLowerCase() : dataId) + ';';
  if (requestId) manifest += 'request-id:' + requestId + ';';
  manifest += 'ts:' + parts.ts + ';';
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(parts.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { env, R, sb, rows, rpc, rpcJson, quote, mpFetch, getUser, isPrimaryAdmin, readConfig, mpCheck, ownReady,
  availableMethods, logEvent, mapMpStatus, applyMpPayment, verifyMpSignature };
