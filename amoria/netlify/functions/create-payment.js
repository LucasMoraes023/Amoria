// Cria uma cobrança PIX no Mercado Pago para uma experiência do usuário logado.
// Variáveis no Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MP_ACCESS_TOKEN
const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_ROLE_KEY, MP = process.env.MP_ACCESS_TOKEN;
const H = { 'Content-Type': 'application/json' };
const R = (c, o) => ({ statusCode: c, headers: H, body: JSON.stringify(o) });
const sb = (p, o = {}) => fetch(SU + '/rest/v1/' + p, { ...o, headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation', ...o.headers } });

exports.handler = async ev => {
  if (ev.httpMethod !== 'POST') return R(405, { error: 'Método inválido' });
  if (!SU || !SK || !MP) return R(500, { error: 'Servidor sem configuração de pagamento' });
  try {
    const jwt = (ev.headers.authorization || '').replace(/^Bearer /i, '');
    const u = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + jwt } }).then(r => (r.ok ? r.json() : null));
    if (!u || !u.id) return R(401, { error: 'Faça login' });
    const { expId } = JSON.parse(ev.body || '{}');
    if (!/^[0-9a-f-]{36}$/i.test(expId || '')) return R(400, { error: 'Experiência inválida' });
    const [e] = await sb(`experiences?id=eq.${expId}&owner=eq.${u.id}&select=id,paid`).then(r => r.json());
    if (!e) return R(404, { error: 'Experiência não encontrada' });
    if (e.paid) return R(200, { paid: true });
    const [b] = await sb('settings?key=eq.billing&select=value').then(r => r.json());
    const price = +(b && b.value.price_cents) || 0;
    if (price <= 0) return R(200, { paid: true });
    const r = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MP, 'Content-Type': 'application/json', 'X-Idempotency-Key': e.id + '-' + Date.now() },
      body: JSON.stringify({
        transaction_amount: price / 100,
        description: 'AMORIA - liberar link e QR Code',
        payment_method_id: 'pix',
        payer: { email: u.email },
        external_reference: e.id,
        notification_url: process.env.URL + '/.netlify/functions/mp-webhook'
      })
    });
    const p = await r.json();
    if (!r.ok) return R(502, { error: p.message || 'Erro no Mercado Pago' });
    await sb('payments', { method: 'POST', body: JSON.stringify({ experience_id: e.id, user_id: u.id, amount_cents: price, provider_ref: String(p.id) }) });
    const t = p.point_of_interaction.transaction_data;
    return R(200, { code: t.qr_code, qr: t.qr_code_base64, amount: price });
  } catch (err) {
    return R(500, { error: 'Falha ao gerar o PIX' });
  }
};
