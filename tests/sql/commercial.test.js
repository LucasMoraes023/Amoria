// Testes do modelo comercial executados no SQL REAL (PostgreSQL), com as migrações do projeto.
// Cobrem: publicação gratuita, preço único, código AMORIA1, limites, validade, revogação, simultaneidade,
// abuso por exclusão, pagamento (pendente/aprovado/estorno), liberação de download, RLS e permissões.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { as, user, service, anon, call, q } = H;

let db, skipWhy = '', adm;
before(async () => {
  skipWhy = await H.available();
  if (skipWhy) return;
  db = await H.createDb();
  adm = await H.addUser(db, 'admin@teste.com');
  await H.makePrimaryAdmin(db, adm);
});
after(async () => { if (db) await db.drop(); });
const t = (name, fn) => test(name, async ctx => { if (skipWhy) return ctx.skip('BLOQUEADO: ' + skipWhy); await fn(ctx); });

const saveCode = p => as(db, user(adm), c => call(c, 'admin_coupon_save', [JSON.stringify(p)]));
const quote = (u, code, coupon) => as(db, user(u), c => call(c, 'quote_product', [code, coupon || null]));
const order = (u, code, exp, coupon, prov) => as(db, service, c => call(c, 'create_order', [u, code, exp, coupon || null, prov || (coupon ? 'free' : 'mercadopago')]));
const access = (u, exp) => as(db, user(u), c => call(c, 'my_download_access', [exp]));
const newUserWithExps = async n => { const u = await H.addUser(db); const e = []; for (let i = 0; i < n; i++) e.push(await H.addExperience(db, u)); return { u, e }; };

// ---------- instalação e migrações ----------
t('instalação nova: a cadeia completa aplica e as 3 migrações ficam registradas', async () => {
  const rows = await q(db.pool, 'select id from public.app_migrations order by id');
  assert.deepEqual(rows.map(r => r.id), ['20261101_001', '20261101_002', '20261101_003']);
});
t('migrações novas são idempotentes: reaplicar não falha, não duplica e não desfaz ajustes do admin', async () => {
  await db.pool.query("update public.coupons set note='ajuste do admin' where code='AMORIA1'");
  for (const f of H.MIGRATIONS) await db.apply(f);
  assert.equal((await q(db.pool, 'select count(*)::int n from public.app_migrations'))[0].n, 3);
  assert.equal((await q(db.pool, "select count(*)::int n from public.coupons where code='AMORIA1'"))[0].n, 1);
  assert.equal((await q(db.pool, "select note from public.coupons where code='AMORIA1'"))[0].note, 'ajuste do admin');
});

t('migração 001 em um banco sem os módulos anteriores: recusa com instrução clara e não cria nada pela metade', async () => {
  const vazio = await H.createDb({ files: [H.STUB] });
  try {
    await assert.rejects(vazio.apply(H.MIGRATIONS[0]), /Faltam tabelas de módulos anteriores .*schema\.sql/s);
    assert.equal((await q(vazio.pool, "select to_regclass('public.app_migrations') as t"))[0].t, null, 'nada deve ter sido criado');
  } finally { await vazio.drop(); }
});

