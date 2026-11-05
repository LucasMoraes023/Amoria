// Teste de fumaça em DOM (jsdom): carrega o index.html + app.js reais com um Supabase SIMULADO e um canvas "mudo".
// Pega erros de execução (referências nulas, funções ausentes) nas telas principais. NÃO substitui teste em celular real:
// não avalia CSS, toque, rolagem, fontes, câmera nem a renderização do canvas.
const fs = require('fs'), path = require('path');
let JSDOM = null; try { ({ JSDOM } = require('jsdom')); } catch { /* ferramenta ausente */ }
const ROOT = path.join(__dirname, '..', '..');
const available = () => JSDOM ? '' : 'jsdom ausente: rode "cd tests && npm install"';

const builder = result => new Proxy({}, { get: (_, k) => k === 'then' ? (res, rej) => Promise.resolve(result).then(res, rej)
  : (k === 'single' || k === 'maybeSingle') ? () => builder({ data: Array.isArray(result.data) ? (result.data[0] || null) : result.data, error: null }) : () => builder(result) });

function boot({ user = null, tables = {}, rpc = {}, fetchMap = {}, hash = '#/' } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://amoria.example.test/' + hash, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, errors = [], calls = { rpc: [], fetch: [] };
  w.addEventListener('error', e => errors.push(String(e.error && e.error.stack || e.message)));
  w.addEventListener('unhandledrejection', e => errors.push('rejeição: ' + String(e.reason && e.reason.stack || e.reason)));
  const noop = () => {}, ctx = new Proxy(function () {}, { get: (t, k) => k === 'measureText' ? s => ({ width: String(s).length * 6 }) : k === 'getImageData' ? (x, y, ww, hh) => ({ data: new Uint8ClampedArray(Math.max(1, ww * hh * 4)), width: ww, height: hh }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : k === 'canvas' ? null : noop, set: () => true, apply: () => undefined });
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
  w.HTMLCanvasElement.prototype.toBlob = function (cb, t) { cb(new w.Blob(['x'], { type: t || 'image/png' })); };
  w.TextEncoder = w.TextEncoder || TextEncoder; w.TextDecoder = w.TextDecoder || TextDecoder; w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.Path2D = w.Path2D || class { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} closePath() {} arc() {} rect() {} roundRect() {} ellipse() {} };
  w.document.execCommand = w.document.execCommand || (() => true); Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  w.scrollTo = noop; w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener: noop, addEventListener: noop }));
  w.URL.createObjectURL = () => 'blob:fake'; w.URL.revokeObjectURL = noop;
  w.alert = noop; w.confirm = () => true; w.prompt = () => 'motivo de teste';
  w.fetch = async (url, o) => { calls.fetch.push([String(url), o]); const m = fetchMap[String(url).split('?')[0]]; const body = typeof m === 'function' ? m(o) : (m || {}); return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }; };
  const session = user ? { user, access_token: 'tok_' + user.id } : null;
  const client = {
    auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: cb => { setTimeout(() => cb('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe: noop } } }; },
      signInWithPassword: async () => ({ data: { session }, error: null }), signUp: async () => ({ data: {}, error: null }), signOut: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }), getUser: async () => ({ data: { user } }) },
    from: t => builder({ data: tables[t] || [], error: null }),
    rpc: async (name, args) => { calls.rpc.push([name, args]); if (!(name in rpc)) return { data: null, error: null }; const r = rpc[name]; const v = typeof r === 'function' ? r(args) : r; return v && v.__error ? { data: null, error: { message: v.__error } } : { data: v, error: null }; },
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'https://fake.supabase.co/storage/v1/object/public/photos/x.jpg' } }), remove: async () => ({ error: null }) }) }
  };
  w.eval(fs.readFileSync(path.join(ROOT, 'vendor', 'qrcode.js'), 'utf8'));
  w.AMORIA = { url: 'https://fake.supabase.co', anon: 'anon-fake' }; w.supabase = { createClient: () => client };
  w.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
  const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
  const app = () => w.document.querySelector('#app');
  const go = async h => { w.location.hash = h; await tick(60); };
  const click = async sel => { const e = w.document.querySelector(sel); if (!e) throw new Error('elemento não encontrado: ' + sel); e.click(); await tick(60); };
  return { w, dom, errors, calls, tick, app, go, click, text: () => app().textContent.replace(/\s+/g, ' '), html: () => app().innerHTML, $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)], client };
}
module.exports = { available, boot };
