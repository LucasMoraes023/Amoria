// Checkout, webhook e liberação do QR: Functions do Netlify (código real) + SQL real (PostgreSQL). Só o Mercado Pago é simulado.
// Nenhum pagamento real é feito. Sem PostgreSQL de teste, ficam BLOQUEADOS (skip).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('./sql/helpers');
const { makeFetch, makeMp, SUPABASE_URL } = require('./sql/shim');
const { as, user, q, call } = H;

const ENV0 = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'fake-key', MP_ACCESS_TOKEN: 'token-falso-somente-para-testes', URL: 'https://amoria.example.test' };
let db, mp, skipWhy = '', createPayment, webhook, paymentConfig, adminStatus, realFetch, adm;
before(async () => {
  skipWhy = await H.available(); if (skipWhy) return;
  db = await H.createDb(); mp = makeMp();
  realFetch = global.fetch; global.fetch = makeFetch(db, mp);
  Object.assign(process.env, ENV0); delete process.env.MP_WEBHOOK_SECRET;
  createPayment = require('../netlify/functions/create-payment').handler;
  webhook = require('../netlify/functions/mp-webhook').handler;
  paymentConfig = require('../netlify/functions/payment-config').handler;
  adminStatus = require('../netlify/functions/admin-status').handler;
  adm = await H.addUser(db, 'admin@teste.com'); await H.makePrimaryAdmin(db, adm);
});
after(async () => { if (realFetch) global.fetch = realFetch; if (db) await db.drop(); });
beforeEach(() => { if (skipWhy) return; Object.assign(process.env, ENV0); delete process.env.MP_WEBHOOK_SECRET; mp.st.up = true; mp.st.usersMe = 200; });
const t = (name, fn) => test(name, async ctx => { if (skipWhy) return ctx.skip('BLOQUEADO: ' + skipWhy); await fn(ctx); });

const ev = (uid, body, extra = {}) => ({ httpMethod: 'POST', headers: uid ? { authorization: 'Bearer tok_' + uid } : {}, body: JSON.stringify(body), ...extra });
const post = async (uid, body) => { const r = await createPayment(ev(uid, body)); return { status: r.statusCode, b: JSON.parse(r.body) }; };
const hook = async (id, extra = {}) => (await webhook({ httpMethod: 'POST', headers: {}, queryStringParameters: { 'data.id': String(id), type: 'payment' }, body: JSON.stringify({ type: 'payment', data: { id: String(id) } }), ...extra })).statusCode;
const access = (u, e) => as(db, user(u), c => call(c, 'my_download_access', [e]));
const mk = async () => { const u = await H.addUser(db); return { u, e: await H.addExperience(db, u) }; };
const ents = async (u) => (await q(db.pool, 'select * from public.entitlements where user_id=$1', [u]));
const price = async code => (await q(db.pool, 'select price_cents from public.products where code=$1', [code]))[0].price_cents;

