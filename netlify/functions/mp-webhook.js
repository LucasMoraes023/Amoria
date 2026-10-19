// Webhook do Mercado Pago: confirma o pagamento direto na API deles e libera a experiência.
const SU = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), SK = process.env.SUPABASE_SERVICE_ROLE_KEY, MP = process.env.MP_ACCESS_TOKEN;
const sb = (p, o = {}) => fetch(SU + '/rest/v1/' + p, { ...o, headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation', ...o.headers } });
const rows = async p => {
  const response = await sb(p);
  if (!response.ok) throw new Error('Falha ao consultar o Supabase');
  return response.json();
};
const matchesPayment = (providerPayment, payment) =>
  providerPayment.external_reference === payment.experience_id &&
  providerPayment.currency_id === 'BRL' &&
  Number.isFinite(Number(providerPayment.transaction_amount)) &&
  Math.round(Number(providerPayment.transaction_amount) * 100) === payment.amount_cents;
const ownsPayment = async payment => {
  const [experience] = await rows(`experiences?id=eq.${payment.experience_id}&select=owner`);
  return !!experience && experience.owner === payment.user_id;
};

exports.handler = async ev => {
  try {
    if (!SU || !SK || !MP) return { statusCode: 503, body: 'indisponível' };
    const q = ev.queryStringParameters || {};
    let body = {};
    if (ev.body) {
      try { body = JSON.parse(ev.body); }
      catch { body = {}; }
    }
    const id = q['data.id'] || (body.data && body.data.id) || (q.topic === 'payment' && q.id);
    if (!id) return { statusCode: 200, body: 'ok' };
    const response = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + MP } });
    if (!response.ok) return { statusCode: 502, body: 'falha ao validar pagamento' };
    const p = await response.json();
    if (p.status === 'approved') {
      const [pay] = await rows('payments?provider_ref=eq.' + encodeURIComponent(String(p.id)) + '&provider=eq.mercadopago&select=id,experience_id,user_id,amount_cents,purpose,status');
      if (pay && pay.purpose === 'qr_custom' && ['pending', 'approved'].includes(pay.status) && p.payment_method_id === 'pix' && matchesPayment(p, pay) && await ownsPayment(pay)) {
        const now = new Date().toISOString();
        if (pay.status === 'pending') {
          const paid = await sb('payments?id=eq.' + pay.id + '&status=eq.pending', { method: 'PATCH', body: JSON.stringify({ status: 'approved', paid_at: now }) });
          if (!paid.ok) return { statusCode: 500, body: 'falha ao registrar pagamento' };
          if (!(await paid.json()).length) return { statusCode: 200, body: 'ok' };
        }
        const unlocked = await sb('experiences?id=eq.' + pay.experience_id, { method: 'PATCH', body: JSON.stringify({ qr_custom_paid: true }) });
        if (!unlocked.ok) return { statusCode: 500, body: 'falha ao liberar adicional' };
      }
    } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(p.status)) {
      const [pay] = await rows('payments?provider_ref=eq.' + encodeURIComponent(String(p.id)) + '&provider=eq.mercadopago&select=id,experience_id,user_id,amount_cents,purpose,status');
      if (pay && pay.purpose === 'qr_custom' && matchesPayment(p, pay) && await ownsPayment(pay)) {
        const reversible = ['refunded', 'charged_back'].includes(p.status);
        if ((!reversible && pay.status !== 'pending') || (reversible && !['pending', 'approved', p.status].includes(pay.status))) return { statusCode: 200, body: 'ok' };
        const updated = await sb('payments?id=eq.' + pay.id + '&status=eq.' + encodeURIComponent(pay.status), { method: 'PATCH', body: JSON.stringify({ status: p.status }) });
        if (!updated.ok) return { statusCode: 500, body: 'falha ao atualizar pagamento' };
        if (reversible) {
          const approved = await rows('payments?experience_id=eq.' + pay.experience_id + '&purpose=eq.qr_custom&status=eq.approved&select=id');
          if (!approved.length) {
            const revoked = await sb('experiences?id=eq.' + pay.experience_id, { method: 'PATCH', body: JSON.stringify({ qr_custom_paid: false }) });
            if (!revoked.ok) return { statusCode: 500, body: 'falha ao revogar adicional' };
          }
        }
      }
    }
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    return { statusCode: 500, body: 'erro' };
  }
};
