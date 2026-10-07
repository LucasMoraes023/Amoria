// Webhook do Mercado Pago: confirma o pagamento direto na API deles e libera a experiência.
const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_ROLE_KEY, MP = process.env.MP_ACCESS_TOKEN;
const sb = (p, o = {}) => fetch(SU + '/rest/v1/' + p, { ...o, headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation', ...o.headers } });

exports.handler = async ev => {
  try {
    const q = ev.queryStringParameters || {}, body = ev.body ? JSON.parse(ev.body) : {};
    const id = q['data.id'] || (body.data && body.data.id) || (q.topic === 'payment' && q.id);
    if (!id) return { statusCode: 200, body: 'ok' };
    const p = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + MP } }).then(r => r.json());
    if (p.status === 'approved') {
      const [pay] = await sb('payments?provider_ref=eq.' + encodeURIComponent(String(p.id)) + '&select=id,experience_id,amount_cents').then(r => r.json());
      if (pay && Math.round(p.transaction_amount * 100) >= pay.amount_cents) {
        const now = new Date().toISOString();
        await sb('payments?id=eq.' + pay.id, { method: 'PATCH', body: JSON.stringify({ status: 'approved', paid_at: now }) });
        await sb('experiences?id=eq.' + pay.experience_id, { method: 'PATCH', body: JSON.stringify({ paid: true, paid_at: now, pay_ref: String(p.id) }) });
      }
    }
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    return { statusCode: 500, body: 'erro' };
  }
};
