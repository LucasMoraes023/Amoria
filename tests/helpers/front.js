// Carrega partes REAIS do app.js (motor do Estúdio, exportação, utilitários) num contexto isolado (vm) com um canvas de verdade
// (@napi-rs/canvas) para testar desenho, leitura do QR (jsQR) e regras de liberação. Não é um navegador: não testa CSS nem toque.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
let canvasLib = null, jsQR = null;
try { canvasLib = require('@napi-rs/canvas'); jsQR = require('jsqr'); } catch { /* sem as ferramentas: testes ficam bloqueados */ }
const available = () => (canvasLib && jsQR) ? '' : 'ferramentas ausentes (@napi-rs/canvas e jsqr): rode "cd tests && npm install"';

const APP = () => fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').split('\n');
const between = (L, startMarker, endMarker) => {
  const a = L.findIndex(l => l.startsWith(startMarker)), b = endMarker ? L.findIndex((l, i) => i > a && l.startsWith(endMarker)) : L.length;
  if (a < 0 || b < 0) throw new Error('marcador não encontrado: ' + startMarker + ' / ' + endMarker);
  return L.slice(a, b);
};
const pick = (L, prefixes) => prefixes.map(p => { const l = L.find(x => x.startsWith(p)); if (!l) throw new Error('linha não encontrada: ' + p); return l; });

function makeContext(opts = {}) {
  const L = APP(), log = { toast: [], rpc: [], downloads: [] };
  const qrSrc = fs.readFileSync(path.join(ROOT, 'vendor', 'qrcode.js'), 'utf8');
  const makeCanvas = () => { const c = canvasLib.createCanvas(10, 10); c.toBlob = (cb, type, q) => { const buf = c.toBuffer(type || 'image/png', q == null ? undefined : Math.round(q * 100)); cb(new Blob([buf], { type: type || 'image/png' })); }; return c; };
  const elements = opts.elements || {};
  const sandbox = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, File: opts.File || class File extends Blob { constructor(p, n, o) { super(p, o); this.name = n; } }, atob, btoa, setTimeout, clearTimeout, crypto: require('crypto').webcrypto,
    Path2D: canvasLib.Path2D, Image: canvasLib.Image, Uint8Array, Math, Date, JSON, Promise, Object, Array, String, Number, RegExp, Error, Set, Map, Symbol,
    addEventListener() {}, requestAnimationFrame: f => setTimeout(f, 0), cancelAnimationFrame() {}, matchMedia: () => ({ matches: false }),
    document: { addEventListener() {}, createElement: t => { if (t === 'canvas') return makeCanvas(); return { click() {}, set href(v) {}, set download(v) {} }; }, getElementById: id => elements[id] || null, querySelector: () => null, querySelectorAll: () => [], fonts: { load: async () => {} }, head: { append() {} } },
    navigator: opts.navigator || { canShare: () => false },
    toast: m => log.toast.push(String(m)),
    localStorage: { getItem: () => null, setItem() {} },
    CFG: { url: 'https://fake.supabase.co' },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(qrSrc, ctx);                      // define "qrcode" como global (biblioteca fixa do projeto)
  const parts = [
    'let D2=null,BUY={code:"qr_custom",coupon:""},PRICES={},PAY_METHODS={},pt=0,U={id:"u1"},SB=null,CL=[],VIDEO_LIMIT=3;',
    'const money=c=>"R$ "+(c/100).toFixed(2).replace(".",",");',
    'function studioTab(){}function studioShow(){}function studioSave(){return true}function loadQuote(){}function payCall(){}',
    ...pick(L, ['const esc=s=>', 'const safeUrl=', 'const newSlug=']),
    ...between(L, '/* QR Code */', '/* ===== ESTÚDIO DE QR CODES AMORIA — motor de desenho'),
    ...between(L, '/* ===== ESTÚDIO DE QR CODES AMORIA — motor de desenho', '/* ===== ESTÚDIO DE QR CODES AMORIA — interface'),
    ...between(L, '/* ===== ESTÚDIO DE QR CODES AMORIA — interface', '/* ===== AMORIA AI STUDIO — interface'),
    'globalThis.__T={get SQ(){return SQ},set SQ(v){SQ=v},get D2(){return D2},set D2(v){D2=v},get SB(){return SB},set SB(v){SB=v},get BUY(){return BUY},set BUY(v){BUY=v},get PRICES(){return PRICES},set PRICES(v){PRICES=v},get STU_ON(){return STU_ON},set STU_ON(v){STU_ON=v}};',
  ];
  try { vm.runInContext(parts.join('\n'), ctx, { filename: 'app.js(parcial)' }); }
  catch (e) { throw new Error('Falha ao carregar o app.js nos testes: ' + e.message); }
  return { ctx, log, T: ctx.__T, call: (code) => vm.runInContext(code, ctx), canvasLib, jsQR, makeCanvas };
}

// Decodifica o QR de um canvas (ou de bytes PNG/JPEG) com o leitor independente jsQR.
async function decode(source) {
  let img;
  if (source && typeof source.getContext === 'function') { const c = source.getContext('2d'); img = c.getImageData(0, 0, source.width, source.height); }
  else { const im = await canvasLib.loadImage(Buffer.from(source)); const cv = canvasLib.createCanvas(im.width, im.height), c = cv.getContext('2d'); c.drawImage(im, 0, 0); img = c.getImageData(0, 0, im.width, im.height); }
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return r ? r.data : null;
}
module.exports = { available, makeContext, decode };
