// Testes do módulo de Pix/pagamentos. Rodar: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { crc16, buildPixPayload, checkPixPayload } = require('../netlify/lib/pix');

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.MP_ACCESS_TOKEN = 'mp-token';
process.env.URL = 'https://amoria.test';
const L = require('../netlify/lib/payments');
const createPayment = require('../netlify/functions/create-payment').handler;
const webhook = require('../netlify/functions/mp-webhook').handler;
const paymentConfig = require('../netlify/functions/payment-config').handler;

// ---------- Banco e Mercado Pago simulados ----------
const UID = '11111111-1111-4111-8111-111111111111', ADMIN = '22222222-2222-4222-8222-222222222222';
const EXP = '33333333-3333-4333-8333-333333333333';
let db, mp, calls;
function reset(over = {}) {
  db = {
    experiences: [{ id: EXP, owner: UID, qr_custom_paid: false, content: { qrCustom: true } }],
    payments: [], payment_events: [],
    settings: [{ key: 'billing', value: { qr_custom_cents: 699 } }],
    payment_settings: [{ slot: true, data: { mp_enabled: true, own_enabled: true, key_type: 'email', key: 'loja@exemplo.com', holder: 'Lucas Moraes', city: 'São Paulo', display_name: '', bank: 'Banco X', instructions: 'Pague e aguarde.' } }],
    admin_identity: [{ user_id: ADMIN }],
    products: [
      { code: 'qr_custom', name: 'QR Code personalizado', price_cents: 699, active: true, wired: true, promo_percent: null },
      { code: 'publish_experience', name: 'Publicar experiência', price_cents: 990, active: true, wired: true, promo_percent: null }
    ],
    coupons: [
      { id: 'c1', code: 'PCT10', kind: 'percent', value: 10, active: true, per_user_limit: 1 },
      { id: 'c2', code: 'GRATIS', kind: 'free', value: 0, active: true, per_user_limit: 5 },
      { id: 'c3', code: 'UNICO', kind: 'fixed', value: 100, active: true, max_uses: 1, per_user_limit: 5 }
    ],
    entitlements: []
  };
  mp = { payments: {}, next: 9000, down: false, validToken: true };
  calls = { mpCreate: 0 };
  Object.assign(db, over);
  L.mpCheck(true).catch(() => {});
}
const json = (code, body) => ({ ok: code < 300, status: code, json: async () => body });
const parseFilters = qs => [...qs.entries()].filter(([k]) => !['select', 'order', 'limit', 'on_conflict'].includes(k));
function match(row, filters) {
  return filters.every(([k, v]) => {
    const [op, ...rest] = v.split('.'), val = rest.join('.');
    const cur = row[k];
    if (op === 'eq') return String(cur) === val;
    if (op === 'neq') return String(cur) !== val;
    if (op === 'in') return val.replace(/[()]/g, '').split(',').includes(String(cur));
    if (op === 'is') return val === 'null' ? cur == null : cur != null;
    return true;
  });
}
const LIVE = ['pending', 'in_process', 'approved'];
function fakeQuote(uid, code, coupon, strict, exclude) {
  const p = db.products.find(x => x.code === code);
  if (!p || !p.active || !p.wired) return { ok: false, error: 'Produto indisponível no momento' };
  const promo = p.promo_percent ? Math.floor(p.price_cents * p.promo_percent / 100) : 0, aft = p.price_cents - promo;
  const ccode = String(coupon || '').trim().toUpperCase();
  let cd = 0, cerr = null, cid = null;
  if (ccode) {
    const c = db.coupons.find(x => x.code === ccode && x.active);
    if (!c) cerr = 'Cupom inválido';
    else {
      const used = db.payments.filter(o => o.id !== exclude && o.coupon_code === ccode && LIVE.includes(o.status)).length;
      const usedUser = db.payments.filter(o => o.id !== exclude && o.coupon_code === ccode && o.user_id === uid && LIVE.includes(o.status)).length;
      if (c.max_uses && used >= c.max_uses) cerr = 'Cupom esgotado';
      else if (uid && usedUser >= c.per_user_limit) cerr = 'Você já utilizou este cupom';
      else { cd = c.kind === 'free' ? aft : c.kind === 'percent' ? Math.floor(aft * c.value / 100) : Math.min(c.value, aft); cid = c.id; }
    }
  }
  if (cerr && strict) return { ok: false, error: cerr };
  return { ok: true, product_code: code, product_name: p.name, original_cents: p.price_cents, promo_discount_cents: promo, coupon_discount_cents: cd,
    discount_cents: promo + cd, final_cents: aft - cd, free: aft - cd === 0, coupon_code: cid ? ccode : null, coupon_id: cid, coupon_error: cerr };
}
function fakeDeliver(id) {
  const o = db.payments.find(x => x.id === id);
  if (o.delivered_at) return false;
  if (o.status !== 'approved') throw new Error('sem pagamento');
  db.entitlements.push({ id: 'e' + id, user_id: o.user_id, product_code: o.product_code, experience_id: o.experience_id, order_id: id, quantity: 1, consumed: 0, revoked_at: null, expires_at: null });
  if (o.product_code === 'qr_custom' && o.experience_id) db.experiences.find(x => x.id === o.experience_id).qr_custom_paid = true;
  o.delivered_at = new Date().toISOString(); calls.deliver = (calls.deliver || 0) + 1;
  return true;
}
function fakeRpc(name, a) {
  if (name === 'compute_quote') return json(200, fakeQuote(a.p_uid, a.p_code, a.p_coupon, a.p_strict, a.p_exclude));
  if (name === 'create_order') {
    const q = fakeQuote(a.p_uid, a.p_code, a.p_coupon, true);
    if (!q.ok) return json(400, { code: 'P0001', message: q.error });
    if (a.p_code === 'qr_custom' && !db.experiences.some(x => x.id === a.p_exp && x.owner === a.p_uid)) return json(400, { code: 'P0001', message: 'Experiência não encontrada' });
    const exp = a.p_code === 'qr_custom' ? a.p_exp : null, free = q.final_cents === 0;
    if (!free && db.payments.some(p => p.user_id === a.p_uid && p.product_code === a.p_code && (p.experience_id || null) === (exp || null) && p.status === 'pending')) return json(409, { code: '23505', message: 'duplicate key' });
    const row = { id: crypto.randomUUID(), user_id: a.p_uid, experience_id: exp, amount_cents: q.final_cents, purpose: a.p_code, product_code: a.p_code,
      original_cents: q.original_cents, discount_cents: q.discount_cents, coupon_code: q.coupon_code, provider: free ? 'free' : a.p_provider,
      status: free ? 'approved' : 'pending', paid_at: free ? new Date().toISOString() : null, delivered_at: null, created_at: new Date().toISOString() };
    db.payments.push(row); calls.createOrder = (calls.createOrder || 0) + 1;
    if (free) fakeDeliver(row.id);
    return json(200, { order_id: row.id, amount_cents: row.amount_cents, free, status: row.status });
  }
  if (name === 'deliver_order') { try { return json(200, fakeDeliver(a.p_order)); } catch { return json(400, { code: 'P0001', message: 'Pedido sem pagamento confirmado' }); } }
  if (name === 'revoke_order') {
    const o = db.payments.find(x => x.id === a.p_order);
    db.entitlements.filter(e => e.order_id === o.id).forEach(e => { e.revoked_at = 'now'; });
    if (o.product_code === 'qr_custom' && !db.entitlements.some(e => e.experience_id === o.experience_id && !e.revoked_at)) db.experiences.find(x => x.id === o.experience_id).qr_custom_paid = false;
    return json(200, null);
  }
  throw new Error('rpc inesperada: ' + name);
}
global.fetch = async (url, o = {}) => {
  url = String(url);
  const method = (o.method || 'GET').toUpperCase();
  const headers = o.headers || {};
  if (url.startsWith('https://fake.supabase.co/auth/v1/user')) {
    const t = String(headers.Authorization || '').replace('Bearer ', '');
    if (t === 'jwt-user') return json(200, { id: UID, email: 'user@exemplo.com' });
    if (t === 'jwt-admin') return json(200, { id: ADMIN, email: 'admin@exemplo.com' });
    return json(401, {});
  }
  if (url.startsWith('https://fake.supabase.co/rest/v1/')) {
    const [path, q = ''] = url.replace('https://fake.supabase.co/rest/v1/', '').split('?');
    if (path.startsWith('rpc/')) return fakeRpc(path.slice(4), JSON.parse(o.body || '{}'));
    const qs = new URLSearchParams(q), table = db[path], filters = parseFilters(qs);
    if (method === 'GET') {
      let r = table.filter(x => match(x, filters));
      if (qs.get('order') === 'created_at.desc') r = [...r].reverse();
      if (qs.get('limit')) r = r.slice(0, +qs.get('limit'));
      return json(200, JSON.parse(JSON.stringify(r)));
    }
    if (method === 'POST') {
      const row = JSON.parse(o.body);
      if (path === 'payment_events') {
        if (table.some(e => e.event_key === row.event_key)) return json(200, []);
        table.push({ ...row }); return json(201, [row]);
      }
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(o.body), hit = table.filter(x => match(x, filters));
      hit.forEach(x => Object.assign(x, patch));
      return json(200, JSON.parse(JSON.stringify(hit)));
    }
  }
  if (url === 'https://api.mercadopago.com/users/me') return mp.validToken ? json(200, { id: 1 }) : json(401, {});
  if (url === 'https://api.mercadopago.com/v1/payments' && method === 'POST') {
    if (mp.down) return json(503, { message: 'indisponível' });
    const b = JSON.parse(o.body); calls.mpCreate++;
    const id = ++mp.next;
    mp.payments[id] = { id, status: 'pending', currency_id: 'BRL', transaction_amount: b.transaction_amount, external_reference: b.external_reference,
      point_of_interaction: { transaction_data: { qr_code: '00020126MPCODE' + id, qr_code_base64: 'QkFTRTY0' } } };
    return json(201, mp.payments[id]);
  }
  const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
  if (m) return mp.payments[m[1]] ? json(200, mp.payments[m[1]]) : json(404, {});
  throw new Error('fetch inesperado: ' + method + ' ' + url);
};
const post = (body, token = 'jwt-user') => createPayment({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
const B = r => JSON.parse(r.body);

// ---------- Pix / BR Code ----------
test('CRC16-CCITT confere com vetor padrão', () => assert.equal(crc16('123456789'), '29B1'));
test('payload Pix de chave própria é válido e tem valor, nome e cidade normalizados', () => {
  const code = buildPixPayload({ key: 'loja@exemplo.com', name: 'Lucas Moraes', city: 'São Paulo', amountCents: 699, txid: 'AMR123' });
  assert.ok(checkPixPayload(code));
  assert.match(code, /5406699\.0[0-9]|540(4)6\.99/);
  assert.ok(code.includes('540'+'4'+'6.99') || code.includes('54046.99'));
  assert.ok(code.includes('LUCAS MORAES') && code.includes('SAO PAULO') && code.includes('BR.GOV.BCB.PIX'));
});
test('payload adulterado é rejeitado e entradas inválidas lançam erro', () => {
  const code = buildPixPayload({ key: 'a@b.co', name: 'X', city: 'Y', amountCents: 100, txid: 'T' });
  const tampered = code.replace('5901X', '5901Z');
  assert.notEqual(tampered, code);
  assert.equal(checkPixPayload(tampered), false);
  assert.throws(() => buildPixPayload({ key: '', name: 'X', city: 'Y', amountCents: 100 }));
  assert.throws(() => buildPixPayload({ key: 'k', name: 'X', city: 'Y', amountCents: 0 }));
  assert.throws(() => buildPixPayload({ key: 'k', name: '!!!', city: 'Y', amountCents: 100 }));
});

// ---------- Assinatura do webhook ----------
const sign = (secret, dataId, reqId, ts) => crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest('hex');
test('assinatura válida passa; adulterada, sem cabeçalho ou outro segredo falham', () => {
  const v1 = sign('seg', '9001', 'req-1', '1700000000');
  const ok = { secret: 'seg', signature: `ts=1700000000,v1=${v1}`, requestId: 'req-1', dataId: '9001' };
  assert.equal(L.verifyMpSignature(ok), true);
  assert.equal(L.verifyMpSignature({ ...ok, dataId: '9002' }), false);
  assert.equal(L.verifyMpSignature({ ...ok, secret: 'outro' }), false);
  assert.equal(L.verifyMpSignature({ ...ok, signature: '' }), false);
});

// ---------- Checkout ----------
test('GET informa os métodos disponíveis sem expor segredos', async () => {
  reset();
  const r = await createPayment({ httpMethod: 'GET', headers: {} });
  const b = B(r);
  assert.deepEqual(b.methods, { mercadopago: true, own_key: true });
  assert.equal(b.price_cents, 699);
  assert.ok(!r.body.includes('mp-token') && !r.body.includes('loja@exemplo.com'));
});
test('Mercado Pago com token inválido desativa o método (não mostra Pix quebrado)', async () => {
  reset(); mp.validToken = false; await L.mpCheck(true);
  const b = B(await createPayment({ httpMethod: 'GET', headers: {} }));
  assert.equal(b.methods.mercadopago, false);
});
test('sem login → 401; experiência de outro usuário → 404', async () => {
  reset();
  assert.equal((await post({ expId: EXP }, 'nada')).statusCode, 401);
  db.experiences[0].owner = ADMIN;
  assert.equal((await post({ expId: EXP, method: 'mercadopago' })).statusCode, 404);
});
test('Mercado Pago: cria pedido de R$ 6,99, devolve QR e copia e cola, ignora preço enviado pelo navegador', async () => {
  reset(); await L.mpCheck(true);
  const r = await post({ expId: EXP, method: 'mercadopago', amount: 1, price_cents: 1, amount_cents: 1 });
  const b = B(r);
  assert.equal(r.statusCode, 200);
  assert.equal(b.amount, 699); assert.ok(b.code.startsWith('00020126MPCODE')); assert.ok(b.qr);
  assert.equal(db.payments[0].amount_cents, 699);
  assert.equal(Object.values(mp.payments)[0].transaction_amount, 6.99);
});
test('clique duplo / recarga não cria cobrança nem pedido duplicado', async () => {
  reset();
  await post({ expId: EXP, method: 'mercadopago' });
  const again = B(await post({ expId: EXP, method: 'mercadopago' }));
  assert.equal(db.payments.length, 1); assert.equal(calls.mpCreate, 1);
  assert.ok(again.code);
});
test('API do Mercado Pago fora do ar → erro claro e nada liberado; nova tentativa funciona', async () => {
  reset(); mp.down = true;
  const r = await post({ expId: EXP, method: 'mercadopago' });
  assert.equal(r.statusCode, 502); assert.match(B(r).error, /Tente novamente/);
  assert.equal(db.experiences[0].qr_custom_paid, false);
  mp.down = false;
  assert.equal((await post({ expId: EXP, method: 'mercadopago' })).statusCode, 200);
  assert.equal(db.payments.length, 1);
});
test('não permite comprar sem escolher QR personalizado', async () => {
  reset(); db.experiences[0].content = { qrCustom: false };
  assert.equal((await post({ expId: EXP, method: 'mercadopago' })).statusCode, 403);
});

// ---------- Webhook ----------
const hook = (id, extra = {}) => webhook({ httpMethod: 'POST', headers: {}, queryStringParameters: { 'data.id': String(id), type: 'payment' }, body: '{}', ...extra });
async function buyMp() { await post({ expId: EXP, method: 'mercadopago' }); return +Object.keys(mp.payments).pop(); }

test('NÃO libera antes da confirmação; libera após aprovação válida; notificação duplicada não repete efeitos', async () => {
  reset(); const id = await buyMp();
  await hook(id);
  assert.equal(db.experiences[0].qr_custom_paid, false);
  assert.equal(db.payments[0].status, 'pending');
  mp.payments[id].status = 'approved';
  assert.equal((await hook(id)).statusCode, 200);
  assert.equal(db.experiences[0].qr_custom_paid, true);
  assert.equal(db.payments[0].status, 'approved'); assert.ok(db.payments[0].paid_at);
  const paidAt = db.payments[0].paid_at, nEv = db.payment_events.length;
  await hook(id); await hook(id);
  assert.equal(db.payments[0].paid_at, paidAt); assert.equal(db.payment_events.length, nEv);
});
test('valor divergente, moeda errada ou referência de outra experiência não liberam', async () => {
  for (const mut of [p => { p.transaction_amount = 0.01; }, p => { p.currency_id = 'USD'; }, p => { p.external_reference = 'outra'; }]) {
    reset(); const id = await buyMp(); mp.payments[id].status = 'approved'; mut(mp.payments[id]);
    await hook(id);
    assert.equal(db.experiences[0].qr_custom_paid, false);
    assert.notEqual(db.payments[0].status, 'approved');
  }
});
test('assinatura inválida é rejeitada (401) quando MP_WEBHOOK_SECRET existe; válida é aceita', async () => {
  reset(); process.env.MP_WEBHOOK_SECRET = 'seg'; const id = await buyMp(); mp.payments[id].status = 'approved';
  assert.equal((await hook(id, { headers: { 'x-signature': 'ts=1,v1=00', 'x-request-id': 'r' } })).statusCode, 401);
  assert.equal(db.experiences[0].qr_custom_paid, false);
  const v1 = sign('seg', String(id), 'r', '1');
  assert.equal((await hook(id, { headers: { 'x-signature': `ts=1,v1=${v1}`, 'x-request-id': 'r' } })).statusCode, 200);
  assert.equal(db.experiences[0].qr_custom_paid, true);
  delete process.env.MP_WEBHOOK_SECRET;
});
test('notificação de outro tópico é ignorada; pagamento desconhecido não gera erro', async () => {
  reset();
  assert.equal((await webhook({ httpMethod: 'POST', headers: {}, queryStringParameters: { 'data.id': '1', type: 'merchant_order' }, body: '{}' })).body, 'ignorado');
  assert.equal((await hook(424242)).statusCode, 200);
});
test('recusado/expirado fecha o pedido e permite novo; estorno revoga o adicional', async () => {
  reset(); let id = await buyMp();
  mp.payments[id].status = 'cancelled'; mp.payments[id].status_detail = 'expired'; await hook(id);
  assert.equal(db.payments[0].status, 'expired');
  const again = await post({ expId: EXP, method: 'mercadopago' });
  assert.equal(again.statusCode, 200); assert.equal(db.payments.length, 2);
  id = +Object.keys(mp.payments).pop(); mp.payments[id].status = 'approved'; await hook(id);
  assert.equal(db.experiences[0].qr_custom_paid, true);
  mp.payments[id].status = 'refunded'; await hook(id);
  assert.equal(db.experiences[0].qr_custom_paid, false);
  assert.equal(db.payments[1].status, 'refunded');
});
test('botão "Verificar pagamento" sincroniza com o Mercado Pago quando o webhook atrasa', async () => {
  reset(); const id = await buyMp(); mp.payments[id].status = 'approved';
  const r = B(await post({ expId: EXP, action: 'status' }));
  assert.equal(r.paid, true); assert.equal(db.experiences[0].qr_custom_paid, true);
});

// ---------- Pix por chave própria ----------
test('chave própria: gera código válido e o pedido fica PENDENTE sem liberar', async () => {
  reset();
  const r = await post({ expId: EXP, method: 'own_key' }); const b = B(r);
  assert.equal(r.statusCode, 200); assert.equal(b.method, 'pix_manual'); assert.equal(b.amount, 699);
  assert.ok(checkPixPayload(b.code)); assert.ok(b.code.includes('AMR'));
  assert.equal(db.payments[0].provider, 'pix_manual'); assert.equal(db.payments[0].status, 'pending');
  assert.equal(db.experiences[0].qr_custom_paid, false);
  const r2 = B(await post({ expId: EXP, action: 'status' }));
  assert.equal(r2.paid, false);
  assert.equal(db.payments.length, 1);
});
test('trocar de método cancela o pedido anterior (sem duplicar pendências)', async () => {
  reset(); await post({ expId: EXP, method: 'own_key' }); await post({ expId: EXP, method: 'mercadopago' });
  assert.equal(db.payments.filter(p => p.status === 'pending').length, 1);
  assert.equal(db.payments[0].status, 'cancelled');
});
test('chave própria desativada não pode ser usada', async () => {
  reset(); db.payment_settings[0].data.own_enabled = false;
  assert.equal((await post({ expId: EXP, method: 'own_key' })).statusCode, 503);
});

// ---------- Função de status do admin ----------
test('payment-config: só o admin principal; nunca devolve segredos', async () => {
  reset();
  const user = await paymentConfig({ httpMethod: 'GET', headers: { authorization: 'Bearer jwt-user' } });
  assert.equal(user.statusCode, 403);
  const adm = await paymentConfig({ httpMethod: 'GET', headers: { authorization: 'Bearer jwt-admin' } });
  const b = B(adm);
  assert.equal(adm.statusCode, 200); assert.equal(b.mercadopago, 'configurado'); assert.equal(b.own_key, 'configurado');
  assert.ok(!adm.body.includes('mp-token') && !adm.body.includes('service-key'));
  const t = B(await paymentConfig({ httpMethod: 'POST', headers: { authorization: 'Bearer jwt-admin' }, body: JSON.stringify({ target: 'own_key' }) }));
  assert.equal(t.ok, true); assert.ok(checkPixPayload(t.code));
  assert.equal((await paymentConfig({ httpMethod: 'GET', headers: {} })).statusCode, 401);
});

// ---------- Catálogo, cupons e produtos (módulo de preços e acesso) ----------
test('cupom de 10%: o desconto é calculado no servidor e a cobrança sai com o valor final', async () => {
  reset();
  const r = await post({ expId: EXP, method: 'mercadopago', coupon: 'pct10', amount: 1 });
  const b = B(r);
  assert.equal(r.statusCode, 200);
  assert.equal(b.amount, 630); assert.equal(b.original, 699); assert.equal(b.discount, 69); assert.equal(b.coupon, 'PCT10');
  assert.equal(db.payments[0].amount_cents, 630); assert.equal(db.payments[0].original_cents, 699); assert.equal(db.payments[0].coupon_code, 'PCT10');
  assert.equal(Object.values(mp.payments)[0].transaction_amount, 6.3);
});
test('cupom inválido, esgotado ou já usado devolve erro claro e não cria pedido nem cobrança', async () => {
  reset();
  let r = await post({ expId: EXP, method: 'mercadopago', coupon: 'NAOEXISTE' });
  assert.equal(r.statusCode, 422); assert.match(B(r).error, /Cupom inválido/);
  assert.equal(db.payments.length, 0); assert.equal(calls.mpCreate, 0);
  reset(); db.payments.push({ id: 'old', user_id: ADMIN, coupon_code: 'UNICO', status: 'approved' });
  r = await post({ expId: EXP, method: 'mercadopago', coupon: 'UNICO' });
  assert.equal(r.statusCode, 422); assert.match(B(r).error, /esgotado/);
  reset(); db.payments.push({ id: 'old2', user_id: UID, coupon_code: 'PCT10', status: 'approved', experience_id: 'x' });
  r = await post({ expId: EXP, method: 'mercadopago', coupon: 'PCT10' });
  assert.match(B(r).error, /já utilizou/);
});
test('cupom 100%: libera na hora, sem Pix, sem chamar o Mercado Pago', async () => {
  reset();
  const r = await post({ expId: EXP, method: 'mercadopago', coupon: 'GRATIS' });
  const b = B(r);
  assert.equal(r.statusCode, 200); assert.equal(b.paid, true); assert.equal(b.free, true);
  assert.equal(calls.mpCreate, 0);
  assert.equal(db.payments[0].provider, 'free'); assert.equal(db.payments[0].status, 'approved'); assert.equal(db.payments[0].amount_cents, 0);
  assert.equal(db.experiences[0].qr_custom_paid, true); assert.equal(db.entitlements.length, 1);
});
test('trocar o cupom com um pedido pendente substitui o pedido (nada de duas cobranças abertas)', async () => {
  reset();
  await post({ expId: EXP, method: 'mercadopago' });
  await post({ expId: EXP, method: 'mercadopago', coupon: 'PCT10' });
  assert.equal(db.payments.filter(p => p.status === 'pending').length, 1);
  assert.equal(db.payments[0].status, 'cancelled'); assert.equal(db.payments[1].amount_cents, 630);
  const again = B(await post({ expId: EXP, method: 'mercadopago', coupon: 'PCT10' }));
  assert.equal(db.payments.length, 2); assert.equal(again.amount, 630);
});
test('produto desativado ou inexistente não pode ser comprado', async () => {
  reset(); db.products[0].active = false;
  assert.equal((await post({ expId: EXP, method: 'mercadopago' })).statusCode, 422);
  assert.equal((await post({ product: 'hackeado', expId: EXP })).statusCode, 400);
  assert.equal(db.payments.length, 0);
});
test('publicação paga: pedido sem experiência, liberação só após a confirmação, crédito reconhecido', async () => {
  reset();
  const r = await post({ product: 'publish_experience', method: 'mercadopago' });
  const b = B(r);
  assert.equal(r.statusCode, 200); assert.equal(b.amount, 990);
  assert.equal(db.payments[0].experience_id, null); assert.equal(db.payments[0].product_code, 'publish_experience');
  assert.equal(B(await post({ product: 'publish_experience', action: 'status' })).paid, false);
  const id = +Object.keys(mp.payments).pop(); mp.payments[id].status = 'approved';
  assert.equal(B(await post({ product: 'publish_experience', action: 'status' })).paid, true);
  assert.equal(db.entitlements.length, 1); assert.equal(db.experiences[0].qr_custom_paid, false);
  assert.equal(B(await post({ product: 'publish_experience', method: 'mercadopago' })).paid, true);
  assert.equal(db.payments.length, 1);
});
test('webhook cura entrega pendente: pagamento já aprovado mas não entregue é entregue uma única vez', async () => {
  reset(); const id = await buyMp();
  db.payments[0].status = 'approved'; db.payments[0].paid_at = 'x';
  mp.payments[id].status = 'approved';
  await hook(id); await hook(id);
  assert.equal(db.experiences[0].qr_custom_paid, true); assert.equal(calls.deliver, 1); assert.equal(db.entitlements.length, 1);
});
test('pagamento da publicação aprovado pelo webhook cria o crédito sem mexer no QR personalizado', async () => {
  reset();
  await post({ product: 'publish_experience', method: 'mercadopago' });
  const id = +Object.keys(mp.payments).pop(); mp.payments[id].status = 'approved';
  assert.equal((await hook(id)).statusCode, 200);
  assert.equal(db.entitlements[0].product_code, 'publish_experience'); assert.equal(db.experiences[0].qr_custom_paid, false);
});
