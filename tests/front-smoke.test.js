// Teste de fumaça das telas (DOM simulado): nenhum erro de execução ao percorrer os fluxos principais com o código real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('./helpers/dom');
const why = D.available();
const t = (name, fn) => test(name, async ctx => { if (why) return ctx.skip('BLOQUEADO: ' + why); await fn(ctx); });
const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'ana@teste.com' };
const EXP = { id: '22222222-2222-2222-2222-222222222222', slug: 'abcd1234efgh', title: 'Para você', at: null, views: 3, last_view: null, qr_custom_paid: false, paid: false, created_at: '2026-10-01T00:00:00Z',
  content: { to: 'Maria', from: 'Ana', type: 'declaracao', theme: 'classic', photos: [], videos: [], qrCustom: false }, pub: 'P.e30' };
const PRICES = { qr_normal: { cents: 299, original_cents: 299, name: 'QR Code padrão' }, qr_custom: { cents: 699, original_cents: 699, name: 'QR Code personalizado' } };
const FETCH = { '/.netlify/functions/create-payment': { enabled: true, courtesy: true, methods: { mercadopago: true, own_key: false }, prices: PRICES } };
const base = (extra = {}) => D.boot({ user: USER, tables: { experiences: [EXP] }, fetchMap: FETCH, ...extra });

