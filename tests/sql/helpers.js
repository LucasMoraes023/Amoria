// Infraestrutura dos testes de SQL: cria um banco PostgreSQL descartável, aplica as migrações REAIS do projeto
// sobre um "Supabase simulado" (roles, auth.uid, storage) e permite executar consultas como anon, usuário ou service_role.
// Requer PostgreSQL 15+ acessível. Variável opcional: AMORIA_PG (ex.: postgres://postgres@localhost:5432/postgres).
// Sem PostgreSQL, os testes são marcados como BLOQUEADOS (skip) — nunca como aprovados.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
let pg; try { pg = require('pg'); } catch { pg = null; }

const ROOT = path.join(__dirname, '..', '..');
const SUPA = path.join(ROOT, 'supabase');
// Ordem oficial de instalação (README/CONFIGURACAO-SUPABASE.md). Instalação nova = tudo; atualização = só as migrations/.
const LEGACY = ['schema.sql', 'free-experiences-qr-addon.sql', 'video-support.sql', 'payments-pix-module.sql', 'catalog-access-module.sql', 'ai-studio-module.sql'].map(f => path.join(SUPA, f));
const MIGRATIONS = fs.readdirSync(path.join(SUPA, 'migrations')).filter(f => /^\d{8}_\d{3}_.*\.sql$/.test(f)).sort().map(f => path.join(SUPA, 'migrations', f));
const STUB = path.join(__dirname, 'supabase-stub.sql');

const cfg = () => {
  if (process.env.AMORIA_PG) return { connectionString: process.env.AMORIA_PG };
  return { host: process.env.PGHOST || '/tmp', port: +(process.env.PGPORT || 54329), user: process.env.PGUSER || 'postgres', database: 'postgres' };
};
async function available() {
  if (!pg) return 'módulo "pg" não instalado (rode: cd tests && npm install)';
  const c = new pg.Client(cfg());
  try { await c.connect(); await c.end(); return ''; } catch (e) { return 'PostgreSQL de teste indisponível (' + (e.code || e.message) + ')'; }
}
const run = async (client, file) => { await client.query(fs.readFileSync(file, 'utf8')); };

async function createDb({ files = [STUB, ...LEGACY, ...MIGRATIONS] } = {}) {
  const name = 'amoria_t_' + crypto.randomBytes(5).toString('hex');
  const admin = new pg.Client(cfg()); await admin.connect();
  await admin.query(`create database ${name}`); await admin.end();
  const base = cfg(), conf = base.connectionString ? { connectionString: base.connectionString.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1') } : { ...base, database: name };
  const pool = new pg.Pool({ ...conf, max: 12 });
  const c = await pool.connect();
  try { await c.query("set client_min_messages = warning"); for (const f of files) await run(c, f); } finally { c.release(); }
  const drop = async () => { await pool.end(); const a = new pg.Client(cfg()); await a.connect(); await a.query(`drop database if exists ${name} with (force)`); await a.end(); };
  return { name, pool, drop, apply: async f => { const k = await pool.connect(); try { await k.query('set client_min_messages = warning'); await run(k, f); } finally { k.release(); } } };
}

// Executa fn(client) numa transação com o papel e o usuário indicados (como o PostgREST faz para cada requisição).
async function as(db, who, fn) {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    if (who && who.role) {
      await client.query(`set local role ${who.role}`);
      await client.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [who.uid || '', who.role]);
    }
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) { try { await client.query('rollback'); } catch {} throw e; }
  finally { client.release(); }
}
const user = uid => ({ role: 'authenticated', uid });
const service = { role: 'service_role', uid: '' };
const anon = { role: 'anon', uid: '' };
const uuid = () => crypto.randomUUID();
const slug = () => crypto.randomBytes(6).toString('hex');

async function addUser(db, email) {
  const id = uuid();
  await db.pool.query('insert into auth.users(id,email) values ($1,$2)', [id, email || id.slice(0, 8) + '@teste.com']);
  return id;
}
async function addExperience(db, uid, extra = {}) {
  return as(db, user(uid), async c => (await c.query(
    "insert into public.experiences(owner,slug,title,type,theme,content,pub) values ($1,$2,$3,'declaracao','classic',$4,$5) returning id",
    [uid, slug(), extra.title || 'Minha experiência', JSON.stringify(extra.content || {}), extra.pub || 'P.e30'])).rows[0].id);
}
async function makePrimaryAdmin(db, uid) {
  await db.pool.query('insert into public.admin_allowlist(user_id) values ($1) on conflict do nothing', [uid]);
  await db.pool.query('insert into public.admin_identity(slot,user_id) values (true,$1) on conflict (slot) do update set user_id=excluded.user_id', [uid]);
}
const q = (c, sql, args) => c.query(sql, args).then(r => r.rows);
const call = (c, fn, args = []) => c.query(`select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as r`, args).then(r => r.rows[0].r);

module.exports = { available, createDb, as, user, service, anon, uuid, addUser, addExperience, makePrimaryAdmin, q, call, LEGACY, MIGRATIONS, STUB, SUPA, run };