// ---------- modelo comercial: grátis x pago ----------
t('QR padrão e QR personalizado são vendáveis; publicar é inativo e gratuito', async () => {
  const by = Object.fromEntries((await q(db.pool, 'select code,price_cents,active,wired,lock_stage from public.products')).map(x => [x.code, x]));
  assert.ok(by.qr_normal.active && by.qr_normal.wired && by.qr_normal.price_cents > 0 && by.qr_normal.lock_stage === 'download');
  assert.ok(by.qr_custom.active && by.qr_custom.wired && by.qr_custom.lock_stage === 'download');
  assert.equal(by.publish_experience.active, false);
  assert.equal(by.publish_experience.price_cents, 0);
});
t('mesmo forçando por SQL, a publicação não pode ser cobrada', async () => {
  await db.pool.query("update public.products set active=true, price_cents=999, wired=true, lock_stage='publish' where code='publish_experience'");
  const [p] = await q(db.pool, "select active,price_cents,wired,lock_stage from public.products where code='publish_experience'");
  assert.deepEqual(p, { active: false, price_cents: 0, wired: false, lock_stage: 'none' });
});
t('o painel não consegue ativar cobrança de publicação nem de outras etapas', async () => {
  const [pub] = await q(db.pool, "select id from public.products where code='publish_experience'");
  await assert.rejects(as(db, user(adm), c => call(c, 'admin_product_save', [JSON.stringify({ id: pub.id, name: 'Publicar', price_cents: 500, active: true, lock_stage: 'none' })])), /sempre gratuito/);
  await assert.rejects(as(db, user(adm), c => call(c, 'admin_product_save', [JSON.stringify({ code: 'extra_ia', name: 'Extra', price_cents: 100, active: true, lock_stage: 'publish' })])), /Só o download/);
});
t('usuário cria e publica várias experiências sem pagar nada (e o link continua abrindo)', async () => {
  const { u, e } = await newUserWithExps(8);
  assert.equal(e.length, 8);
  assert.equal((await q(db.pool, 'select count(*)::int n from public.payments where user_id=$1', [u]))[0].n, 0);
  const [{ slug }] = await q(db.pool, 'select slug from public.experiences where id=$1', [e[0]]);
  const pub = await as(db, anon, c => call(c, 'get_experience', [slug]));
  assert.ok(pub && pub.pub, 'link público deve responder para visitantes sem login');
});
t('fonte única de preços: mudar o preço em products vale para o catálogo e para a cotação; settings não interfere', async () => {
  const { u } = await newUserWithExps(0);
  const [qn] = await q(db.pool, "select id,name,description from public.products where code='qr_normal'");
  await as(db, user(adm), c => call(c, 'admin_product_save', [JSON.stringify({ id: qn.id, name: qn.name, description: qn.description, price_cents: 499, active: true })]));
  const cat = await as(db, anon, c => call(c, 'get_catalog'));
  assert.equal(cat.find(x => x.code === 'qr_normal').current_cents, 499);
  assert.equal((await quote(u, 'qr_normal')).final_cents, 499);
  assert.ok(!cat.some(x => x.code === 'publish_experience'));
  await as(db, user(adm), c => call(c, 'admin_save_settings', ['{}', JSON.stringify({ qr_custom_cents: 12345 })]));
  assert.equal((await quote(u, 'qr_custom')).final_cents, (await q(db.pool, "select price_cents from public.products where code='qr_custom'"))[0].price_cents);
  await as(db, user(adm), c => call(c, 'admin_product_save', [JSON.stringify({ id: qn.id, name: qn.name, description: qn.description, price_cents: 299, active: true })]));
});

t('link público: conteúdo malformado não gera erro e visitante sem login não vê dados do dono', async () => {
  const { u } = await newUserWithExps(0);
  const e = await H.addExperience(db, u, { pub: 'P.@@@@' });
  const [{ slug }] = await q(db.pool, 'select slug from public.experiences where id=$1', [e]);
  const r = await as(db, anon, c => call(c, 'get_experience', [slug]));
  assert.deepEqual(Object.keys(r), ['pub']);
  assert.equal(await as(db, anon, c => call(c, 'get_experience', ['naoexiste1'])), null);
});

