// Barreira contra vazamento de segredos no repositório (o site publica a raiz inteira).
// Rodar: node --test tests/no-secrets.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', '.netlify']);
function walk(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(f.name)) continue;
    const p = path.join(d, f.name);
    f.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(root), rel = f => path.relative(root, f);
const text = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

test('nenhum arquivo .env, chave privada, pacote .zip ou backup versionado', () => {
  const bad = files.filter(f => /(^|\/)\.env(\..*)?$/.test(rel(f)) || /\.(pem|key|p12|zip)$/i.test(f));
  assert.deepEqual(bad.map(rel), [], 'arquivo sensível ou binário na raiz publicada: ' + bad.map(rel).join(', '));
});
test('as únicas chaves JWT versionadas são públicas (papel "anon")', () => {
  for (const f of files) for (const t of text(f).match(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g) || []) {
    const role = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).role;
    assert.equal(role, 'anon', `${rel(f)} contém uma chave com papel "${role}"`);
  }
});
test('nenhum token do Mercado Pago, chave sb_secret ou chave privada PEM no código', () => {
  for (const f of files) {
    const s = text(f);
    assert.ok(!/\b(APP_USR|TEST)-[0-9A-Za-z-]{20,}/.test(s), rel(f) + ': token do Mercado Pago');
    assert.ok(!/sb_secret_[A-Za-z0-9_-]{10,}/.test(s), rel(f) + ': chave secreta do Supabase');
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s), rel(f) + ': chave privada');
  }
});
test('segredos só são lidos de variáveis de ambiente, nunca atribuídos a valores fixos', () => {
  const rx = /(SERVICE_ROLE_KEY|MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]/;
  for (const f of files.filter(f => /\.(js|html|toml|sql)$/.test(f) && !rel(f).startsWith('tests/'))) assert.ok(!rx.test(text(f)), rel(f) + ': segredo fixo no código');
});
test('o navegador (index.html, app.js, config.js e sw.js) nunca recebe segredos de servidor', () => {
  const front = ['index.html', 'app.js', 'config.js', 'sw.js'].map(f => text(path.join(root, f))).join('\n');
  assert.ok(!/process\.env/.test(front));
  assert.ok(!/service_role/i.test(text(path.join(root, 'config.js'))));
});
test('o netlify.toml não desliga a proteção de segredos', () => {
  const t = text(path.join(root, 'netlify.toml'));
  assert.ok(!/SECRETS_SCAN_ENABLED/.test(t), 'a varredura de segredos deve continuar ativa');
  assert.ok(/publish\s*=/.test(t));
});

// ---------- verificação das variáveis (health) ----------
const health = require('../netlify/functions/health').handler;
const jwt = role => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.assinatura-de-teste';
const run = async env => { const keep = { ...process.env }; for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET']) delete process.env[k]; Object.assign(process.env, env); const r = await health(); Object.assign(process.env, keep); for (const k of Object.keys(env)) if (!(k in keep)) delete process.env[k]; return { r, b: JSON.parse(r.body) }; };
test('health: aponta chave anon colocada no lugar da service_role, token no formato errado e URL inválida', async () => {
  const bad = await run({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: jwt('anon'), MP_ACCESS_TOKEN: 'ABC123public' });
  assert.match(bad.b.supabase_service_key, /ERRADA/); assert.match(bad.b.mp_access_token, /formato inesperado/); assert.match(bad.b.supabase_url, /formato inesperado/);
  const ok = await run({ SUPABASE_URL: 'https://abc123.supabase.co', SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'), MP_ACCESS_TOKEN: 'APP_USR-1234567890-abcdef' });
  assert.deepEqual([ok.b.supabase_url, ok.b.supabase_service_key, ok.b.mp_access_token], ['ok', 'ok (service_role)', 'ok (produção)']);
  assert.equal((await run({})).b.supabase_service_key, 'ausente');
});
test('health: nunca devolve os valores das variáveis', async () => {
  const sk = jwt('service_role'), mp = 'APP_USR-9999999999-segredo';
  const { r } = await run({ SUPABASE_URL: 'https://abc123.supabase.co', SUPABASE_SERVICE_ROLE_KEY: sk, MP_ACCESS_TOKEN: mp, MP_WEBHOOK_SECRET: 'whsec-teste' });
  for (const v of [sk, mp, 'whsec-teste', 'abc123']) assert.ok(!r.body.includes(v), 'valor vazou');
});
