// Testes do Estúdio de QR Codes e do download (código REAL do app.js, canvas real, leitor de QR independente).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const F = require('./helpers/front');

const why = F.available();
const t = (name, fn) => test(name, async ctx => { if (why) return ctx.skip('BLOQUEADO: ' + why); await fn(ctx); });
const LINK = 'https://amoria.example.test/#/amor/abcd1234efgh';
const hash = b => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');

t('o QR da arte é legível por um leitor independente em TODOS os modelos e temas', async () => {
  const f = F.makeContext(); const models = f.call('Object.keys(STU_MODELS)'), themes = f.call('Object.keys(STU_THEMES)');
  assert.ok(models.length >= 12 && themes.length >= 4);
  const bad = [];
  for (const m of models) for (const th of themes) {
    f.T.SQ = { imgs: {} };
    const d = f.call(`(()=>{const d=stuBlank(${JSON.stringify(m)});const t=STU_THEMES[${JSON.stringify(th)}];d.theme={key:${JSON.stringify(th)},bg:t.bg,bg2:t.bg2,fg:t.fg,accent:t.accent};return d})()`);
    f.T.__d = d; const r = f.call(`studioCanvas(__T.__d,${JSON.stringify(LINK)},900,{},{})`);
    const got = await F.decode(r.cv); if (got !== LINK) bad.push(m + '/' + th);
  }
  assert.deepEqual(bad, [], 'combinações ilegíveis: ' + bad.join(', '));
});
t('cores do QR e da placa: todas as combinações oferecidas continuam legíveis', async () => {
  const f = F.makeContext(); const fgs = f.call('Object.values(STU_QRFG).map(x=>x[1])'), plates = f.call('Object.values(STU_PLATE).map(x=>x[1])'), bad = [];
  for (const fg of fgs) for (const pl of plates) {
    const d = f.call('stuBlank("casal_qr")'); d.qrFg = fg; d.qrBg = pl; f.T.__d = d;
    const r = f.call(`studioCanvas(__T.__d,${JSON.stringify(LINK)},900,{},{})`);
    if ((await F.decode(r.cv)) !== LINK) bad.push(fg + '/' + pl);
  }
  assert.deepEqual(bad, [], 'cores ilegíveis: ' + bad.join(', '));
});
t('com foto, moldura e decoração o QR continua legível e a verificação interna aprova', async () => {
  const f = F.makeContext(), { createCanvas } = f.canvasLib;
  const ph = createCanvas(400, 300), x = ph.getContext('2d'); const g = x.createLinearGradient(0, 0, 400, 300); g.addColorStop(0, '#f43f5e'); g.addColorStop(1, '#1d4ed8'); x.fillStyle = g; x.fillRect(0, 0, 400, 300);
  const img = await f.canvasLib.loadImage(ph.toBuffer('image/png'));
  const d = f.call('stuBlank("casal_qr")'); d.frame = 'floral'; d.decor = ['hearts', 'stars', 'flowers', 'sparkles']; d.density = 3;
  d.photos = [{ url: 'https://fake.supabase.co/storage/v1/object/public/photos/u/a.jpg', x: .5, y: .5, zoom: 1 }]; f.T.__d = d; f.T.SQ = { imgs: { [d.photos[0].url]: img } };
  const r = f.call(`studioCanvas(__T.__d,${JSON.stringify(LINK)},900,__T.SQ.imgs,{})`);
  assert.equal(await F.decode(r.cv), LINK);
  f.T.__r = r; assert.equal(f.call('studioVerify(__T.__r.cv,__T.__r.info,__T.__d,' + JSON.stringify(LINK) + ').ok'), true);
});
t('ajuste de tamanho do QR (70% a 110%) é real: muda o tamanho no arquivo e continua legível', async () => {
  const f = F.makeContext(), sides = {};
  for (const sc of [0.7, 1, 1.1]) for (const m of ['casal_qr', 'quadro_foto', 'cartao_presente']) {
    const key = f.call('Object.keys(STU_MODELS)').includes(m) ? m : 'casal_qr';
    const d = f.call(`stuBlank(${JSON.stringify(key)})`); d.qrScale = sc; f.T.__d = d;
    const r = f.call(`studioCanvas(__T.__d,${JSON.stringify(LINK)},900,{},{})`);
    assert.equal(await F.decode(r.cv), LINK, `legível com escala ${sc} em ${key}`); (sides[key] = sides[key] || {})[sc] = r.info.side;
  }
  for (const k of Object.keys(sides)) { assert.ok(sides[k][0.7] < sides[k][1] && sides[k][1] < sides[k][1.1], 'o tamanho do QR deve crescer com a escala em ' + k); }
  const bruto = f.call('stuSanitize({model:"casal_qr",qrScale:9})'); assert.equal(bruto.qrScale, 1.1, 'valores absurdos são limitados');
  assert.equal(f.call('stuSanitize({model:"casal_qr",qrScale:0.1})').qrScale, 0.7);
});
t('o QR padrão (A4, A5, foto 10x15 e digital) é legível e passa na verificação módulo a módulo', async () => {
  const f = F.makeContext(); f.T.SQ = { link: LINK };
  for (const key of ['dig', 'foto', 'a6', 'a5', 'a4', 'q20']) {
    f.T.__k = key; const fin = f.call('stuPlainFinal(__T.__k)'); f.T.__f = fin;
    assert.equal(await F.decode(fin.cv), LINK, 'legibilidade em ' + key);
    assert.equal(f.call('stuPlainVerify(__T.__f.cv,__T.__f.info)'), true, 'verificação em ' + key);
  }
  const a4 = f.call('stuPlainFinal("a4")'); assert.equal(a4.cv.width, Math.round(210 / 25.4 * 300)); assert.equal(a4.cv.height, Math.round(297 / 25.4 * 300));
});
t('a prévia é a MESMA imagem do arquivo: o arquivo gerado duas vezes é idêntico byte a byte (sem aleatoriedade)', async () => {
  const f = F.makeContext(); const d = f.call('stuBlank("casal_qr")'); d.decor = ['hearts', 'sparkles', 'stars']; d.density = 3; f.T.__d = d; f.T.SQ = { d, link: LINK, imgs: {} };
  for (const [key, bleed] of [['dig', 0], ['a5', 3]]) {
    const a = f.call(`stuFinal(${JSON.stringify(key)},${bleed})`).cv.toBuffer('image/png'), b = f.call(`stuFinal(${JSON.stringify(key)},${bleed})`).cv.toBuffer('image/png');
    assert.equal(hash(a), hash(b), 'arte ' + key + ' deve ser determinística');
  }
  const p1 = f.call('stuPlainFinal("a4")').cv.toBuffer('image/png'), p2 = f.call('stuPlainFinal("a4")').cv.toBuffer('image/png'); assert.equal(hash(p1), hash(p2));
});