// ---------- código AMORIA1 ----------
t('AMORIA1 existe: cortesia, ativo, 3 usos por pessoa, sem limite total, QR padrão e personalizado', async () => {
  const [c] = await q(db.pool, "select kind,per_user_limit,max_uses,active,product_codes,revoked_at from public.coupons where code='AMORIA1'");
  assert.equal(c.kind, 'free'); assert.equal(c.per_user_limit, 3); assert.equal(c.max_uses, null); assert.equal(c.active, true); assert.equal(c.revoked_at, null);
  assert.deepEqual([...c.product_codes].sort(), ['qr_custom', 'qr_normal']);
});
t('AMORIA1: 3 liberações por usuário (misturando QR padrão e personalizado) e a 4ª é recusada', async () => {
  const { u, e } = await newUserWithExps(4);
  const a = await order(u, 'qr_normal', e[0], 'AMORIA1');
  const b = await order(u, 'qr_custom', e[1], 'AMORIA1');
  const c3 = await order(u, 'qr_normal', e[2], 'AMORIA1');
  assert.ok(a.free && b.free && c3.free);
  await assert.rejects(order(u, 'qr_normal', e[3], 'AMORIA1'), /máximo de vezes/);
  assert.equal((await q(db.pool, "select count(*)::int n from public.coupon_redemptions r join public.coupons c on c.id=r.coupon_id where c.code='AMORIA1' and r.user_id=$1", [u]))[0].n, 3);
  assert.deepEqual(await access(u, e[0]), { normal: true, custom: false });
  assert.deepEqual(await access(u, e[1]), { normal: true, custom: true });   // o personalizado inclui o padrão
  assert.deepEqual(await access(u, e[3]), { normal: false, custom: false });
  const [{ n }] = await q(db.pool, "select count(*)::int n from public.entitlements where user_id=$1 and source='coupon'", [u]);
  assert.equal(n, 3);
  const other = await newUserWithExps(1);                                   // outro usuário não é afetado
  assert.ok((await order(other.u, 'qr_normal', other.e[0], 'AMORIA1')).free);
});
t('AMORIA1 é registrado corretamente: cada resgate guarda código, usuário, pedido e desconto', async () => {
  const { u, e } = await newUserWithExps(1);
  const o = await order(u, 'qr_normal', e[0], 'AMORIA1');
  const [r] = await q(db.pool, "select c.code, r.user_id, r.order_id, r.discount_cents, p.coupon_code, p.provider, p.status, p.amount_cents from public.coupon_redemptions r join public.coupons c on c.id=r.coupon_id join public.payments p on p.id=r.order_id where r.order_id=$1", [o.order_id]);
  assert.equal(r.code, 'AMORIA1'); assert.equal(r.user_id, u); assert.equal(r.coupon_code, 'AMORIA1');
  assert.equal(r.provider, 'free'); assert.equal(r.status, 'approved'); assert.equal(r.amount_cents, 0); assert.ok(r.discount_cents > 0);
});
t('AMORIA1 não é reaproveitado para o mesmo QR já liberado (não gasta um segundo uso)', async () => {
  const { u, e } = await newUserWithExps(1);
  await order(u, 'qr_normal', e[0], 'AMORIA1');
  await assert.rejects(order(u, 'qr_normal', e[0], 'AMORIA1'), /já está liberado/);
  assert.equal((await q(db.pool, "select count(*)::int n from public.coupon_redemptions where user_id=$1", [u]))[0].n, 1);
});
t('simultaneidade: 6 resgates em paralelo do mesmo usuário → exatamente 3 passam', async () => {
  const { u, e } = await newUserWithExps(6);
  const res = await Promise.allSettled(e.map(x => order(u, 'qr_normal', x, 'AMORIA1')));
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(res.filter(r => r.status === 'rejected' && /máximo de vezes/.test(r.reason.message)).length, 3);
  assert.equal((await q(db.pool, "select count(*)::int n from public.coupon_redemptions where user_id=$1", [u]))[0].n, 3);
});
t('simultaneidade: limite total do código nunca é ultrapassado por usuários diferentes', async () => {
  await saveCode({ code: 'CORRIDA1', kind: 'free', product_codes: ['qr_normal'], max_uses: 2, per_user_limit: 1 });
  const users = []; for (let i = 0; i < 5; i++) users.push(await newUserWithExps(1));
  const res = await Promise.allSettled(users.map(x => order(x.u, 'qr_normal', x.e[0], 'CORRIDA1')));
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal((await q(db.pool, "select count(*)::int n from public.coupon_redemptions r join public.coupons c on c.id=r.coupon_id where c.code='CORRIDA1'"))[0].n, 2);
});
t('abuso por exclusão: apagar as experiências NÃO devolve os usos do código', async () => {
  const { u, e } = await newUserWithExps(3);
  for (const x of e) await order(u, 'qr_normal', x, 'AMORIA1');
  for (const x of e) await as(db, user(u), c => c.query('delete from public.experiences where id=$1', [x]));
  const novo = await H.addExperience(db, u);
  await assert.rejects(order(u, 'qr_normal', novo, 'AMORIA1'), /máximo de vezes/);
  assert.equal((await q(db.pool, "select count(*)::int n from public.payments where user_id=$1 and coupon_code='AMORIA1'", [u]))[0].n, 3, 'o histórico dos pedidos deve ser preservado');
});
t('abuso por exclusão de conta: histórico financeiro é preservado (user_id vira nulo)', async () => {
  const { u, e } = await newUserWithExps(1);
  const o = await order(u, 'qr_normal', e[0], 'AMORIA1');
  await db.pool.query('delete from auth.users where id=$1', [u]);
  const [p] = await q(db.pool, 'select user_id, experience_id from public.payments where id=$1', [o.order_id]);
  assert.ok(p, 'o pedido não pode sumir'); assert.equal(p.user_id, null); assert.equal(p.experience_id, null);
});

