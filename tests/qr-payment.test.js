const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const lines = html.split('\n');
const sourceLine = prefix => {
  const line = lines.find(value => value.startsWith(prefix));
  assert.ok(line, `Missing source function: ${prefix}`);
  return line;
};
const expId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function createDownloadRequest({ paid, authenticated = true, experience = true }) {
  const events = { calls: [], downloaded: [], paywall: [], messages: [], location: { hash: '' } };
  const run = new Function('events', `
    const D2 = ${experience ? JSON.stringify({ dbid: expId }) : 'null'};
    const SB = ${authenticated ? '{}' : 'null'};
    const U = ${authenticated ? '{}' : 'null'};
    let GO = '';
    const location = events.location;
    const toast = message => events.messages.push(message);
    const payCall = async body => { events.calls.push(body); return { paid: ${paid} }; };
    const buyScreen = async product => events.paywall.push(product);
    const downloadQrArtifact = async (product, format) => events.downloaded.push({ product, format });
    ${sourceLine('async function requestQrDownload(')}
    return requestQrDownload;
  `)(events);
  return { events, run };
}

test('QR download checks server entitlement before generating the artifact', async () => {
  const { events, run } = createDownloadRequest({ paid: true });

  await run('qr_standard', 'jpg');

  assert.deepEqual(events.calls, [{ product: 'qr_standard', expId, action: 'status' }]);
  assert.deepEqual(events.downloaded, [{ product: 'qr_standard', format: 'jpg' }]);
  assert.deepEqual(events.paywall, []);
});

test('QR download opens checkout when the server reports no entitlement', async () => {
  const { events, run } = createDownloadRequest({ paid: false });

  await run('qr_custom', 'pdf');

  assert.deepEqual(events.calls, [{ product: 'qr_custom', expId, action: 'status' }]);
  assert.deepEqual(events.paywall, ['qr_custom']);
  assert.deepEqual(events.downloaded, []);
});

test('QR download requires sign-in and a published experience', async () => {
  const anonymous = createDownloadRequest({ paid: false, authenticated: false });
  await anonymous.run('qr_standard', 'png');
  assert.equal(anonymous.events.location.hash, '#/entrar');
  assert.deepEqual(anonymous.events.calls, []);

  const draft = createDownloadRequest({ paid: false, experience: false });
  await draft.run('qr_standard', 'png');
  assert.deepEqual(draft.events.calls, []);
  assert.match(draft.events.messages[0], /Publique a experiência gratuitamente/);
});

test('download controls do not expose a direct file URL or download attribute', () => {
  assert.match(sourceLine('async function qrShow('), /removeAttribute\('download'\)/);
  assert.match(sourceLine('async function qrShow('), /dataset\.a='qr-download:'\+product/);
  assert.match(sourceLine('async function downloadQrArtifact('), /saveBlob/);
  assert.match(html, /case'qr-download':e\.preventDefault\(\);requestQrDownload\(p,'png'\)/);
  assert.match(html, /case'qr-jpg':e\.preventDefault\(\);requestQrDownload\(p,'jpg'\)/);
});

test('QR Studio checks backend entitlement for standard and custom exports', () => {
  const source = sourceLine('async function studioExport(');
  assert.match(source, /kind==='plain'\?'qr_standard':'qr_custom'/);
  assert.ok(source.indexOf('await payCall(') < source.indexOf("if(kind==='plain')"));
  assert.match(source, /action:'status'/);
});

test('admin access screen is code-based and shows redemption history instead of manual grants', () => {
  assert.match(html, /const tabs=\[\['pd','Produtos'\],\['cp','Códigos'\],\['rd','Resgates'\]\]/);
  assert.match(html, /SB\.rpc\('admin_coupon_redemptions',\{p_coupon:null\}\)/);
});

test('standard and custom QR prices are independent products in the catalog', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/catalog-access-module.sql'), 'utf8');
  assert.match(sql, /values \('qr_standard','Download do QR Code'/);
  assert.match(sql, /values \('qr_custom','QR Code personalizado'/);
  assert.match(sql, /values\('AMORIA1','free',0,array\['qr_standard','qr_custom','publish_experience'\]/);
  assert.match(sql, /max_uses=null,per_user_limit=3,starts_at=null,ends_at=null/);
  assert.match(sql, /O preço dos downloads de QR deve ser de pelo menos R\$ 1,00/);
});
