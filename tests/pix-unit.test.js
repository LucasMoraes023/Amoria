// Testes unitários (sem rede, sem banco): CRC16/BR Code do módulo lib/pix.js (reservado; o checkout atual usa só Mercado Pago)
// e verificação da assinatura oficial do webhook do Mercado Pago. Rodar: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { crc16, buildPixPayload, checkPixPayload } = require('../netlify/lib/pix');
const L = require('../netlify/lib/payments');

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