// ---------- códigos: validade, revogação, produtos, mensagens ----------
t('código inválido, expirado, futuro, inativo, revogado ou de outro produto: mensagens sem vazar regras internas', async () => {
  const { u, e } = await newUserWithExps(1);
  const gen = 'Código inválido ou indisponível';
  assert.equal((await quote(u, 'qr_normal', 'NAOEXISTE')).coupon_error, gen);
  await saveCode({ code: 'EXPIRADO1', kind: 'free', product_codes: ['qr_normal'], per_user_limit: 1, ends_at: '2020-01-01T00:00:00Z' });
  assert.equal((await quote(u, 'qr_normal', 'EXPIRADO1')).coupon_error, 'Código expirado');
  await assert.rejects(order(u, 'qr_normal', e[0], 'EXPIRADO1'), /Código expirado/);
  await saveCode({ code: 'FUTURO1', kind: 'free', product_codes: ['qr_normal'], per_user_limit: 1, starts_at: '2099-01-01T00:00:00Z' });
  assert.equal((await quote(u, 'qr_normal', 'FUTURO1')).coupon_error, gen);
  await saveCode({ code: 'INATIVO1', kind: 'free', product_codes: ['qr_normal'], per_user_limit: 1, active: false });
  assert.equal((await quote(u, 'qr_normal', 'INATIVO1')).coupon_error, gen);
  await saveCode({ code: 'SOPADRAO', kind: 'free', product_codes: ['qr_normal'], per_user_limit: 1 });
  assert.equal((await quote(u, 'qr_custom', 'SOPADRAO')).coupon_error, gen);
  const r = await saveCode({ code: 'REVOGAR1', kind: 'free', product_codes: ['qr_normal'], per_user_limit: 1 });
  await as(db, user(adm), c => call(c, 'admin_coupon_revoke', [r.id, 'teste de revogação', false]));
  assert.equal((await quote(u, 'qr_normal', 'REVOGAR1')).coupon_error, gen);
  await assert.rejects(order(u, 'qr_normal', e[0], 'REVOGAR1'), /inválido ou indisponível/);
  const none = await quote(u, 'qr_normal', 'EXPIRADO1'); assert.ok(!('coupon_id' in none), 'a cotação do cliente não expõe ids internos');
});
t('limite total esgotado: o próximo usuário recebe "Código esgotado"', async () => {
  await saveCode({ code: 'UNICO1', kind: 'free', product_codes: ['qr_normal'], max_uses: 1, per_user_limit: 1 });
  const a = await newUserWithExps(1), b = await newUserWithExps(1);
  assert.ok((await order(a.u, 'qr_normal', a.e[0], 'UNICO1')).free);
  assert.equal((await quote(b.u, 'qr_normal', 'UNICO1')).coupon_error, 'Código esgotado');
  await assert.rejects(order(b.u, 'qr_normal', b.e[0], 'UNICO1'), /esgotado/);
});
t('código só funciona para produtos permitidos e cortesia exige produto explícito', async () => {
  await assert.rejects(saveCode({ code: 'SEMPROD1', kind: 'free', per_user_limit: 1 }), /ao menos um produto/);
  await assert.rejects(saveCode({ code: 'ab', kind: 'free', product_codes: ['qr_normal'] }), /Código inválido/);
  await assert.rejects(saveCode({ code: 'PRODFALSO', kind: 'free', product_codes: ['nao_existe'] }), /Produto desconhecido/);
  const r = await saveCode({ code: 'DESC50', kind: 'percent', value: 50, product_codes: ['qr_custom'], per_user_limit: 2 });
  const { u } = await newUserWithExps(0);
  const base = (await q(db.pool, "select price_cents from public.products where code='qr_custom'"))[0].price_cents;
  assert.equal((await quote(u, 'qr_custom', 'DESC50')).final_cents, base - Math.floor(base * 50 / 100));
  assert.ok(r.id);
});
t('proteção contra tentativas abusivas: após 8 códigos errados o usuário é bloqueado temporariamente (outros não)', async () => {
  const { u } = await newUserWithExps(0), other = await newUserWithExps(0);
  for (let i = 0; i < 8; i++) assert.equal((await quote(u.u ? u.u : u, 'qr_normal', 'CHUTE' + i)).coupon_error, 'Código inválido ou indisponível');
  const bloq = await quote(u.u ? u.u : u, 'qr_normal', 'CHUTE9');
  assert.match(bloq.coupon_error, /Muitas tentativas/);
  assert.match((await quote(u.u ? u.u : u, 'qr_normal', 'AMORIA1')).coupon_error, /Muitas tentativas/, 'nem o código certo passa durante o bloqueio');
  assert.equal((await quote(other.u, 'qr_normal', 'AMORIA1')).coupon_error, null);
});