// ---------- liberação do download (regras do navegador; a verdade fica no banco) ----------
function exportEnv(access, rpcResult, extra = {}) {
  const f = F.makeContext({ elements: extra.elements });
  const d = f.call('stuBlank("casal_qr")'); f.T.__d = d;
  const calls = []; f.T.SB = { rpc: async (name, args) => { calls.push([name, args]); return rpcResult(name, args); } };
  f.T.SQ = { exp: { id: 'exp-1', paid: !!access.custom }, link: LINK, d, designs: [d], imgs: {}, access, tab: 'exp', ver: { ok: true } };
  const saved = []; f.ctx.stuDownload = (blob, name) => saved.push({ blob, name });
  f.ctx.studioTab = () => {}; return { f, calls, saved };
}
t('bloqueado: sem liberação NADA é baixado e o servidor nem é chamado (QR padrão e personalizado)', async () => {
  const { f, calls, saved } = exportEnv({ normal: false, custom: false }, () => ({ data: { ok: true } }));
  for (const k of ['png', 'jpg', 'pdf', 'share', 'n-png', 'n-jpg', 'n-pdf']) await f.call(`studioExport(${JSON.stringify(k)})`);
  assert.equal(saved.length, 0); assert.equal(calls.length, 0);
  assert.ok(f.log.toast.length === 7 && f.log.toast.every(m => /Libere/.test(m)));
});
t('liberado só o QR padrão: baixa o padrão, mas o personalizado continua bloqueado', async () => {
  const { f, calls, saved } = exportEnv({ normal: true, custom: false }, () => ({ data: { ok: true } }));
  await f.call('studioExport("png")'); assert.equal(saved.length, 0);
  await f.call('studioExport("n-png")'); assert.equal(saved.length, 1); assert.match(saved[0].name, /^amoria-qr-padrao-dig\.png$/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['authorize_qr_download', { p_exp: 'exp-1', p_kind: 'normal', p_format: 'png' }]]);
});
t('se o servidor recusar (DOWNLOAD_NAO_LIBERADO) o arquivo NÃO é entregue, mesmo com a tela achando que está liberado', async () => {
  const { f, saved } = exportEnv({ normal: true, custom: true }, () => ({ error: { message: 'DOWNLOAD_NAO_LIBERADO' } }));
  f.T.SB.rpc = async name => name === 'my_download_access' ? { data: { normal: false, custom: false } } : { error: { message: 'DOWNLOAD_NAO_LIBERADO' } };
  await f.call('studioExport("png")'); await f.call('studioExport("n-pdf")');
  assert.equal(saved.length, 0); assert.ok(f.log.toast.some(m => /ainda não está liberado/.test(m)));
  assert.deepEqual(JSON.parse(JSON.stringify(f.T.SQ.access)), { normal: false, custom: false }, 'a tela volta ao estado real do servidor');
});
t('liberado: PNG, JPG e PDF saem corretos, o servidor registra cada download e o QR do arquivo é legível', async () => {
  const { f, calls, saved } = exportEnv({ normal: true, custom: true }, () => ({ data: { ok: true } }));
  for (const k of ['png', 'jpg', 'pdf', 'n-png', 'n-jpg', 'n-pdf']) await f.call(`studioExport(${JSON.stringify(k)})`);
  assert.equal(saved.length, 6, 'toasts: ' + f.log.toast.join(' | '));
  assert.deepEqual(saved.map(s => s.name.split('.').pop()), ['png', 'jpg', 'pdf', 'png', 'jpg', 'pdf']);
  assert.deepEqual(calls.map(c => c[1].p_kind + ':' + c[1].p_format), ['custom:png', 'custom:jpg', 'custom:pdf', 'normal:png', 'normal:jpg', 'normal:pdf']);
  for (const s of saved) {
    const buf = Buffer.from(await s.blob.arrayBuffer());
    if (s.name.endsWith('.pdf')) { assert.equal(buf.slice(0, 5).toString(), '%PDF-'); assert.match(buf.slice(-8).toString(), /%%EOF/); assert.ok(buf.includes(Buffer.from('/DCTDecode'))); }
    else { assert.equal(s.blob.type, s.name.endsWith('.png') ? 'image/png' : 'image/jpeg'); assert.equal(await F.decode(buf), LINK, s.name + ' deve ser legível'); }
  }
});
t('o arquivo baixado é exatamente a imagem da prévia (mesma função, mesmos pixels)', async () => {
  const { f, saved } = exportEnv({ normal: true, custom: true }, () => ({ data: { ok: true } }));
  await f.call('studioExport("png")'); await f.call('studioExport("n-png")');
  const arte = Buffer.from(await saved[0].blob.arrayBuffer()), padrao = Buffer.from(await saved[1].blob.arrayBuffer());
  assert.equal(hash(arte), hash(f.call('stuFinal("dig",0)').cv.toBuffer('image/png')));
  assert.equal(hash(padrao), hash(f.call('stuPlainFinal("dig")').cv.toBuffer('image/png')));
});
t('tamanho de impressão escolhido na tela vale no arquivo (A5 + sangria) e o QR continua legível', async () => {
  const { f, saved } = exportEnv({ normal: true, custom: true }, () => ({ data: { ok: true } }), { elements: { 'st-size': { value: 'a5' }, 'st-bleed': { value: '3' }, 'st-nsize': { value: 'a6' } } });
  await f.call('studioExport("png")'); await f.call('studioExport("n-png")');
  const big = await f.canvasLib.loadImage(Buffer.from(await saved[0].blob.arrayBuffer())), small = await f.canvasLib.loadImage(Buffer.from(await saved[1].blob.arrayBuffer()));
  assert.equal(big.width, Math.round((148 + 6) / 25.4 * 300)); assert.equal(big.height, Math.round((210 + 6) / 25.4 * 300));
  assert.equal(small.width, Math.round(105 / 25.4 * 300)); assert.equal(small.height, Math.round(148 / 25.4 * 300));
  assert.equal(await F.decode(Buffer.from(await saved[0].blob.arrayBuffer())), LINK); assert.equal(await F.decode(Buffer.from(await saved[1].blob.arrayBuffer())), LINK);
});
t('endereço inválido (não é o link real da experiência) não gera arquivo', async () => {
  const { f, saved } = exportEnv({ normal: true, custom: true }, () => ({ data: { ok: true } }));
  f.T.SQ.link = 'https://amoria.example.test/#/criar'; await f.call('studioExport("png")'); await f.call('studioExport("n-png")');
  assert.equal(saved.length, 0); assert.ok(f.log.toast.every(m => /endereço/.test(m)));
});
