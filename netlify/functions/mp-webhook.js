// Webhook do Mercado Pago: valida a assinatura, consulta a API e só então atualiza o pedido.
const L = require('../lib/payments');

exports.handler = async ev => {
  try {
    const e = L.env();
    if (!e.SU || !e.SK || !e.MP || !e.WS) return { statusCode: 503, body: 'webhook não configurado' };
    const q = ev.queryStringParameters || {}, h = {};
    for (const k of Object.keys(ev.headers || {})) h[k.toLowerCase()] = ev.headers[k];
    let body = {};
    try { body = JSON.parse(ev.body || '{}'); } catch { body = {}; }
    const topic = q.topic || q.type || body.type || (body.action ? String(body.action).split('.')[0] : '');
    if (topic && topic !== 'payment') return { statusCode: 200, body: 'ignorado' };
    const dataId = q['data.id'] || (body.data && body.data.id);
    const id = dataId || (q.topic === 'payment' && q.id);
    if (!id) return { statusCode: 200, body: 'ok' };
    if (!dataId || !L.verifyMpSignature({ secret: e.WS, signature: h['x-signature'], requestId: h['x-request-id'], dataId })) {
      return { statusCode: 401, body: 'assinatura inválida' };
    }
    const response = await L.mpFetch('/v1/payments/' + encodeURIComponent(id));
    if (response.status === 404) return { statusCode: 200, body: 'pagamento desconhecido' };
    if (!response.ok) return { statusCode: 502, body: 'falha ao validar pagamento' };
    const result = await L.applyMpPayment(await response.json());
    if (!result.ok) return { statusCode: 500, body: result.error || 'erro' };
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[mp-webhook] processing failed:', err.message || 'unknown error');
    return { statusCode: 500, body: 'erro' };
  }
};