// ---------- pagamento e liberação do download ----------
t('pagamento: pendente não libera; só aprovado libera; entrega é idempotente; estorno revoga; download registrado', async () => {
  const { u, e } = await newUserWithExps(1);
  const o = await order(u, 'qr_normal', e[0], null, 'mercadopago');
  assert.equal(o.free, false); assert.equal(o.status, 'pending');
  assert.deepEqual(await access(u, e[0]), { normal: false, custom: false });
  await assert.rejects(as(db, user(u), c => call(c, 'authorize_qr_download', [e[0], 'normal', 'png'])), /DOWNLOAD_NAO_LIBERADO/);
  await assert.rejects(as(db, service, c => call(c, 'deliver_order', [o.order_id])), /sem pagamento confirmado/);
  await db.pool.query("update public.payments set status='rejected' where id=$1", [o.order_id]);
  assert.deepEqual(await access(u, e[0]), { normal: false, custom: false }, 'recusado não libera');
  const o2 = await order(u, 'qr_normal', e[0], null, 'mercadopago');          // nova tentativa após recusa
  await db.pool.query("update public.payments set status='approved', paid_at=now() where id=$1", [o2.order_id]);
  assert.equal(await as(db, service, c => call(c, 'deliver_order', [o2.order_id])), true);
  assert.equal(await as(db, service, c => call(c, 'deliver_order', [o2.order_id])), false);
  assert.equal((await q(db.pool, 'select count(*)::int n from public.entitlements where order_id=$1', [o2.order_id]))[0].n, 1);
  assert.deepEqual(await access(u, e[0]), { normal: true, custom: false });
  for (const f of ['png', 'jpg', 'pdf']) await as(db, user(u), c => call(c, 'authorize_qr_download', [e[0], 'normal', f]));
  assert.equal((await q(db.pool, 'select count(*)::int n from public.qr_downloads where experience_id=$1', [e[0]]))[0].n, 3);
  await assert.rejects(as(db, user(u), c => call(c, 'authorize_qr_download', [e[0], 'custom', 'png'])), /DOWNLOAD_NAO_LIBERADO/);
  await assert.rejects(order(u, 'qr_normal', e[0], null, 'mercadopago'), /já está liberado/, 'não cobra duas vezes');
  await as(db, service, c => call(c, 'revoke_order', [o2.order_id, 'Estorno']));
  assert.deepEqual(await access(u, e[0]), { normal: false, custom: false });
  await assert.rejects(as(db, user(u), c => call(c, 'authorize_qr_download', [e[0], 'normal', 'png'])), /DOWNLOAD_NAO_LIBERADO/);
});
t('um usuário não consegue liberar nem baixar o QR de outro usuário', async () => {
  const a = await newUserWithExps(1), b = await newUserWithExps(1);
  await order(a.u, 'qr_normal', a.e[0], 'AMORIA1');
  assert.deepEqual(await access(b.u, a.e[0]), { normal: false, custom: false });
  await assert.rejects(as(db, user(b.u), c => call(c, 'authorize_qr_download', [a.e[0], 'normal', 'png'])), /Experiência não encontrada/);
  await assert.rejects(order(b.u, 'qr_normal', a.e[0], 'AMORIA1'), /Experiência não encontrada/);
});
t('contas bloqueadas não compram, não resgatam e não baixam', async () => {
  const { u, e } = await newUserWithExps(1);
  await order(u, 'qr_normal', e[0], 'AMORIA1');
  await db.pool.query('update public.profiles set blocked=true where id=$1', [u]);
  await assert.rejects(as(db, user(u), c => call(c, 'authorize_qr_download', [e[0], 'normal', 'png'])), /Conta bloqueada/);
  await assert.rejects(order(u, 'qr_custom', e[0], 'AMORIA1'), /Conta bloqueada/);
});