t('GET informa preços dos dois produtos e se dá para pagar; sem segredos e sem Pix por chave própria', async () => {
  const r = await createPayment({ httpMethod: 'GET', headers: {} }), b = JSON.parse(r.body);
  assert.equal(r.statusCode, 200); assert.equal(b.enabled, true); assert.equal(b.methods.mercadopago, true); assert.equal(b.methods.own_key, false);
  assert.equal(b.prices.qr_normal.cents, await price('qr_normal')); assert.equal(b.prices.qr_custom.cents, await price('qr_custom'));
  assert.ok(!/TEST-|fake-key|token-falso/.test(r.body));
});
t('validações: sem login 401; produto inválido (inclui publicar) 400; experiência alheia 404; id inválido 400', async () => {
  const a = await mk(), b = await mk();
  assert.equal((await post(null, { product: 'qr_normal', expId: a.e })).status, 401);
  assert.equal((await post(a.u, { product: 'publish_experience', expId: a.e })).status, 400);
  assert.equal((await post(a.u, { product: 'qualquer', expId: a.e })).status, 400);
  assert.equal((await post(b.u, { product: 'qr_normal', expId: a.e })).status, 404);
  assert.equal((await post(a.u, { product: 'qr_normal', expId: 'nao-e-uuid' })).status, 400);
});
t('pagamento Pix: cria pedido e cobrança no Mercado Pago com valor do banco; ignora preço/método vindos do navegador; clique duplo não duplica', async () => {
  const { u, e } = await mk(); mp.st.calls.length = 0;
  const r = await post(u, { product: 'qr_normal', expId: e, amount: 1, price_cents: 1, method: 'own_key' });
  assert.equal(r.status, 200); assert.equal(r.b.method, 'mercadopago'); assert.equal(r.b.amount, await price('qr_normal'));
  assert.ok(r.b.code && r.b.qr && r.b.orderId);
  const c = mp.creates(); assert.equal(c.length, 1);
  const sent = JSON.parse(c[0].body);
  assert.equal(sent.transaction_amount, (await price('qr_normal')) / 100); assert.equal(sent.external_reference, r.b.orderId);
  assert.equal(sent.notification_url, 'https://amoria.example.test/.netlify/functions/mp-webhook'); assert.equal(sent.payment_method_id, 'pix');
  assert.equal(c[0].headers['x-idempotency-key'], 'amoria-order-' + r.b.orderId);
  const again = await post(u, { product: 'qr_normal', expId: e });
  assert.equal(again.b.orderId, r.b.orderId); assert.equal(mp.creates().length, 1, 'não pode abrir segunda cobrança');
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where user_id=$1 and provider<>'free'", [u]))[0].n, 1);
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where provider='pix_manual'"))[0].n, 0);
  assert.deepEqual(await access(u, e), { normal: false, custom: false });
});
t('NÃO libera antes da confirmação: pendente, em análise e valor divergente não liberam; aprovado confirmado libera uma única vez', async () => {
  const { u, e } = await mk();
  const r = await post(u, { product: 'qr_normal', expId: e }); const mpId = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r.b.orderId]))[0].provider_ref;
  const pay = mp.st.payments.get(mpId);
  assert.equal(await hook(mpId), 200); assert.deepEqual(await access(u, e), { normal: false, custom: false }, 'pendente');
  pay.status = 'in_process'; await hook(mpId); assert.deepEqual(await access(u, e), { normal: false, custom: false }, 'em análise');
  pay.status = 'approved'; pay.transaction_amount = 0.01; await hook(mpId);
  assert.deepEqual(await access(u, e), { normal: false, custom: false }, 'valor divergente');
  assert.ok((await q(db.pool, "select 1 from public.payment_events where payment_id=$1 and to_status='error'", [r.b.orderId])).length >= 1);
  pay.transaction_amount = (await price('qr_normal')) / 100; pay.currency_id = 'USD'; await hook(mpId);
  assert.deepEqual(await access(u, e), { normal: false, custom: false }, 'moeda divergente');
  pay.currency_id = 'BRL'; pay.external_reference = H.uuid(); await hook(mpId);
  assert.deepEqual(await access(u, e), { normal: false, custom: false }, 'referência divergente');
  pay.external_reference = r.b.orderId; assert.equal(await hook(mpId), 200);
  assert.deepEqual(await access(u, e), { normal: true, custom: false });
  assert.equal(await hook(mpId), 200); assert.equal(await hook(mpId), 200);
  assert.equal((await ents(u)).length, 1, 'notificação duplicada não repete a liberação');
  assert.equal((await q(db.pool, 'select status from public.payments where id=$1', [r.b.orderId]))[0].status, 'approved');
  const st = await post(u, { product: 'qr_normal', expId: e, action: 'status' }); assert.equal(st.b.paid, true);
  assert.equal((await post(u, { product: 'qr_normal', expId: e })).b.already, true, 'não cobra duas vezes pelo mesmo QR');
});
t('botão "Verificar pagamento" confirma direto na API do Mercado Pago quando o webhook atrasa', async () => {
  const { u, e } = await mk(); const r = await post(u, { product: 'qr_custom', expId: e }).catch(() => null);
  await as(db, user(u), c => c.query("update public.experiences set content='{\"qrCustom\":true}' where id=$1", [e]));
  const r2 = await post(u, { product: 'qr_custom', expId: e }); assert.equal(r2.status, 200);
  const mpId = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r2.b.orderId]))[0].provider_ref;
  assert.equal((await post(u, { product: 'qr_custom', expId: e, action: 'status' })).b.paid, false);
  mp.st.payments.get(mpId).status = 'approved';
  const st = await post(u, { product: 'qr_custom', expId: e, action: 'status' });
  assert.equal(st.b.paid, true); assert.deepEqual(await access(u, e), { normal: true, custom: true });
  assert.ok(r === null || r.status === 403, 'sem selecionar o QR personalizado não compra');
});
t('webhook que chega antes de gravarmos provider_ref é associado pelo external_reference', async () => {
  const { u, e } = await mk(); const r = await post(u, { product: 'qr_normal', expId: e });
  const mpId = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r.b.orderId]))[0].provider_ref;
  await db.pool.query('update public.payments set provider_ref=null where id=$1', [r.b.orderId]);
  mp.st.payments.get(mpId).status = 'approved';
  assert.equal(await hook(mpId), 200);
  assert.deepEqual(await access(u, e), { normal: true, custom: false });
  assert.equal((await q(db.pool, 'select provider_ref from public.payments where id=$1', [r.b.orderId]))[0].provider_ref, mpId);
});
t('recusado/expirado não libera e permite nova cobrança; estorno depois de aprovado revoga o QR', async () => {
  const { u, e } = await mk(); const r = await post(u, { product: 'qr_normal', expId: e });
  const mpId = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r.b.orderId]))[0].provider_ref, pay = mp.st.payments.get(mpId);
  pay.status = 'rejected'; await hook(mpId);
  assert.equal((await q(db.pool, 'select status from public.payments where id=$1', [r.b.orderId]))[0].status, 'rejected');
  assert.deepEqual(await access(u, e), { normal: false, custom: false });
  const r2 = await post(u, { product: 'qr_normal', expId: e }); assert.equal(r2.status, 200); assert.notEqual(r2.b.orderId, r.b.orderId);
  const id2 = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r2.b.orderId]))[0].provider_ref, p2 = mp.st.payments.get(id2);
  p2.status = 'cancelled'; p2.status_detail = 'expired'; await hook(id2);
  assert.equal((await q(db.pool, 'select status from public.payments where id=$1', [r2.b.orderId]))[0].status, 'expired');
  const r3 = await post(u, { product: 'qr_normal', expId: e }); assert.equal(r3.status, 200);
  const id3 = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r3.b.orderId]))[0].provider_ref, p3 = mp.st.payments.get(id3);
  p3.status = 'approved'; await hook(id3); assert.equal((await access(u, e)).normal, true);
  p3.status = 'refunded'; await hook(id3);
  assert.deepEqual(await access(u, e), { normal: false, custom: false }, 'estorno revoga');
  assert.equal((await q(db.pool, 'select status from public.payments where id=$1', [r3.b.orderId]))[0].status, 'refunded');
});
t('Mercado Pago fora do ar: erro claro, nada liberado, e a nova tentativa funciona sem duplicar', async () => {
  const { u, e } = await mk(); mp.st.up = false;
  const bad = await post(u, { product: 'qr_normal', expId: e }); assert.equal(bad.status, 502); assert.match(bad.b.error, /Mercado Pago/);
  assert.deepEqual(await access(u, e), { normal: false, custom: false });
  mp.st.up = true; const ok = await post(u, { product: 'qr_normal', expId: e }); assert.equal(ok.status, 200); assert.ok(ok.b.code);
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where user_id=$1 and status='pending'", [u]))[0].n, 1);
});
t('código AMORIA1: libera sem Pix e sem chamar o Mercado Pago; 3 usos por usuário; 4º recusado; código errado não cria pedido', async () => {
  const u = await H.addUser(db), exps = []; for (let i = 0; i < 4; i++) exps.push(await H.addExperience(db, u)); mp.st.calls.length = 0;
  const a = await post(u, { product: 'qr_normal', expId: exps[0], coupon: 'amoria1' });
  assert.equal(a.status, 200); assert.equal(a.b.paid, true); assert.equal(a.b.free, true);
  assert.equal(mp.creates().length, 0, 'cortesia não chama o Mercado Pago');
  await as(db, user(u), c => c.query("update public.experiences set content='{\"qrCustom\":true}' where id=$1", [exps[1]]));
  assert.equal((await post(u, { product: 'qr_custom', expId: exps[1], coupon: 'AMORIA1' })).b.free, true);
  assert.equal((await post(u, { product: 'qr_normal', expId: exps[2], coupon: 'AMORIA1' })).b.free, true);
  const quarto = await post(u, { product: 'qr_normal', expId: exps[3], coupon: 'AMORIA1' });
  assert.equal(quarto.status, 422); assert.match(quarto.b.error, /máximo de vezes/);
  const ruim = await post(u, { product: 'qr_normal', expId: exps[3], coupon: 'NAOEXISTE' }); assert.equal(ruim.status, 422); assert.match(ruim.b.error, /inválido ou indisponível/);
  assert.deepEqual(await access(u, exps[3]), { normal: false, custom: false });
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where user_id=$1 and provider='free'", [u]))[0].n, 3);
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where user_id=$1 and status='pending'", [u]))[0].n, 0);
});
t('sem Mercado Pago configurado: pagar fica indisponível (503), mas o código de cortesia continua funcionando', async () => {
  delete process.env.MP_ACCESS_TOKEN; const { u, e } = await mk();
  const g = JSON.parse((await createPayment({ httpMethod: 'GET', headers: {} })).body); assert.equal(g.enabled, false); assert.equal(g.courtesy, true);
  const pagar = await post(u, { product: 'qr_normal', expId: e }); assert.equal(pagar.status, 503);
  assert.deepEqual(await access(u, e), { normal: false, custom: false });
  assert.equal((await post(u, { product: 'qr_normal', expId: e, coupon: 'AMORIA1' })).b.free, true);
});
t('webhook: assinatura inválida é rejeitada (401) quando MP_WEBHOOK_SECRET existe; assinatura válida é aceita', async () => {
  process.env.MP_WEBHOOK_SECRET = 'segredo-de-teste'; const { u, e } = await mk();
  const r = await post(u, { product: 'qr_normal', expId: e }); const mpId = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r.b.orderId]))[0].provider_ref;
  mp.st.payments.get(mpId).status = 'approved';
  assert.equal(await hook(mpId, { headers: { 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'r1' } }), 401);
  assert.equal(await hook(mpId), 401, 'sem cabeçalho de assinatura');
  assert.deepEqual(await access(u, e), { normal: false, custom: false }, 'rejeitado não libera');
  const ts = String(Date.now()), rid = 'req-1', v1 = crypto.createHmac('sha256', 'segredo-de-teste').update(`id:${mpId};request-id:${rid};ts:${ts};`).digest('hex');
  assert.equal(await hook(mpId, { headers: { 'X-Signature': `ts=${ts},v1=${v1}`, 'X-Request-Id': rid } }), 200);
  assert.equal((await access(u, e)).normal, true);
});
t('webhook: outro tópico é ignorado e pagamento desconhecido não gera erro', async () => {
  assert.equal((await webhook({ httpMethod: 'POST', headers: {}, queryStringParameters: { topic: 'merchant_order', id: '1' }, body: '{}' })).statusCode, 200);
  assert.equal(await hook(123456789), 200);
});
t('o QR personalizado só é vendido para experiências que escolheram o QR personalizado; Pix manual nunca é criado', async () => {
  const { u, e } = await mk();
  const r = await post(u, { product: 'qr_custom', expId: e }); assert.equal(r.status, 403);
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where provider='pix_manual'"))[0].n, 0);
});

