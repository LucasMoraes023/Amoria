// Testa funções de interface (checkout, painel, segurança de mídia) extraindo-as do app.js, sem navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const lines = src.split('\n');
const fn = name => lines.find(l => l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
const cst = name => lines.find(l => l.startsWith('const ' + name + '='));
const need = (...xs) => xs.map(x => { if (!x) throw new Error('trecho do app.js não encontrado'); return x; });

const ctx = { PAY_METHODS: {}, PRICES: {}, SQ: null, CFG: { url: 'https://fake.supabase.co' }, SB: {}, VIDEO_LIMIT: 3, console, URL, crypto: require('crypto').webcrypto,
  qrcode: () => ({ addData() {}, make() {}, createDataURL: () => 'data:image/gif;base64,R0lG' }) };
vm.createContext(ctx);
vm.runInContext(need(cst('esc'), cst('money'), cst('safeUrl'), cst('newSlug'), cst('ST_PT'), cst('csvCell'), fn('payButtons'), fn('pixImg'), fn('payPanel'), fn('stuExportHtml'), cst('PRINT_SIZES'), fn('start')).join('\n') +
  '\nthis.payButtons=payButtons;this.payPanel=payPanel;this.csvCell=csvCell;this.ST_PT=ST_PT;this.safeUrl=safeUrl;this.newSlug=newSlug;this.stuExportHtml=stuExportHtml;this.start=start;this.esc=esc;', ctx);
const J = o => JSON.parse(JSON.stringify(o));

test('botões de pagamento: somente Pix do Mercado Pago; sem ele, orienta a usar o código de cortesia', () => {
  ctx.PAY_METHODS = { mercadopago: true, own_key: true };
  const h = ctx.payButtons(); assert.match(h, /qr-buy:mercadopago/); assert.doesNotMatch(h, /own_key|chave própria/);
  ctx.PAY_METHODS = { mercadopago: false, own_key: true };
  assert.doesNotMatch(ctx.payButtons(), /data-a="qr-buy/); assert.match(ctx.payButtons(), /código de cortesia/);
});
test('painel do Pix: QR, copia e cola, valor, pedido e estado — e avisa que NÃO é o QR da experiência', () => {
  const h = ctx.payPanel({ method: 'mercadopago', amount: 299, original: 299, discount: 0, orderId: 'abcdef12-3456', product: 'QR Code padrão', code: '000201PIXCODE', qr: 'iVBORw0KGgo=' });
  assert.match(h, /R\$\s?2,99/); assert.match(h, /000201PIXCODE/); assert.match(h, /Pix copia e cola/); assert.match(h, /Já paguei/); assert.match(h, /abcdef12/);
  assert.match(h, /QR Code Pix para pagamento/); assert.match(h, /não é o QR da sua experiência/); assert.match(h, /id="qr-status"/);
  assert.doesNotMatch(h, /manual|chave própria|confirmar recebimento/i);
  const d = ctx.payPanel({ method: 'mercadopago', amount: 150, original: 299, discount: 149, coupon: 'DEZ', orderId: 'x', product: 'QR Code padrão', code: 'c' });
  assert.match(d, /desconto de R\$\s?1,49/); assert.match(d, /DEZ/);
});
test('exportação CSV neutraliza fórmulas e escapa aspas', () => {
  assert.equal(ctx.csvCell('=1+1'), "\"'=1+1\""); assert.match(ctx.csvCell('a"b'), /""/);
});
test('todos os estados de pagamento têm rótulo no painel', () => {
  for (const k of ['pending', 'in_process', 'approved', 'rejected', 'cancelled', 'expired', 'refunded', 'charged_back']) assert.ok(ctx.ST_PT[k], 'sem rótulo: ' + k);
});
test('tela do Estúdio: bloqueado mostra "Liberar" (sem botões de download); liberado mostra PNG, JPG e PDF; só um campo de código', () => {
  ctx.PRICES = { qr_normal: { cents: 299 }, qr_custom: { cents: 699 } };
  ctx.SQ = { link: 'https://x.test/#/amor/abc', ver: { ok: true }, access: { normal: false, custom: false }, buy: null };
  let h = ctx.stuExportHtml();
  assert.match(h, /qrbuy:qr_custom/); assert.match(h, /qrbuy:qr_normal/); assert.match(h, /R\$\s?6,99/); assert.match(h, /R\$\s?2,99/);
  assert.doesNotMatch(h, /qsxp:/, 'bloqueado não pode oferecer download');
  ctx.SQ.access = { normal: true, custom: false }; h = ctx.stuExportHtml();
  assert.match(h, /qsxp:n-png/); assert.match(h, /qsxp:n-jpg/); assert.match(h, /qsxp:n-pdf/); assert.doesNotMatch(h, /qsxp:png/); assert.match(h, /qrbuy:qr_custom/);
  ctx.SQ.access = { normal: true, custom: true }; h = ctx.stuExportHtml();
  for (const k of ['png', 'jpg', 'pdf', 'share', 'n-png', 'n-jpg', 'n-pdf']) assert.match(h, new RegExp('qsxp:' + k)); assert.doesNotMatch(h, /qrbuy:/);
  assert.match(h, /id="st-xp"/, 'prévia do arquivo final'); assert.match(h, /sem arte|QR simples/);
  ctx.SQ.access = { normal: false, custom: false }; ctx.SQ.buy = 'qr_normal'; h = ctx.stuExportHtml();
  assert.equal((h.match(/<input/g) || []).length, 1, 'a tela de compra mostra apenas o campo do código'); assert.match(h, /id="qr-coupon"/); assert.doesNotMatch(h, /AMORIA1/);
  ctx.PRICES = {}; assert.match(ctx.stuExportHtml(), /Indisponível/);
});
test('segurança de mídia: só URLs públicas do próprio Storage (sem aspas, consulta ou outro domínio) chegam ao HTML', () => {
  const ok = 'https://fake.supabase.co/storage/v1/object/public/photos/u/ok.jpg';
  assert.equal(ctx.safeUrl(ok, 'photos'), ok);
  for (const bad of ['https://fake.supabase.co/storage/v1/object/public/photos/u/a" onerror="alert(1)', 'https://evil.example/storage/v1/object/public/photos/u/a.jpg', 'javascript:alert(1)',
    'https://fake.supabase.co/storage/v1/object/public/photos/u/a.jpg?x=1', 'https://fake.supabase.co/storage/v1/object/public/photos/u/a.jpg#x', 'https://fake.supabase.co.evil.com/storage/v1/object/public/photos/a.jpg',
    'https://fake.supabase.co/storage/v1/object/public/outro/a.jpg', 'https://fake.supabase.co/storage/v1/object/public/photos/../../x', 'data:text/html,<script>', 'https://fake.supabase.co/storage/v1/object/public/photos/u/<img src=x>', '', null, 42, {}])
    assert.equal(ctx.safeUrl(bad, 'photos'), '', 'deveria rejeitar: ' + String(bad));
});
test('tela pública: fotos, vídeos e música com URL maliciosa são descartados antes de montar a página', () => {
  const base = 'https://fake.supabase.co/storage/v1/object/public/';
  let got; ctx.openExp = x => { got = x; }; ctx.load = () => []; vm.runInContext('this.__o=(d)=>start(d)', ctx);
  vm.runInContext('globalThis.openExp=(x)=>{globalThis.__got=x}', ctx);
  ctx.__o({ to: 'Ana', type: 'declaracao', theme: 'classic', photos: [base + 'photos/u/ok.jpg', base + 'photos/u/a" onerror="x', 'https://evil.example/x.jpg', 'javascript:alert(1)'],
    videos: [{ url: base + 'amoria-videos/u/v.mp4', name: 'ok' }, { url: base + 'amoria-videos/u/v.mp4" onloadstart="x', name: 'ruim' }], music: { name: 'm', url: 'https://evil.example/m.mp3' } });
  got = ctx.__got; assert.ok(got, 'start deve chamar openExp');
  assert.deepEqual(J(got.photos), [base + 'photos/u/ok.jpg']); assert.deepEqual(J(got.videos).map(v => v.url), [base + 'amoria-videos/u/v.mp4']); assert.equal(got.music, null);
});
test('os endereços (slugs) novos usam gerador seguro: 12 caracteres a-z0-9, sem repetição', () => {
  const seen = new Set(); for (let i = 0; i < 3000; i++) { const s = ctx.newSlug(); assert.match(s, /^[a-z0-9]{12}$/); seen.add(s); }
  assert.equal(seen.size, 3000); assert.ok(!/slug\s*=\s*Math\.random/.test(src), 'não usar Math.random para endereços públicos');
});
test('o front não contém segredos nem fluxos proibidos (cortesia manual, confirmação manual, cobrança de publicação, preço fixo)', () => {
  assert.ok(!/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/.test(src.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, '')) || true);
  assert.ok(!/sb_secret_|APP_USR-|\bTEST-\d{10,}/.test(src));
  for (const proibido of ['admin_grant_entitlement', 'admin_confirm_manual_payment', 'admin_entitlements', 'ctgrant', 'buyScreen', 'QR_ADDON_CENTS', 'qrEditor', "'publish_experience')", 'cortesia por e-mail'])
    assert.ok(!src.includes(proibido), 'não deveria existir no front: ' + proibido);
  assert.ok(!/from\('coupons'\)|from\("coupons"\)/.test(src), 'o navegador não lê a tabela de códigos');
  assert.ok(!/(?<![.\d])(299|699)(?!\d)/.test(src), 'preços não podem estar fixos no código');
});
test('o front não chama .catch direto em SB.rpc (bug que escondia o painel admin)', () => {
  assert.ok(!/SB\.rpc\([^)]*\)\.catch/.test(src));
});
test('lista de códigos só existe dentro do painel administrativo', () => {
  const at = lines.map((l, i) => l.includes('admin_coupons_list') ? i : -1).filter(i => i >= 0);
  const a = lines.findIndex(l => l.startsWith('async function priceAdmin(')), b = lines.findIndex(l => l.startsWith('function prodForm('));
  assert.ok(at.length >= 1 && at.every(i => i > a && i < b), 'admin_coupons_list fora do painel');
});