// ---------- cortesia somente por código; administração ----------
t('não existe cortesia manual nem confirmação manual: funções desativadas e sem permissão', async () => {
  const { u, e } = await newUserWithExps(1);
  await assert.rejects(db.pool.query("select public.admin_grant_entitlement($1,'qr_normal',$2,'teste de cortesia',null,1)", [u, e[0]]), /Cortesia manual desativada/);
  await assert.rejects(db.pool.query('select public.admin_confirm_manual_payment($1)', [H.uuid()]), /Confirmação manual desativada/);
  await assert.rejects(as(db, user(adm), c => call(c, 'admin_grant_entitlement', [u, 'qr_normal', e[0], 'teste de cortesia'])), /permission denied/);
  await assert.rejects(as(db, user(adm), c => call(c, 'admin_confirm_manual_payment', [H.uuid()])), /permission denied/);
  await assert.rejects(as(db, user(adm), c => call(c, 'admin_set_paid', [e[0], true])), /desativada/);
  assert.deepEqual(await access(u, e[0]), { normal: false, custom: false });
});
t('revogar código com cancelamento das liberações: acesso volta a ser bloqueado e o histórico fica registrado', async () => {
  const c0 = await saveCode({ code: 'CORT10', kind: 'free', product_codes: ['qr_normal', 'qr_custom'], max_uses: 5, per_user_limit: 2 });
  const { u, e } = await newUserWithExps(2);
  await order(u, 'qr_normal', e[0], 'CORT10');
  assert.equal((await access(u, e[0])).normal, true);
  const rv = await as(db, user(adm), c => call(c, 'admin_coupon_revoke', [c0.id, 'código vazou na internet', true]));
  assert.equal(rv.grants_revoked, 1);
  assert.equal((await access(u, e[0])).normal, false);
  const hist = await as(db, user(adm), c => call(c, 'admin_coupon_history', [c0.id]).then(() => c.query('select * from public.admin_coupon_history($1)', [c0.id]))).then(r => r.rows);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].coupon_code, 'CORT10'); assert.equal(hist[0].benefit_revoked, true); assert.equal(hist[0].order_status, 'cancelled');
  await assert.rejects(order(u, 'qr_normal', e[1], 'CORT10'), /inválido ou indisponível/);
  await assert.rejects(saveCode({ id: c0.id, code: 'CORT10', kind: 'free', product_codes: ['qr_normal'] }), /revogado/);
  const list = await as(db, user(adm), c => call(c, 'admin_coupons_list'));
  assert.equal(list.find(x => x.code === 'CORT10').status, 'revogado');
  assert.equal(list.find(x => x.code === 'AMORIA1').status, 'ativo');
});
t('o painel mostra o histórico de uso do AMORIA1 com usuário, produto e pedido', async () => {
  const rows = (await as(db, user(adm), c => c.query('select * from public.admin_coupon_history(null)'))).rows;
  assert.ok(rows.some(r => r.coupon_code === 'AMORIA1' && r.user_email && r.product_code && r.order_id));
});

