// Webhook do Mercado Pago. Nunca confia no corpo da notificação: valida a assinatura (quando
// MP_WEBHOOK_SECRET existe), consulta o pagamento direto na API e só então atualiza pedido/adicional.
const L = require('../lib/payments');

exports.handler = async ev => {
  try {
    const e = L.env();
    if (!e.SU || !e.SK || !e.MP) return { statusCode: 503, body: 'indisponível' };
    const q = ev.queryStringParameters || {}, h = {};
    for (const k of Object.keys(ev.headers || {})) h[k.toLowerCase()] = ev.headers[k];
    let body = {};
    try { body = JSON.parse(ev.body || '{}'); } catch { body = {}; }
    const topic = q.topic || q.type || body.type || (body.action ? String(body.action).split('.')[0] : '');
    if (topic && topic !== 'payment') return { statusCode: 200, body: 'ignorado' };
    const id = q['data.id'] || (body.data && body.data.id) || (q.topic === 'payment' && q.id);
    if (!id) return { statusCode: 200, body: 'ok' };
    if (e.WS && !L.verifyMpSignature({ secret: e.WS, signature: h['x-signature'], requestId: h['x-request-id'], dataId: q['data.id'] || (body.data && body.data.id) })) {
      return { statusCode: 401, body: 'assinatura inválida' };
    }
    const response = await L.mpFetch('/v1/payments/' + encodeURIComponent(id));
    if (response.status === 404) return { statusCode: 200, body: 'pagamento desconhecido' };
    if (!response.ok) return { statusCode: 502, body: 'falha ao validar pagamento' };
    const result = await L.applyMpPayment(await response.json());
    if (!result.ok) return { statusCode: 500, body: result.error || 'erro' };
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    return { statusCode: 500, body: 'erro' };
  }
};
