// Testa as funções de interface do checkout e do painel extraindo-as do index.html (sem navegador).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const grab = name => {
  const m = src.match(new RegExp('^(async )?function ' + name + '\\([\\s\\S]*?^\\}|^(async )?function ' + name + '\\(.*\\{.*\\}$', 'm'));
  return m && m[0];
};
const lines = src.split('\n');
const fn = name => lines.find(l => l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
const pieces = ['esc', 'money'].map(n => lines.find(l => l.startsWith('const ' + n + '=')));
const code = [
  ...pieces,
  ...['payButtons', 'pixImg', 'payPanel'].map(fn),
  lines.find(l => l.startsWith('const ST_PT')),
  lines.find(l => l.startsWith('const csvCell'))
].join('\n');
const ctx = { PAY_METHODS: {}, qrcode: () => ({ addData() {}, make() {}, createDataURL: () => 'data:image/gif;base64,R0lG' }), console };
vm.createContext(ctx);
vm.runInContext(code + '\nthis.payButtons=payButtons;this.payPanel=payPanel;this.csvCell=csvCell;this.ST_PT=ST_PT;', ctx);

test('botões de pagamento seguem o único método Pix direto', () => {
  ctx.PAY_METHODS = { pix_manual: true };
  const pix = ctx.payButtons();
  assert.match(pix, /qr-buy:pix_manual/);
  assert.match(pix, /Pagar com Pix/);
  ctx.PAY_METHODS = {};
  assert.match(ctx.payButtons(), /Nenhuma forma de pagamento/);
});
test('painel Pix direto mostra QR, copia e cola, valor, pedido e confirmação manual', () => {
  const h = ctx.payPanel({ method: 'pix_manual', orderId: 'abcdef12-0000', amount: 699, code: '00020126ABC', recipient: '5511999999999', instructions: 'Pague agora' });
  assert.match(h, /R\$\s?6,99/); assert.match(h, /data:image\/gif/); assert.match(h, /00020126ABC/);
  assert.match(h, /qr-copy/); assert.match(h, /qr-check/); assert.match(h, /abcdef12/); assert.match(h, /conferido pelo administrador/);
  assert.match(h, /wa\.me\/5511999999999/);
});
test('painel de chave própria avisa que a conferência é manual e gera o QR localmente', () => {
  const h = ctx.payPanel({ method: 'pix_manual', orderId: 'x', amount: 699, code: '000201', recipient: 'LOJA <b>', instructions: 'Pague agora' });
  assert.match(h, /conferido pelo administrador/); assert.match(h, /data:image\/gif/);
  assert.ok(!h.includes('LOJA <b>') && h.includes('LOJA &lt;b&gt;'));
});
test('exportação CSV neutraliza fórmulas e escapa aspas', () => {
  assert.equal(ctx.csvCell('=1+1'), '"\'=1+1"');
  assert.equal(ctx.csvCell('a"b'), '"a""b"');
});
test('todos os estados exigidos têm rótulo no painel', () => {
  for (const k of ['pending', 'approved', 'expired', 'cancelled', 'rejected', 'in_process', 'refunded', 'error']) assert.ok(ctx.ST_PT[k], k);
});
test('o front não contém segredos: nenhum token do Mercado Pago nem chave JWT service_role', () => {
  const files = [html, fs.readFileSync(__dirname + '/../config.js', 'utf8')].join('\n');
  assert.ok(!/APP_USR-[0-9A-Za-z-]{10,}|TEST-[0-9a-f-]{20,}|sb_secret_/.test(files), 'token do Mercado Pago ou chave secreta no front');
  for (const t of files.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || []) {
    const role = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).role;
    assert.notEqual(role, 'service_role');
  }
});
test('o fluxo de autenticação tolera falha na verificação de admin sem quebrar o carregamento', () => {
  assert.match(html, /SB\.rpc\('is_primary_admin'\)\.catch\(\(\)=>\(\{data:false\}\)\)/);
});

test('salvamento cloud exige conteúdo público e preserva o pub existente como fallback', () => {
  assert.match(html, /select\('content,pub,paid,paid_at,qr_custom_paid'\)/);
  assert.match(html, /generatedPub=.*\?\.split\('~'\)\[0\]\|\|''/);
  assert.match(html, /body=generatedPub\|\|existing\?\.pub\|\|''/);
  assert.match(html, /data-pay-id=/);
});
test('painel ADM usa publicação paga separada do QR personalizado', () => {
  assert.match(html, /x\.pub_paid\?\?x\.paid/);
  assert.match(html, /x\.qr_custom_paid/);
});
test('histórico de pagamentos aceita product_code e registros legados com purpose', () => {
  assert.match(html, /p\.product_code\|\|p\.purpose/);
});