// ---------- permissões e RLS ----------
t('anônimo e usuário comum não leem tabelas internas (códigos, resgates, limites, migrações, configurações, IA, admin)', async () => {
  const { u } = await newUserWithExps(0);
  for (const tbl of ['coupons', 'coupon_redemptions', 'rate_events', 'app_migrations', 'payment_settings', 'payment_events', 'ai_settings', 'ai_usage', 'admin_identity', 'admin_allowlist'])
    for (const who of [anon, user(u)])
      await assert.rejects(as(db, who, c => q(c, `select * from public.${tbl} limit 1`)), /permission denied/, `${tbl} como ${who.role}`);
});
t('usuário só enxerga as próprias liberações, pedidos e downloads; anônimo não vê nada', async () => {
  const a = await newUserWithExps(1), b = await newUserWithExps(1);
  const oa = await order(a.u, 'qr_normal', a.e[0], 'AMORIA1');
  await as(db, user(a.u), c => call(c, 'authorize_qr_download', [a.e[0], 'normal', 'png']));
  for (const tbl of ['entitlements', 'payments', 'qr_downloads']) {
    assert.ok((await as(db, user(a.u), c => q(c, `select 1 from public.${tbl}`))).length >= 1, tbl + ' do dono');
    assert.equal((await as(db, user(b.u), c => q(c, `select 1 from public.${tbl}`))).length, 0, tbl + ' de outro usuário deve ficar invisível');
  }
  assert.equal((await as(db, anon, c => q(c, 'select 1 from public.payments'))).length, 0);
  assert.equal((await as(db, anon, c => q(c, 'select 1 from public.experiences'))).length, 0);
  assert.ok(oa.order_id);
});
t('usuário comum não escreve em pagamentos/liberações e não consegue marcar o próprio QR como pago', async () => {
  const { u, e } = await newUserWithExps(1);
  await assert.rejects(as(db, user(u), c => c.query("insert into public.payments(user_id,amount_cents,provider,status) values ($1,0,'mercadopago','approved')", [u])), /permission denied/);
  await assert.rejects(as(db, user(u), c => c.query("insert into public.entitlements(user_id,product_code,source) values ($1,'qr_custom','payment')", [u])), /permission denied/);
  await as(db, user(u), c => c.query('update public.experiences set qr_custom_paid=true, paid=true where id=$1', [e[0]]));
  const [x] = await q(db.pool, 'select qr_custom_paid, paid from public.experiences where id=$1', [e[0]]);
  assert.deepEqual(x, { qr_custom_paid: false, paid: false });
  assert.deepEqual(await access(u, e[0]), { normal: false, custom: false });
  await assert.rejects(as(db, user(u), c => c.query("update public.profiles set role='admin' where id=$1", [u])), /permission denied|não pode ser alterada/);
});
t('funções internas (cotação, pedido, entrega, estorno, acesso) não são executáveis por anônimo/usuário', async () => {
  const { u, e } = await newUserWithExps(1);
  const bad = [['compute_quote', [u, 'qr_normal']], ['create_order', [u, 'qr_normal', e[0], null, 'free']], ['deliver_order', [H.uuid()]], ['revoke_order', [H.uuid(), 'x']], ['_download_access', [u, e[0]]]];
  for (const [fn, args] of bad) for (const who of [anon, user(u)]) await assert.rejects(as(db, who, c => call(c, fn, args)), /permission denied/, fn + ' como ' + who.role);
  await assert.rejects(as(db, anon, c => call(c, 'quote_product', ['qr_normal', null])), /permission denied/);
});
t('funções administrativas: só o administrador principal (nem usuário comum, nem admin secundário)', async () => {
  const { u } = await newUserWithExps(0);
  const second = await H.addUser(db, 'segundo@teste.com');
  await db.pool.query('insert into public.admin_allowlist(user_id) values ($1)', [second]);
  const fns = [['admin_coupons_list', []], ['admin_coupon_history', [null]], ['admin_products_list', []], ['admin_overview', []], ['admin_orders', [null, null, null, null]], ['admin_system_status', []], ['admin_payment_report', [null, null]], ['admin_audit_log', []], ['admin_entitlements', [null]]];
  for (const [fn, args] of fns) for (const who of [u, second])
    await assert.rejects(as(db, user(who), c => call(c, fn, args)), /forbidden/, fn);
  await assert.rejects(as(db, user(u), c => call(c, 'admin_coupon_save', [JSON.stringify({ code: 'HACK1', kind: 'free', product_codes: ['qr_normal'] })])), /forbidden/);
  await assert.rejects(as(db, user(second), c => call(c, 'admin_coupon_revoke', [H.uuid(), 'motivo qualquer', true])), /forbidden/);
  assert.ok(await as(db, user(adm), c => call(c, 'admin_overview')));
});
t('status do sistema: migrações registradas, todas as tabelas com RLS, publicação gratuita e AMORIA1 ativo', async () => {
  const s = await as(db, user(adm), c => call(c, 'admin_system_status'));
  assert.deepEqual(s.tables_without_rls, [], 'tabelas sem RLS: ' + s.tables_without_rls);
  assert.equal(s.publish_is_free, true); assert.equal(s.manual_grants_disabled, true);
  assert.equal(s.amoria1.active, true); assert.equal(s.amoria1.per_user_limit, 3);
  assert.deepEqual(s.migrations.map(m => m.id), ['20261101_001', '20261101_002', '20261101_003']);
  assert.ok(s.products.some(p => p.code === 'qr_normal') && s.products.some(p => p.code === 'qr_custom'));
});
t('visão geral e relatório: receita só conta dinheiro real; liberações gratuitas aparecem separadas', async () => {
  const ov = await as(db, user(adm), c => call(c, 'admin_overview'));
  const rep0 = await as(db, user(adm), c => call(c, 'admin_payment_report', [null, null]));
  assert.ok(ov.free_unlocks > 0); assert.ok(ov.downloads >= 0);
  assert.equal(ov.revenue, rep0.revenue_cents, 'visão geral e relatório devem concordar');
  const { u, e } = await newUserWithExps(1);
  const o = await order(u, 'qr_normal', e[0], null, 'mercadopago');
  await db.pool.query("update public.payments set status='approved', paid_at=now() where id=$1", [o.order_id]);
  await as(db, service, c => call(c, 'deliver_order', [o.order_id]));
  const ov2 = await as(db, user(adm), c => call(c, 'admin_overview'));
  assert.equal(ov2.revenue - ov.revenue, o.amount_cents); assert.equal(ov2.paid - ov.paid, 1);
  assert.ok(ov2.free_unlocks >= ov.free_unlocks);
  const rep = await as(db, user(adm), c => call(c, 'admin_payment_report', [null, null]));
  assert.equal(rep.revenue_cents - rep0.revenue_cents, o.amount_cents); assert.ok(rep.free_orders > 0);
});
