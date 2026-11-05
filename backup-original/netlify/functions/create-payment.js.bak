// Checkout: cria pedido e cobrança Pix (Mercado Pago ou chave própria) para qualquer produto conectado.
// O preço, o desconto e o cupom são calculados NO BANCO; o navegador só informa produto, método e código do cupom.
// Variáveis no Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MP_ACCESS_TOKEN (e MP_WEBHOOK_SECRET, recomendada)
const { buildPixPayload } = require('../lib/pix');
const L = require('../lib/payments');
const { R, sb, rows } = L;

const ACTIVE = 'status=in.(pending,in_process)';
const PRODUCTS = { qr_custom: { needsExp: true }, publish_experience: { needsExp: false } };

exports.handler = async ev => {
  const e = L.env();
  if (ev.httpMethod === 'GET') {
    try {
      const m = await L.availableMethods();
      const q = e.SU && e.SK ? await L.quote(null, 'qr_custom', null, false) : null;
      const price = q && q.ok ? q.final_cents : null;
      return R(200, { enabled: price !== null && (m.mercadopago || m.own_key || price === 0), methods: m, price_cents: price });
    } catch { return R(200, { enabled: false, methods: { mercadopago: false, own_key: false } }); }
  }
  if (ev.httpMethod !== 'POST') return R(405, { error: 'Método inválido' });
  if (!e.SU || !e.SK) return R(503, { error: 'O pagamento ainda não está configurado' });
  try {
    const u = await L.getUser(ev);
    if (!u) return R(401, { error: 'Faça login' });
    let body = {};
    try { body = JSON.parse(ev.body || '{}'); } catch { body = {}; }
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
      if (def.needsExp) return !!(await rows(await sb(`experiences?id=eq.${expId}&select=qr_custom_paid`)))[0]?.qr_custom_paid;
      const ents = await rows(await sb(`entitlements?user_id=eq.${u.id}&product_code=eq.${product}&revoked_at=is.null&select=quantity,consumed,expires_at`));
      return ents.some(x => x.consumed < x.quantity && (!x.expires_at || new Date(x.expires_at) > new Date()));
    };

    // Consulta de estado (botão "Verificar pagamento" e verificação periódica)
    if (body.action === 'status') {
      const [pay] = await rows(await sb(`payments?${scope}&select=id,provider,provider_ref,status&order=created_at.desc&limit=1`));
      if (pay && pay.provider === 'mercadopago' && pay.provider_ref && ['pending', 'in_process'].includes(pay.status) && e.MP) {
        const r = await L.mpFetch('/v1/payments/' + encodeURIComponent(pay.provider_ref));
        if (r.ok) await L.applyMpPayment(await r.json());
      }
      const [last] = await rows(await sb(`payments?${scope}&select=status,provider&order=created_at.desc&limit=1`));
      return R(200, { paid: await entitled(), status: last ? last.status : null, provider: last ? last.provider : null });
    }

    if (await entitled()) return R(200, { paid: true });
    if (def.needsExp && (!exp.content || exp.content.qrCustom !== true)) return R(403, { error: 'Selecione o QR personalizado antes de comprar' });

    const findPending = async () => (await rows(await sb(`payments?${scope}&${ACTIVE}&select=id,provider,provider_ref,amount_cents,status,coupon_code`)))[0];
    let payment = await findPending();

    // Preço final calculado no banco (promoção + cupom). O pedido pendente do próprio usuário não "gasta" o cupom.
    const q = await L.quote(u.id, product, body.coupon, true, payment && payment.id);
    if (!q.ok) return R(422, { error: q.error || 'Produto indisponível no momento' });
    const free = q.final_cents === 0;

    const avail = await L.availableMethods();
    const method = body.method === 'own_key' || body.method === 'pix_manual' ? 'pix_manual'
      : body.method === 'mercadopago' ? 'mercadopago' : (avail.mercadopago ? 'mercadopago' : 'pix_manual');
    if (!free) {
      if (method === 'mercadopago' && !avail.mercadopago) return R(503, { error: 'O Pix pelo Mercado Pago não está disponível no momento' });
      if (method === 'pix_manual' && !avail.own_key) return R(503, { error: 'O Pix por chave própria não está disponível no momento' });
    }
    const wanted = free ? 'free' : method;

    const cancelPending = async pay => {
      await sb(`payments?id=eq.${pay.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', status_detail: 'Substituído por novo pedido', updated_at: new Date().toISOString() }) });
      await L.logEvent(pay.id, 'replaced:' + pay.id, pay.status, 'cancelled', 'checkout', 'Substituído por novo pedido');
    };
    const createOrder = async () => {
      const r = await L.rpcJson('create_order', { p_uid: u.id, p_code: product, p_exp: def.needsExp ? expId : null, p_coupon: body.coupon || null, p_provider: wanted });
      if (r.ok) return { order: r.data };
      if (r.data && r.data.code === '23505') return { conflict: true };
      if (r.data && r.data.code === 'P0001') return { error: String(r.data.message || 'Não foi possível criar o pedido') };
      return { error: 'Não foi possível iniciar o pagamento' };
    };

    // Evita pedidos duplicados: reaproveita o pendente igual; qualquer mudança de método, valor ou cupom substitui o anterior
    if (payment && (payment.provider !== wanted || payment.amount_cents !== q.final_cents || (payment.coupon_code || null) !== (q.coupon_code || null))) {
      if (payment.provider === 'mercadopago' && payment.provider_ref && e.MP) {
        const r = await L.mpFetch('/v1/payments/' + encodeURIComponent(payment.provider_ref));
        const mp = r.ok ? await r.json() : null;
        if (mp && mp.status === 'approved') { await L.applyMpPayment(mp); return R(200, { paid: true }); }
      }
      await cancelPending(payment);
      payment = null;
    }
    if (!payment) {
      const made = await createOrder();
      if (made.error) return R(422, { error: made.error });
      if (made.conflict) payment = await findPending();
      else if (made.order.free) return R(200, { paid: true, free: true, orderId: made.order.order_id });
      else payment = (await rows(await sb(`payments?id=eq.${made.order.order_id}&select=id,provider,provider_ref,amount_cents,status,coupon_code`)))[0];
    }
    if (!payment) return R(409, { error: 'Já existe uma solicitação de pagamento em andamento. Tente novamente.' });
    if (free) return R(200, { paid: await entitled(), free: true, orderId: payment.id });

    const summary = { orderId: payment.id, amount: payment.amount_cents, original: q.original_cents, discount: q.discount_cents, coupon: q.coupon_code || null, product: q.product_name };

    if (wanted === 'pix_manual') {
      const cfg = await L.readConfig();
      const code = buildPixPayload({ key: cfg.key, name: cfg.display_name || cfg.holder, city: cfg.city, amountCents: payment.amount_cents, txid: 'AMR' + payment.id.replace(/-/g, '').slice(0, 22) });
      return R(200, { ...summary, method: 'pix_manual', status: payment.status, code,
        recipient: cfg.display_name || cfg.holder, bank: cfg.bank || '', instructions: cfg.instructions || '' });
    }

    // Mercado Pago: reutiliza a cobrança existente se ainda estiver válida
    if (payment.provider_ref) {
      const old = await L.mpFetch('/v1/payments/' + encodeURIComponent(payment.provider_ref));
      const existing = old.ok ? await old.json() : null;
      if (existing && existing.status === 'approved') { await L.applyMpPayment(existing); return R(200, { paid: true }); }
      const t = existing && existing.point_of_interaction && existing.point_of_interaction.transaction_data;
      if (existing && ['pending', 'in_process'].includes(existing.status) && t) {
        return R(200, { ...summary, method: 'mercadopago', status: payment.status, code: t.qr_code, qr: t.qr_code_base64 });
      }
      if (existing) {
        // cobrança expirada, recusada ou cancelada: registra e abre um pedido novo
        await L.applyMpPayment(existing);
        const fresh = await createOrder();
        if (fresh.error) return R(422, { error: fresh.error });
        if (fresh.conflict || fresh.order.free) return R(409, { error: 'Não foi possível gerar uma nova cobrança. Tente novamente.' });
        payment = (await rows(await sb(`payments?id=eq.${fresh.order.order_id}&select=id,provider,provider_ref,amount_cents,status,coupon_code`)))[0];
        summary.orderId = payment.id; summary.amount = payment.amount_cents;
      }
    }
    const r = await L.mpFetch('/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'amoria-order-' + payment.id },
      body: JSON.stringify({
        transaction_amount: payment.amount_cents / 100,
        description: 'AMORIA - ' + (q.product_name || 'Compra') + ' (pagamento único)',
        payment_method_id: 'pix',
        payer: { email: u.email },
        external_reference: payment.id,
        notification_url: e.SITE + '/.netlify/functions/mp-webhook'
      })
    });
    const p = await r.json();
    if (!r.ok) {
      await L.logEvent(payment.id, 'mp-error:' + payment.id + ':' + Date.now(), payment.status, 'error', 'checkout', 'Falha na API: ' + String(p.message || r.status).slice(0, 120));
      return R(502, { error: 'O Mercado Pago não respondeu. Tente novamente em instantes.' });
    }
    const saved = await sb(`payments?id=eq.${payment.id}`, { method: 'PATCH', body: JSON.stringify({ provider_ref: String(p.id), updated_at: new Date().toISOString() }) });
    if (!saved.ok) return R(502, { error: 'O pagamento foi criado; tente novamente para recuperar o QR Pix' });
    const t = p.point_of_interaction && p.point_of_interaction.transaction_data;
    if (!t || !t.qr_code) return R(502, { error: 'O Mercado Pago não devolveu o código Pix. Tente novamente.' });
    return R(200, { ...summary, method: 'mercadopago', status: 'pending', code: t.qr_code, qr: t.qr_code_base64 });
  } catch (err) {
    return R(500, { error: 'Falha ao gerar o Pix' });
  }
};
