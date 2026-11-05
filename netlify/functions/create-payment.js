// Checkout AMORIA: Pix direto por chave própria, com confirmação manual no ADM.
const { buildPixPayload } = require('../lib/pix');
const L = require('../lib/payments');
const { R, sb, rows } = L;
const ACTIVE = 'status=in.(pending,in_process)';
const PRODUCTS = { qr_standard: { needsExp: true }, qr_custom: { needsExp: true }, publish_experience: { needsExp: true } };

exports.handler = async ev => {
  const e = L.env();
  if (ev.httpMethod === 'GET') {
    try {
      const cfg = await L.readConfig();
      const ready = !!(e.SU && e.SK && L.ownReady(cfg));
      const q = ready ? await L.quote(null, 'qr_custom', null, false) : null;
      return R(200, { enabled: !!(q && q.ok), methods: { pix_manual: ready }, price_cents: q && q.ok ? q.final_cents : null });
    } catch (err) {
      console.error('[create-payment] config:', err.message || 'unknown');
      return R(503, { enabled: false, methods: { pix_manual: false }, error: 'Não foi possível consultar a configuração Pix.' });
    }
  }
  if (ev.httpMethod !== 'POST') return R(405, { error: 'Método inválido' });
  if (!e.SU || !e.SK) return R(503, { error: 'Pagamento ainda não configurado' });
  try {
    const u = await L.getUser(ev);
    if (!u) return R(401, { error: 'Faça login' });
    let body = {};
    try { body = JSON.parse(ev.body || '{}'); } catch {}
    const product = body.product || 'qr_custom', def = PRODUCTS[product];
    if (!def) return R(400, { error: 'Produto inválido' });
    const expId = body.expId;
    let exp = null;
    if (def.needsExp) {
      if (!/^[0-9a-f-]{36}$/i.test(expId || '')) return R(400, { error: 'Experiência inválida' });
      [exp] = await rows(await sb(`experiences?id=eq.${expId}&owner=eq.${u.id}&select=id,qr_custom_paid,content`));
      if (!exp) return R(404, { error: 'Experiência não encontrada' });
    }
    const scope = `user_id=eq.${u.id}&product_code=eq.${product}&` + (def.needsExp ? `experience_id=eq.${expId}` : 'experience_id=is.null');
    const entitled = async () => {
      if (product === 'qr_custom' && exp.qr_custom_paid) return true;
      if (product === 'publish_experience' && exp.paid) return true;
      const ents = await rows(await sb(`entitlements?user_id=eq.${u.id}&product_code=eq.${product}&experience_id=eq.${expId}&revoked_at=is.null&select=quantity,consumed,expires_at`));
      return ents.some(x => x.consumed < x.quantity && (!x.expires_at || new Date(x.expires_at) > new Date()));
    };
    if (body.action === 'status') {
      const [last] = await rows(await sb(`payments?${scope}&select=status,provider&order=created_at.desc&limit=1`));
      return R(200, { paid: await entitled(), status: last ? last.status : null, provider: last ? last.provider : null });
    }
    if (await entitled()) return R(200, { paid: true });
    if (product === 'qr_custom' && (!exp.content || exp.content.qrCustom !== true)) return R(403, { error: 'Selecione o QR personalizado antes de comprar' });
    const cfg = await L.readConfig();
    if (!L.ownReady(cfg)) return R(503, { error: 'Pix direto ainda não foi configurado no painel ADM' });
    const findPending = async () => (await rows(await sb(`payments?${scope}&${ACTIVE}&select=id,provider,amount_cents,status,coupon_code`)))[0];
    let payment = await findPending();
    const q = await L.quote(u.id, product, body.coupon, true, payment && payment.id);
    if (!q.ok) return R(422, { error: q.error || 'Produto indisponível no momento' });
    const free = q.final_cents === 0;
    const cancelPending = async pay => {
      await sb(`payments?id=eq.${pay.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', status_detail: 'Substituído por novo pedido', updated_at: new Date().toISOString() }) });
      await L.logEvent(pay.id, 'replaced:' + pay.id, pay.status, 'cancelled', 'checkout', 'Substituído por novo pedido');
    };
    const createOrder = async () => {
      const r = await L.rpcJson('create_order', { p_uid: u.id, p_code: product, p_exp: def.needsExp ? expId : null, p_coupon: body.coupon || null, p_provider: free ? 'free' : 'pix_manual' });
      if (r.ok) return { order: r.data };
      if (r.data && r.data.code === '23505') return { conflict: true };
      return { error: 'Não foi possível iniciar o pedido' };
    };
    if (payment && (payment.provider !== (free ? 'free' : 'pix_manual') || payment.amount_cents !== q.final_cents || (payment.coupon_code || null) !== (q.coupon_code || null))) {
      await cancelPending(payment); payment = null;
    }
    if (!payment) {
      const made = await createOrder();
      if (made.error) return R(422, { error: made.error });
      if (made.conflict) payment = await findPending();
      else if (made.order.free) return R(200, { paid: true, free: true, orderId: made.order.order_id });
      else payment = (await rows(await sb(`payments?id=eq.${made.order.order_id}&select=id,provider,amount_cents,status,coupon_code`)))[0];
    }
    if (!payment) return R(409, { error: 'Já existe um pedido em andamento. Tente novamente.' });
    if (free) return R(200, { paid: await entitled(), free: true, orderId: payment.id });
    const code = buildPixPayload({ key: cfg.key, name: cfg.display_name || cfg.holder, city: cfg.city, amountCents: payment.amount_cents, txid: 'AMR' + payment.id.replace(/-/g, '').slice(0, 22) });
    return R(200, { orderId: payment.id, amount: payment.amount_cents, original: q.original_cents, discount: q.discount_cents, coupon: q.coupon_code || null, product: q.product_name, method: 'pix_manual', status: payment.status, code, recipient: cfg.display_name || cfg.holder, bank: cfg.bank || '', instructions: cfg.instructions || '', manual_confirmation: true });
  } catch (err) {
    console.error('[create-payment] failed:', err.message || 'unknown');
    return R(500, { error: 'Falha ao gerar o Pix' });
  }
};
