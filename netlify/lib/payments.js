// Utilidades compartilhadas do Pix direto AMORIA (Netlify).
// Variáveis: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
const { buildPixPayload } = require('./pix');

const env = () => ({
  SU: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  SK: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SITE: (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '')
});
const H = { 'Content-Type': 'application/json' };
const DEFAULT_CFG = { mp_enabled:false, own_enabled:false, key_type:'', key:'', holder:'', display_name:'', bank:'', city:'', instructions:'', whatsapp:'' };
const R = (c, o) => ({ statusCode: c, headers: H, body: JSON.stringify(o) });
const sb = (p, o = {}) => {
  const e = env();
  return fetch(e.SU + '/rest/v1/' + p, { ...o, headers: { apikey: e.SK, Authorization: 'Bearer ' + e.SK, 'Content-Type': 'application/json', Prefer: 'return=representation', ...o.headers } });
};
const rows = async r => {
  if (!r.ok) throw new Error('Falha ao consultar o banco de dados');
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('Resposta inesperada do banco de dados');
  return j;
};

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

// Configuração padrão do Pix direto. Deve existir apenas uma declaração.\nconst DEFAULT_CFG = {\n  mp_enabled: false,\n  own_enabled: true,\n  key_type: '',\n  key: '',\n  holder: '',\n  display_name: '',\n  bank: '',\n  city: '',\n  instructions: '',\n  whatsapp: ''\n};
async function readConfig() {
  const r = await sb('payment_settings?slot=eq.true&select=data');
  const [row] = await rows(r);
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

const ownReady = cfg => {
  if (!cfg.own_enabled || !cfg.key_type || !cfg.key || !cfg.holder || !cfg.city) return false;
  try { buildPixPayload({ key: cfg.key, name: cfg.display_name || cfg.holder, city: cfg.city, amountCents: 100, txid: 'TESTE' }); return true; }
  catch { return false; }
};
async function ensurePublishProduct() {
  const r = await sb('products?code=eq.publish_experience&select=id,code,price_cents,active,wired,lock_stage');
  if (!r.ok) throw new Error('Falha ao verificar o produto de liberação');
  const a = await rows(r);
  if (!a.length) {
    const ins = await sb('products', { method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify({
      code:'publish_experience', name:'Liberar experiência', description:'Liberação da experiência com link e QR Code.',
      price_cents:699, active:true, wired:true, lock_stage:'publish', sort:20
    })});
    if (!ins.ok) throw new Error('Produto de liberação não está configurado no catálogo');
    return;
  }
  const p=a[0];
  if (!p.active || !p.wired || p.lock_stage!=='publish' || Number(p.price_cents)<100) {
    const price=Math.max(100,Number(p.price_cents)||699);
    const up=await sb('products?id=eq.'+encodeURIComponent(p.id),{method:'PATCH',body:JSON.stringify({
      price_cents:price,active:true,wired:true,lock_stage:'publish',updated_at:new Date().toISOString()
    })});
    if(!up.ok) throw new Error('Produto de liberação está desativado no catálogo');
  }
}

async function availableMethods() {
  const e = env();
  if (!e.SU || !e.SK) return { pix_manual: false };
  const cfg = await readConfig();
  return { pix_manual: ownReady(cfg) };
}

async function logEvent(paymentId, key, from, to, source, detail) {
  const response = await sb('payment_events?on_conflict=event_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ payment_id: paymentId, event_key: key, from_status: from, to_status: to, source, detail })
  });
  if (!response.ok) throw new Error('Falha ao registrar evento de pagamento');
}

module.exports = { env, R, sb, rows, rpc, rpcJson, quote, ensurePublishProduct, getUser, isPrimaryAdmin, readConfig, ownReady,
  availableMethods, logEvent };
