// Mini-PostgREST de TESTE: traduz as chamadas REST/RPC/Auth que as Functions do Netlify fazem para SQL no PostgreSQL real
// (com o papel service_role), e simula SOMENTE o Mercado Pago. Assim o código das Functions e as regras do banco rodam juntos.
const H = require('./helpers');
const SUPABASE_URL = 'https://fake.supabase.co';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const lower = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
const colOk = c => /^[a-z_][a-z0-9_]*$/.test(c);

function makeMp() {
  const st = { payments: new Map(), keys: new Map(), seq: 9000, calls: [], up: true, usersMe: 200 };
  const handler = async (url, method, headers, body) => {
    st.calls.push({ url, method, headers, body });
    if (url.endsWith('/users/me')) return json(st.usersMe, { id: 1 });
    if (url.endsWith('/v1/payments') && method === 'POST') {
      if (!st.up) return json(503, { message: 'indisponível' });
      const key = headers['x-idempotency-key'];
      if (key && st.keys.has(key)) return json(201, st.keys.get(key));
      const b = JSON.parse(body), id = ++st.seq;
      const pay = { id, status: 'pending', status_detail: 'pending_waiting_transfer', transaction_amount: b.transaction_amount, currency_id: 'BRL',
        external_reference: b.external_reference, payment_method_id: 'pix',
        point_of_interaction: { transaction_data: { qr_code: '00020126580014br.gov.bcb.pix' + id, qr_code_base64: 'iVBORw0KGgo=' } } };
      st.payments.set(String(id), pay); if (key) st.keys.set(key, pay);
      return json(201, pay);
    }
    const m = url.match(/\/v1\/payments\/(\d+)$/);
    if (m && method === 'GET') { const p = st.payments.get(m[1]); return p ? json(200, p) : json(404, { message: 'não encontrado' }); }
    return json(404, {});
  };
  return { st, handler, creates: () => st.calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/payments')) };
}

function makeFetch(db, mp) {
  const sql = fn => H.as(db, H.service, fn);
  const err = e => json(e.code === '42501' ? 403 : 400, { code: e.code, message: e.message, details: e.detail || null });
  async function rest(method, url, headers, body) {
    const u = new URL(url), path = u.pathname.replace('/rest/v1/', '');
    const prefer = headers.prefer || '';
    try {
      if (path.startsWith('rpc/')) {
        const fn = path.slice(4), args = body ? JSON.parse(body) : {}, keys = Object.keys(args);
        if (!colOk(fn) || !keys.every(colOk)) return json(400, { message: 'nome inválido' });
        const r = await sql(c => c.query(`select public.${fn}(${keys.map((k, i) => `${k} := $${i + 1}`).join(',')}) as r`, keys.map(k => args[k])));
        return json(200, r.rows[0].r);
      }
      const table = path; if (!colOk(table)) return json(400, { message: 'tabela inválida' });
      const where = [], params = []; let select = '*', order = '', limit = '';
      for (const [k, v] of u.searchParams) {
        if (k === 'select') { select = v; continue; }
        if (k === 'order') { if (!/^[a-z_]+\.(asc|desc)$/.test(v)) return json(400, {}); order = ' order by ' + v.replace('.', ' '); continue; }
        if (k === 'limit') { limit = ' limit ' + parseInt(v, 10); continue; }
        if (k === 'on_conflict') continue;
        if (!colOk(k)) return json(400, { message: 'coluna inválida' });
        const i = v.indexOf('.'), op = v.slice(0, i), val = v.slice(i + 1);
        if (op === 'eq') { params.push(val); where.push(`${k}::text = $${params.length}`); }
        else if (op === 'neq') { params.push(val); where.push(`${k}::text <> $${params.length}`); }
        else if (op === 'is') where.push(`${k} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`);
        else if (op === 'in') { params.push(val.replace(/^\(|\)$/g, '').split(',')); where.push(`${k}::text = any($${params.length}::text[])`); }
        else return json(400, { message: 'operador não suportado: ' + op });
      }
      const W = where.length ? ' where ' + where.join(' and ') : '';
      const cols = select === '*' ? '*' : select.split(',').map(x => { if (!colOk(x)) throw new Error('coluna inválida'); return x; }).join(',');
      const ret = prefer.includes('return=representation');
      if (method === 'GET') return json(200, (await sql(c => c.query(`select ${cols} from public.${table}${W}${order}${limit}`, params))).rows);
      const data = body ? JSON.parse(body) : {};
      const val = x => (x !== null && typeof x === 'object') ? JSON.stringify(x) : x;
      if (method === 'PATCH') {
        const ks = Object.keys(data); if (!ks.every(colOk)) return json(400, {});
        const set = ks.map((k, i) => `${k} = $${params.length + i + 1}`).join(',');
        const r = await sql(c => c.query(`update public.${table} set ${set}${W} returning ${cols}`, [...params, ...ks.map(k => val(data[k]))]));
        return ret ? json(200, r.rows) : json(204, null);
      }
      if (method === 'POST') {
        const row = Array.isArray(data) ? data[0] : data, ks = Object.keys(row); if (!ks.every(colOk)) return json(400, {});
        const oc = u.searchParams.get('on_conflict'), ign = prefer.includes('ignore-duplicates') && oc;
        const r = await sql(c => c.query(`insert into public.${table}(${ks.join(',')}) values (${ks.map((_, i) => '$' + (i + 1)).join(',')})${ign ? ` on conflict (${oc}) do nothing` : ''} returning ${cols}`, ks.map(k => val(row[k]))));
        return ret ? json(201, r.rows) : json(201, null);
      }
      return json(405, {});
    } catch (e) { return err(e); }
  }
  return async function fakeFetch(url, o = {}) {
    url = String(url); const method = (o.method || 'GET').toUpperCase(), headers = lower(o.headers);
    if (url.startsWith(SUPABASE_URL + '/rest/v1/')) return rest(method, url, headers, o.body);
    if (url === SUPABASE_URL + '/auth/v1/user') {
      const m = /^Bearer tok_([0-9a-f-]{36})$/.exec(headers.authorization || '');
      if (!m) return json(401, { message: 'jwt inválido' });
      const r = await db.pool.query('select id,email from auth.users where id=$1', [m[1]]);
      return r.rows[0] ? json(200, r.rows[0]) : json(401, {});
    }
    if (url.startsWith('https://api.mercadopago.com')) return mp.handler(url.replace('https://api.mercadopago.com', 'https://api.mercadopago.com'), method, headers, o.body);
    throw new Error('fetch inesperado nos testes: ' + url);
  };
}
module.exports = { makeFetch, makeMp, SUPABASE_URL };
