// Webhook do Mercado Pago: confirma o pagamento direto na API deles e libera a experiência.
const SU = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), SK = process.env.SUPABASE_SERVICE_ROLE_KEY, MP = process.env.MP_ACCESS_TOKEN;
const sb = (p, o = {}) => fetch(SU + '/rest/v1/' + p, { ...o, headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation', ...o.headers } });

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
      const [pay] = await sb('payments?provider_ref=eq.' + encodeURIComponent(String(p.id)) + '&select=id,experience_id,amount_cents,purpose').then(r => r.json());
      if (pay && pay.purpose === 'qr_custom' && p.external_reference === pay.experience_id && p.currency_id === 'BRL' && Math.round(p.transaction_amount * 100) === pay.amount_cents) {
        const now = new Date().toISOString();
        const paid = await sb('payments?id=eq.' + pay.id, { method: 'PATCH', body: JSON.stringify({ status: 'approved', paid_at: now }) });
        if (!paid.ok) return { statusCode: 500, body: 'falha ao registrar pagamento' };
        const unlocked = await sb('experiences?id=eq.' + pay.experience_id, { method: 'PATCH', body: JSON.stringify({ qr_custom_paid: true }) });
        if (!unlocked.ok) return { statusCode: 500, body: 'falha ao liberar adicional' };
      }
    } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(p.status)) {
      const [pay] = await sb('payments?provider_ref=eq.' + encodeURIComponent(String(p.id)) + '&select=id,experience_id,purpose').then(r => r.json());
      if (pay && pay.purpose === 'qr_custom') {
        const updated = await sb('payments?id=eq.' + pay.id, { method: 'PATCH', body: JSON.stringify({ status: p.status }) });
        if (!updated.ok) return { statusCode: 500, body: 'falha ao atualizar pagamento' };
        if (p.status === 'refunded' || p.status === 'charged_back') {
          const approved = await sb('payments?experience_id=eq.' + pay.experience_id + '&purpose=eq.qr_custom&status=eq.approved&select=id').then(r => r.json());
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