t('sem login: abre a tela de entrada, sem erros', async () => {
  const a = D.boot({ user: null, fetchMap: FETCH }); await a.tick(150);
  assert.match(a.w.location.hash, /entrar/); assert.ok(a.$('input[type=email], #em, input[name=email]') || /Entrar|e-mail/i.test(a.text()));
  assert.deepEqual(a.errors, []);
});
t('página inicial: texto comercial novo (criar/publicar grátis; download do QR pago ou por código), sem promessas antigas', async () => {
  const a = base(); await a.tick(150); await a.go('#/');
  const tx = a.text(); assert.match(tx, /gratuit|grát/i); assert.doesNotMatch(tx, /QR Code padrão também é grátis|QR Code padrão são gratuitos/);
  assert.match(tx, /código de cortesia|Pix/); assert.deepEqual(a.errors, []);
});
t('editor: percorre todos os passos até Publicar sem erro; o passo Publicar não tem o editor antigo e explica o novo modelo', async () => {
  const a = base(); await a.tick(150); await a.go('#/criar');
  assert.ok(a.text().length > 50);
  for (let i = 0; i < 14 && !/Publicar/.test(a.$('h2,h3') ? a.text() : ''); i++) { const next = a.$$('[data-a]').find(b => /^(nx|next|ns)$/.test(b.dataset.a) || /Continuar|Próximo|Avançar/i.test(b.textContent)); if (!next) break; next.click(); await a.tick(40); if (/Estúdio de QR Codes/.test(a.text())) break; }
  assert.deepEqual(a.errors, [], a.errors.join('\n')); assert.doesNotMatch(a.html(), /id="qrfoto"|data-a="qr-model"|Adicionar QR Code personalizado/);
});
t('minhas experiências: lista com "Link e QR Code" e "Estúdio", sem aviso de QR não comprado', async () => {
  const a = base(); await a.tick(150); await a.go('#/minhas');
  assert.match(a.text(), /Minhas experiências/); assert.match(a.text(), /Publicada/); assert.match(a.html(), /Link e QR Code/); assert.match(a.html(), new RegExp('data-a="qse:' + EXP.id + '"')); assert.match(a.text(), /Estúdio de QR/); assert.doesNotMatch(a.text(), /não comprado/);
  assert.deepEqual(a.errors, []);
});
t('tela após publicar: link gratuito + botão para baixar o QR; nenhum QR baixável de graça na tela', async () => {
  const a = base(); await a.tick(150); a.w.eval(`done('https://amoria.example.test/#/amor/abcd1234efgh',{dbid:'${EXP.id}'})`); await a.tick(30);
  const h = a.html(); assert.match(a.text(), /grátis/); assert.match(h, /id="lk"/); assert.match(h, new RegExp('href="#/estudio/' + EXP.id + '"')); assert.match(h, /data-a="qrgo"/);
  assert.doesNotMatch(h, /id="qri"|id="dlq"|download=|Baixar QR Code em PNG|data-a="pps"|data-a="ppd"/); assert.equal(a.$$('canvas, img[src^="data:"]').length, 0, 'nenhuma imagem de QR liberada de graça');
  await a.click('[data-a="q:cp"]'); assert.deepEqual(a.errors, []);
});
t('Estúdio, aba Exportar BLOQUEADA: oferece "Liberar", sem botões de download; o código aparece só como um campo', async () => {
  const a = base({ rpc: { my_download_access: { normal: false, custom: false }, quote_product: a2 => ({ ok: true, product_code: a2.p_code, product_name: 'QR', original_cents: 299, promo_discount_cents: 0, coupon_discount_cents: 0, discount_cents: 0, final_cents: a2.p_code === 'qr_normal' ? 299 : 699, free: false, coupon_code: null, coupon_error: null }) } });
  await a.tick(150); await a.go('#/estudio/' + EXP.id); await a.tick(200);
  assert.deepEqual(a.errors, [], a.errors.join('\n')); assert.match(a.text(), /Estúdio de QR Codes/);
  await a.click('[data-a="qst:exp"]'); const h = a.html();
  assert.match(h, /qrbuy:qr_custom/); assert.match(h, /qrbuy:qr_normal/); assert.doesNotMatch(h, /qsxp:/);
  await a.click('[data-a="qrbuy:qr_normal"]'); await a.tick(100);
  assert.ok(a.$('#qr-coupon'), 'campo do código'); assert.match(a.text(), /R\$\s?2,99/); assert.match(a.$('#qr-pay-actions').innerHTML, /qr-buy:mercadopago/);
  assert.equal(a.$$('#qr-buybox input').length, 1); assert.doesNotMatch(a.text(), /AMORIA1/);
  assert.deepEqual(a.errors, [], a.errors.join('\n'));
});
t('Estúdio com código de cortesia válido: mostra "Liberar gratuitamente" e, após resgate, libera a aba Exportar', async () => {
  let granted = false;
  const a = base({ rpc: { my_download_access: () => granted ? { normal: true, custom: false } : { normal: false, custom: false },
    quote_product: p => p.p_coupon === 'AMORIA1' ? { ok: true, product_code: 'qr_normal', product_name: 'QR', original_cents: 299, promo_discount_cents: 0, coupon_discount_cents: 299, discount_cents: 299, final_cents: 0, free: true, coupon_code: 'AMORIA1', coupon_error: null }
      : { ok: true, product_code: 'qr_normal', product_name: 'QR', original_cents: 299, promo_discount_cents: 0, coupon_discount_cents: 0, discount_cents: 0, final_cents: 299, free: false, coupon_code: null, coupon_error: p.p_coupon ? 'Código inválido ou indisponível' : null } },
    fetchMap: { ...FETCH, '/.netlify/functions/create-payment': o => { const b = JSON.parse((o && o.body) || '{}'); if (!o || o.method !== 'POST') return FETCH['/.netlify/functions/create-payment']; granted = true; return { paid: true, free: true, orderId: 'o1' }; } } });
  await a.tick(150); await a.go('#/estudio/' + EXP.id); await a.tick(200); await a.click('[data-a="qst:exp"]'); await a.click('[data-a="qrbuy:qr_normal"]'); await a.tick(80);
  a.$('#qr-coupon').value = 'errado'; await a.click('[data-a="qr-coupon"]'); await a.tick(80); assert.match(a.text(), /Código inválido ou indisponível/);
  a.$('#qr-coupon').value = 'amoria1'; await a.click('[data-a="qr-coupon"]'); await a.tick(80);
  assert.match(a.$('#qr-pay-actions').innerHTML, /Liberar gratuitamente/); await a.click('[data-a="qr-buy:free"]'); await a.tick(250);
  const h = a.html(); assert.match(h, /qsxp:n-png/); assert.match(h, /qsxp:n-pdf/); assert.doesNotMatch(h, /qrbuy:qr_normal/); assert.match(h, /id="st-nxp"/);
  const post = a.calls.fetch.find(([u, o]) => o && o.method === 'POST'); const sent = JSON.parse(post[1].body);
  assert.equal(sent.product, 'qr_normal'); assert.equal(sent.expId, EXP.id); assert.equal(sent.coupon, 'AMORIA1'); assert.ok(!('amount' in sent) && !('price' in sent), 'o navegador nunca envia preço');
  assert.deepEqual(a.errors, [], a.errors.join('\n'));
});
t('painel administrativo: abas carregam sem erro e não existe liberação manual nem confirmação manual na interface', async () => {
  const sys = { migrations: [{ id: '20261101_001' }, { id: '20261101_002' }, { id: '20261101_003' }], tables_without_rls: [], primary_admin_configured: true, admins: 1, publish_is_free: true, manual_grants_disabled: true, products: [], amoria1: { active: true, per_user_limit: 3 }, pending_orders: 0, orders_not_delivered: 0 };
  const prods = [{ id: 'p1', code: 'qr_normal', name: 'QR Code padrão', price_cents: 299, active: true, wired: true, lock_stage: 'download' }, { id: 'p2', code: 'qr_custom', name: 'QR Code personalizado', price_cents: 699, active: true, wired: true, lock_stage: 'download' }, { id: 'p3', code: 'publish_experience', name: 'Publicar', price_cents: 0, active: false, wired: false, lock_stage: 'none' }];
  const cp = [{ id: 'c1', code: 'AMORIA1', kind: 'free', value: 0, product_codes: ['qr_normal', 'qr_custom'], max_uses: null, per_user_limit: 3, uses: 2, status: 'ativo', active: true, created_at: '2026-10-01T00:00:00Z' }];
  const a = D.boot({ user: USER, tables: { experiences: [EXP], profiles: [{ id: USER.id, role: 'admin' }] }, fetchMap: { ...FETCH, '/.netlify/functions/admin-status': { variaveis: { MP_ACCESS_TOKEN: 'ok' }, mercadopago: { valido: true }, webhook_url: 'x' } },
    rpc: { is_primary_admin: true, is_admin: true, admin_overview: { users: 5, blocked: 0, experiences: 9, views: 20, views7: 4, paid: 1, revenue: 299, free_unlocks: 2, downloads: 3, codes_active: 1 }, admin_system_status: sys, admin_products_list: prods, admin_coupons_list: cp, admin_coupon_history: [], admin_payment_settings_get: { mp_enabled: true }, admin_users: [], admin_experiences: [], admin_orders: [], admin_qr_payments: [], admin_audit_log: [], admin_ai_settings_get: {} } });
  await a.tick(200); await a.go('#/admin'); await a.tick(200);
  const tabs = a.$$('[data-a^="at:"], [data-a="at"]').map(b => b.dataset.a); assert.ok(tabs.length >= 5, 'abas do painel: ' + tabs.join(','));
  for (const tb of tabs) { await a.click('[data-a="' + tb + '"]'); await a.tick(120); }
  const all = a.html() + a.text(); assert.doesNotMatch(all, /Conceder cortesia|Confirmar recebimento|ctgrant|pxc:/);
  assert.deepEqual(a.errors, [], a.errors.join('\n'));
});
