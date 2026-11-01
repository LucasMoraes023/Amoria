// Testes locais do Pix direto AMORIA. Executar com: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { crc16, buildPixPayload, checkPixPayload, ascii } = require('../netlify/lib/pix');

test('CRC16-CCITT confere com o vetor padrão', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('gera payload Pix com chave, valor e TXID', () => {
  const p = buildPixPayload({ key: 'loja@exemplo.com', name: 'Loja São João', city: 'São Paulo', amountCents: 699, txid: 'AMR123456' });
  assert.equal(checkPixPayload(p), true);
  assert.match(p, /BR\.GOV\.BCB\.PIX/);
  assert.match(p, /loja@exemplo\.com/);
  assert.match(p, /06\.99/);
  assert.match(p, /AMR123456/);
});

test('normaliza nome e cidade conforme BR Code', () => {
  assert.equal(ascii('São João d’Ávila',25), 'SAO JOAO D AVILA');
  assert.equal(ascii('Belém',15), 'BELEM');
});

test('rejeita valores e dados do recebedor inválidos', () => {
  assert.throws(() => buildPixPayload({ key:'x',name:'',city:'Belém',amountCents:100,txid:'x' }));
  assert.throws(() => buildPixPayload({ key:'x',name:'Loja',city:'',amountCents:100,txid:'x' }));
  assert.throws(() => buildPixPayload({ key:'x',name:'Loja',city:'Belém',amountCents:0,txid:'x' }));
  assert.throws(() => buildPixPayload({ key:'x',name:'Loja',city:'Belém',amountCents:1.5,txid:'x' }));
});

test('detecta payload adulterado e CRC incorreto', () => {
  const p = buildPixPayload({ key:'loja@exemplo.com',name:'Loja',city:'Belem',amountCents:100,txid:'TESTE' });
  assert.equal(checkPixPayload(p),true);
  assert.equal(checkPixPayload(p.replace('01.00','02.00')),false);
  assert.equal(checkPixPayload(p.slice(0,-1)+'0'),false);
  assert.equal(checkPixPayload(''),false);
});

test('módulos serverless carregam e exportam handlers', () => {
  const create = require('../netlify/functions/create-payment');
  const config = require('../netlify/functions/payment-config');
  assert.equal(typeof create.handler,'function');
  assert.equal(typeof config.handler,'function');
});

test('backend compartilhado não contém dependências Mercado Pago', () => {
  const fs = require('node:fs');
  const payments = fs.readFileSync(require.resolve('../netlify/lib/payments'),'utf8');
  const checkout = fs.readFileSync(require.resolve('../netlify/functions/create-payment'),'utf8');
  const config = fs.readFileSync(require.resolve('../netlify/functions/payment-config'),'utf8');
  assert.doesNotMatch(payments,/mercadopago|MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|api\.mercadopago\.com/i);
  assert.doesNotMatch(checkout,/mercadopago|MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|api\.mercadopago\.com/i);
  assert.doesNotMatch(config,/mercadopago|MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|api\.mercadopago\.com/i);
});
