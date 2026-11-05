// Atualização de um banco JÁ EM USO (estado antigo, com dados): as migrações novas não podem apagar nada
// e os direitos que os usuários já tinham precisam continuar valendo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { as, user, service, call, q } = H;

let db, skipWhy = '', S = {};
before(async () => {
  skipWhy = await H.available(); if (skipWhy) return;
  db = await H.createDb({ files: [H.STUB, ...H.LEGACY] });          // banco no estado ANTIGO (sem as migrações novas)
  const adm = await H.addUser(db, 'admin@teste.com'); await H.makePrimaryAdmin(db, adm);
  const u1 = await H.addUser(db), u2 = await H.addUser(db), u3 = await H.addUser(db), u4 = await H.addUser(db);
  const e1 = await H.addExperience(db, u1, { content: { qrCustom: true } }), e2 = await H.addExperience(db, u2, { content: { qrCustom: true } }),
    e3 = await H.addExperience(db, u3, { content: { qrCustom: true } }), e4 = await H.addExperience(db, u4, { content: { qrCustom: true } });
  // u1: compra PAGA no modelo antigo (qr_custom, Mercado Pago aprovado e entregue)
  const o1 = await as(db, service, c => call(c, 'create_order', [u1, 'qr_custom', e1, null, 'mercadopago']));
  await db.pool.query("update public.payments set status='approved', paid_at=now() where id=$1", [o1.order_id]);
  await as(db, service, c => call(c, 'deliver_order', [o1.order_id]));
  // u2: cortesia MANUAL antiga concedida pelo administrador
  await as(db, user(adm), c => call(c, 'admin_grant_entitlement', [u2, 'qr_custom', e2, 'cortesia antiga por e-mail']));
  // u3: pedido PENDENTE de Pix por chave própria (modelo antigo)
  const o3 = await as(db, service, c => call(c, 'create_order', [u3, 'qr_custom', e3, null, 'pix_manual']));
  // cupom antigo com um resgate (u4)
  await db.pool.query("insert into public.coupons(code,kind,value,per_user_limit,active,note) values ('OLD10','percent',10,2,true,'cupom antigo')");
  const o4 = await as(db, service, c => call(c, 'create_order', [u4, 'qr_custom', e4, 'OLD10', 'mercadopago']));
  S = { adm, u1, u2, u3, u4, e1, e2, e3, e4, o1, o3, o4 };
  const n = async t => (await q(db.pool, `select count(*)::int n from public.${t}`))[0].n;
  S.before = { payments: await n('payments'), coupons: await n('coupons'), redemptions: await n('coupon_redemptions'), entitlements: await n('entitlements'), experiences: await n('experiences'), profiles: await n('profiles'), events: await n('payment_events') };
  for (const f of H.MIGRATIONS) await db.apply(f);                 // ATUALIZAÇÃO
  S.n = n;
});
after(async () => { if (db) await db.drop(); });
const t = (name, fn) => test(name, async ctx => { if (skipWhy) return ctx.skip('BLOQUEADO: ' + skipWhy); await fn(ctx); });

t('nenhum registro existente é apagado (pedidos, cupons, resgates, liberações, experiências, usuários, eventos)', async () => {
  for (const [tbl, b] of Object.entries({ payments: S.before.payments, redemptions: S.before.redemptions, entitlements: S.before.entitlements, experiences: S.before.experiences, profiles: S.before.profiles, events: S.before.events })) {
    const name = tbl === 'redemptions' ? 'coupon_redemptions' : tbl === 'events' ? 'payment_events' : tbl;
    assert.ok((await S.n(name)) >= b, name + ' perdeu linhas');
  }
  assert.equal(await S.n('coupons'), S.before.coupons + 1, 'só o AMORIA1 foi acrescentado');
});
t('quem já pagou o QR personalizado continua com o direito (e passa a poder baixar o padrão também)', async () => {
  assert.deepEqual(await as(db, user(S.u1), c => call(c, 'my_download_access', [S.e1])), { normal: true, custom: true });
});
t('cortesia manual antiga já concedida continua valendo (benefício existente não é retirado), mas novas concessões estão desativadas', async () => {
  assert.deepEqual(await as(db, user(S.u2), c => call(c, 'my_download_access', [S.e2])), { normal: true, custom: true });
  await assert.rejects(db.pool.query("select public.admin_grant_entitlement($1,'qr_custom',$2,'nova cortesia',null,1)", [S.u2, S.e2]), /Cortesia manual desativada/);
});
t('pedido pendente de Pix manual antigo continua registrado, não libera nada e não impede nova compra pelo Mercado Pago', async () => {
  const [p] = await q(db.pool, 'select provider,status from public.payments where id=$1', [S.o3.order_id]); assert.deepEqual(p, { provider: 'pix_manual', status: 'pending' });
  assert.deepEqual(await as(db, user(S.u3), c => call(c, 'my_download_access', [S.e3])), { normal: false, custom: false });
  await assert.rejects(as(db, user(adm()), c => call(c, 'admin_confirm_manual_payment', [S.o3.order_id])), /permission denied/);
  await db.pool.query("update public.payments set status='cancelled' where id=$1", [S.o3.order_id]);       // o painel cancela pedidos antigos assim
  const nova = await as(db, service, c => call(c, 'create_order', [S.u3, 'qr_normal', S.e3, null, 'mercadopago'])); assert.equal(nova.free, false);
});
t('cupom antigo continua funcionando com os usos já registrados; QR padrão ganha preço e AMORIA1 existe', async () => {
  const quote = await as(db, user(S.u4), c => call(c, 'quote_product', ['qr_custom', 'OLD10']));
  assert.equal(quote.coupon_error, null); assert.ok(quote.coupon_discount_cents > 0);
  const [{ n }] = await q(db.pool, "select count(*)::int n from public.coupon_redemptions r join public.coupons c on c.id=r.coupon_id where c.code='OLD10'"); assert.equal(n, 1);
  const prod = Object.fromEntries((await q(db.pool, 'select code,price_cents,active from public.products')).map(x => [x.code, x]));
  assert.ok(prod.qr_normal.active && prod.qr_normal.price_cents > 0); assert.equal(prod.publish_experience.active, false);
  assert.equal((await q(db.pool, "select count(*)::int n from public.coupons where code='AMORIA1' and per_user_limit=3 and active"))[0].n, 1);
});
t('preço que o administrador já tinha configurado para o QR personalizado é mantido', async () => {
  const base = await H.createDb({ files: [H.STUB, ...H.LEGACY] });
  try {
    const adm2 = await H.addUser(base, 'a@a.com'); await H.makePrimaryAdmin(base, adm2);
    const [p] = await q(base.pool, "select id,name,description from public.products where code='qr_custom'");
    await as(base, user(adm2), c => call(c, 'admin_product_save', [JSON.stringify({ id: p.id, name: p.name, description: p.description, price_cents: 1234, active: true, lock_stage: 'download' })]));
    for (const f of H.MIGRATIONS) await base.apply(f);
    assert.equal((await q(base.pool, "select price_cents from public.products where code='qr_custom'"))[0].price_cents, 1234);
  } finally { await base.drop(); }
});
function adm() { return S.adm; }