const saveCode = p => as(db, user(adm), c => call(c, 'admin_coupon_save', [JSON.stringify(p)]));
t('código de desconto de 10%: o desconto é calculado no servidor e a cobrança sai com o valor final', async () => {
  await saveCode({ code: 'DEZ', kind: 'percent', value: 10, product_codes: ['qr_normal'], per_user_limit: 1 });
  const { u, e } = await mk(); mp.st.calls.length = 0;
  const base = await price('qr_normal'), r = await post(u, { product: 'qr_normal', expId: e, coupon: 'dez' });
  assert.equal(r.status, 200); assert.equal(r.b.amount, base - Math.floor(base * 10 / 100)); assert.equal(r.b.coupon, 'DEZ');
  assert.equal(JSON.parse(mp.creates()[0].body).transaction_amount, r.b.amount / 100);
});
t('trocar o código com um pedido pendente substitui o pedido (nada de duas cobranças abertas)', async () => {
  await saveCode({ code: 'METADE', kind: 'percent', value: 50, product_codes: ['qr_normal'], per_user_limit: 2 });
  const { u, e } = await mk(); const full = await post(u, { product: 'qr_normal', expId: e });
  const half = await post(u, { product: 'qr_normal', expId: e, coupon: 'METADE' });
  assert.notEqual(half.b.orderId, full.b.orderId); assert.ok(half.b.amount < full.b.amount);
  assert.equal((await q(db.pool, 'select status from public.payments where id=$1', [full.b.orderId]))[0].status, 'cancelled');
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where user_id=$1 and status='pending'", [u]))[0].n, 1);
});
t('produto desativado ou inexistente não pode ser comprado', async () => {
  const { u, e } = await mk();
  await db.pool.query("update public.products set active=false where code='qr_normal'");
  try {
    const r = await post(u, { product: 'qr_normal', expId: e }); assert.equal(r.status, 422); assert.match(r.b.error, /indisponível/);
    assert.equal(JSON.parse((await createPayment({ httpMethod: 'GET', headers: {} })).body).prices.qr_normal, null);
    assert.equal((await q(db.pool, 'select count(*)::int n from public.payments where user_id=$1', [u]))[0].n, 0);
  } finally { await db.pool.query("update public.products set active=true where code='qr_normal'"); }
});
t('webhook cura entrega pendente: pagamento já aprovado mas não entregue é entregue uma única vez', async () => {
  const { u, e } = await mk(); const r = await post(u, { product: 'qr_normal', expId: e });
  const mpId = (await q(db.pool, 'select provider_ref from public.payments where id=$1', [r.b.orderId]))[0].provider_ref;
  await db.pool.query("update public.payments set status='approved', paid_at=now() where id=$1", [r.b.orderId]);   // aprovado, porém sem entrega
  assert.deepEqual(await access(u, e), { normal: false, custom: false });
  mp.st.payments.get(mpId).status = 'approved';
  assert.equal(await hook(mpId), 200); assert.equal(await hook(mpId), 200);
  assert.deepEqual(await access(u, e), { normal: true, custom: false }); assert.equal((await ents(u)).length, 1);
});
t('payment-config e admin-status: só o administrador principal; nunca devolvem segredos; Pix próprio descontinuado', async () => {
  const { u } = await mk();
  assert.equal((await paymentConfig({ httpMethod: 'GET', headers: {} })).statusCode, 401);
  assert.equal((await paymentConfig({ httpMethod: 'GET', headers: { authorization: 'Bearer tok_' + u } })).statusCode, 403);
  assert.equal((await adminStatus({ httpMethod: 'GET', headers: { authorization: 'Bearer tok_' + u } })).statusCode, 403);
  const adminHdr = { authorization: 'Bearer tok_' + adm };
  const pc = await paymentConfig({ httpMethod: 'GET', headers: adminHdr }), b = JSON.parse(pc.body);
  assert.equal(pc.statusCode, 200); assert.equal(b.mercadopago, 'configurado'); assert.equal(b.own_key, 'descontinuado');
  const st = await adminStatus({ httpMethod: 'GET', headers: adminHdr }), sb = JSON.parse(st.body);
  assert.equal(st.statusCode, 200); assert.equal(sb.mercadopago.valido, true); assert.equal(sb.variaveis.MP_WEBHOOK_SECRET, 'ausente (recomendado)');
  for (const r of [pc, st]) assert.ok(!r.body.includes('token-falso') && !r.body.includes('fake-key'), 'segredo vazou');
  const t2 = JSON.parse((await paymentConfig({ httpMethod: 'POST', headers: adminHdr, body: JSON.stringify({ target: 'own_key' }) })).body);
  assert.equal(t2.ok, false); assert.match(t2.detail, /descontinuado/);
});
