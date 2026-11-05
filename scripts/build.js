// Monta a pasta dist/ com SOMENTE os arquivos públicos do site (lista explícita).
// Código de servidor (netlify/), SQL (supabase/), testes, documentação e scripts nunca são publicados como arquivos do site.
// Uso: node scripts/build.js   (o Netlify roda isto automaticamente; veja netlify.toml)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'dist');
const FILES = ['index.html', 'app.js', 'config.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', '404.html'];
const VENDOR = ['qrcode.js', 'supabase.js'];
const FORBIDDEN = [/sb_secret_[A-Za-z0-9_-]{10,}/, /APP_USR-[0-9A-Za-z-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /SERVICE_ROLE_KEY['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{20,}/];
// Chave JWT do Supabase com papel service_role (a chave anon, pública por desenho, é permitida)
const jwtRole = t => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).role; } catch { return null; } };

const fail = m => { console.error('BUILD FALHOU: ' + m); process.exit(1); };
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
for (const f of FILES) { const s = path.join(ROOT, f); if (!fs.existsSync(s)) fail('arquivo obrigatório ausente: ' + f); fs.copyFileSync(s, path.join(OUT, f)); }
for (const f of VENDOR) { const s = path.join(ROOT, 'vendor', f); if (!fs.existsSync(s)) fail('biblioteca ausente: vendor/' + f); fs.copyFileSync(s, path.join(OUT, 'vendor', f)); }

// Trava de segurança: nada com cara de segredo pode ir para o site.
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(OUT)) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const rx of FORBIDDEN) if (rx.test(txt)) fail('possível segredo em ' + path.relative(OUT, f));
  for (const t of txt.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) if (jwtRole(t) === 'service_role') fail('chave service_role encontrada em ' + path.relative(OUT, f));
}
const cfg = fs.readFileSync(path.join(OUT, 'config.js'), 'utf8');
if (!/window\.AMORIA\s*=/.test(cfg)) fail('config.js inválido (esperado window.AMORIA = {...})');
const idx = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
for (const ref of ['app.js', 'config.js', 'vendor/qrcode.js', 'vendor/supabase.js']) if (!idx.includes(ref)) fail('index.html não referencia ' + ref);
const files = walk(OUT).map(f => path.relative(OUT, f)).sort();
console.log('Build OK: ' + files.length + ' arquivos em dist/ -> ' + files.join(', '));
