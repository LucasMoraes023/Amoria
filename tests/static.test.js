// Verificações estáticas do pacote: scripts locais, cabeçalhos de segurança, build, migrações e funções.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('index.html: só scripts locais (sem CDN), nenhum script embutido, app.js no fim', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map(s => (s[1].match(/src="([^"]+)"/) || [])[1]), ['vendor/qrcode.js', 'vendor/supabase.js', 'config.js', 'app.js']);
  assert.ok(scripts.every(s => s[2].trim() === ''), 'nenhum JavaScript embutido no HTML');
  assert.ok(!/https?:\/\/(cdn|unpkg|cdnjs|esm\.sh|cdn\.jsdelivr)/.test(html + read('app.js')), 'sem scripts de CDN');
  assert.ok(!/\son(click|error|load|change|input)\s*=/i.test(html), 'sem handlers inline');
});
test('bibliotecas fixas conferem com o registro de versões (sha256)', () => {
  const crypto = require('crypto'), v = read('vendor/VERSOES.txt');
  for (const f of ['qrcode.js', 'supabase.js']) assert.ok(v.includes(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'vendor', f))).digest('hex')), f + ' não confere com VERSOES.txt');
});
test('netlify.toml: build com lista explícita, CSP sem script inline, sem iframe externo, cabeçalhos de segurança', () => {
  const t = read('netlify.toml');
  assert.match(t, /command\s*=\s*"node scripts\/build\.js"/); assert.match(t, /publish\s*=\s*"dist"/);
  const csp = (t.match(/Content-Security-Policy\s*=\s*"([^"]+)"/) || [])[1]; assert.ok(csp, 'CSP ausente');
  assert.match(csp, /script-src 'self'(;|$)/); assert.doesNotMatch(csp.split(';').find(x => x.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval|http/);
  for (const d of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "default-src 'self'"]) assert.ok(csp.includes(d), d);
  for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy', 'Strict-Transport-Security']) assert.ok(t.includes(h), h);
});
test('build: gera dist/ somente com arquivos públicos (nada de SQL, funções, testes, documentos ou segredos)', () => {
  const r = cp.spawnSync('node', ['scripts/build.js'], { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(path.join(root, 'dist'), path.join(d, e.name))]);
  assert.deepEqual(walk(path.join(root, 'dist')).sort(), ['404.html', 'app.js', 'config.js', 'icon.svg', 'index.html', 'manifest.webmanifest', 'sw.js', 'vendor/qrcode.js', 'vendor/supabase.js']);
});
test('service worker: não guarda respostas das Functions nem respostas com erro; pré-carrega o necessário', () => {
  const sw = read('sw.js'); assert.match(sw, /\/\.netlify\//); assert.match(sw, /r\.ok/);
  for (const f of ['app.js', 'config.js', 'vendor/qrcode.js', 'vendor/supabase.js', 'index.html']) assert.ok(sw.includes("'" + f + "'"), f + ' deveria ser pré-carregado');
});
test('todas as Functions do Netlify carregam sem erro de sintaxe/importação', () => {
  for (const f of fs.readdirSync(path.join(root, 'netlify/functions'))) { const m = require(path.join(root, 'netlify/functions', f)); assert.equal(typeof m.handler, 'function', f + ' sem handler'); }
});
test('migrações novas: numeradas, registram a si mesmas e nunca apagam dados', () => {
  const dir = path.join(root, 'supabase/migrations'), files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 3);
  for (const f of files) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8'), id = f.slice(0, 12);
    assert.ok(s.includes("public._mig('" + id + "'"), f + ' não se registra');
    const sem = s.replace(/--.*$/gm, '');
    assert.ok(!/\bdrop\s+(table|schema|database)\b|\btruncate\b/i.test(sem), f + ': comando destrutivo');
    assert.ok(!/\bdelete\s+from\s+public\.(?!rate_events)\w+\s*(;|$)/im.test(sem), f + ': DELETE sem WHERE');
  }
});
test('documentação obrigatória presente', () => {
  for (const f of ['README.md', 'RELATORIO-DE-AUDITORIA.md', 'CORRECOES-REALIZADAS.md', 'PENDENCIAS-REAIS.md', 'CONFIGURACAO-NETLIFY.md', 'CONFIGURACAO-SUPABASE.md', 'VARIAVEIS-DE-AMBIENTE.md', 'INSTRUCOES-DE-IMPLANTACAO.md'])
    assert.ok(fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).size > 500, 'falta ' + f);
});
