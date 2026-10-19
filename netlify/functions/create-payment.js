// Cria uma cobrança PIX avulsa para o QR personalizado escolhido pelo usuário.
// Variáveis no Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MP_ACCESS_TOKEN
const SU = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), SK = process.env.SUPABASE_SERVICE_ROLE_KEY, MP = process.env.MP_ACCESS_TOKEN, SITE = process.env.URL || process.env.DEPLOY_PRIME_URL;
const H = { 'Content-Type': 'application/json' };
const R = (c, o) => ({ statusCode: c, headers: H, body: JSON.stringify(o) });
const sb = (p, o = {}) => fetch(SU + '/rest/v1/' + p, { ...o, headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation', ...o.headers } });

exports.handler = async ev => {
  if (ev.httpMethod === 'GET') {
    if (!SU || !SK || !MP || !SITE) return R(200, { enabled: false });
    try {
      const [settings, provider] = await Promise.all([
        sb('settings?key=eq.billing&select=value'),
        fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: 'Bearer ' + MP } })
      ]);
      const rows = settings.ok ? await settings.json() : [];
      const price = Number(rows[0] && rows[0].value.qr_custom_cents) || 699;
      return R(200, { enabled: settings.ok && provider.ok && Number.isSafeInteger(price) && price >= 100 });
    } catch {
      return R(200, { enabled: false });
    }
  }
  if (ev.httpMethod !== 'POST') return R(405, { error: 'Método inválido' });
  if (!SU || !SK || !MP || !SITE) return R(503, { error: 'O pagamento do QR personalizado ainda não está configurado' });
  try {
    const headers = ev.headers || {};
    const authHeader = (headers.authorization || headers.Authorization || '').toString();
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const u = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + jwt } }).then(r => (r.ok ? r.json() : null));
    if (!u || !u.id) return R(401, { error: 'Faça login' });
    let payload = {};
    if (ev.body) {
      try { payload = JSON.parse(ev.body); }
      catch { payload = {}; }
    }
    const { expId } = payload;
    if (!/^[0-9a-f-]{36}$/i.test(expId || '')) return R(400, { error: 'Experiência inválida' });
    const [e] = await sb(`experiences?id=eq.${expId}&owner=eq.${u.id}&select=id,qr_custom_paid,content`).then(r => r.json());
    if (!e) return R(404, { error: 'Experiência não encontrada' });
    if (e.qr_custom_paid) return R(200, { paid: true });
    if (!e.content || e.content.qrCustom !== true) return R(403, { error: 'Selecione o QR personalizado antes de comprar' });
    const [b] = await sb('settings?key=eq.billing&select=value').then(r => r.json());
    let price = Number(b && b.value.qr_custom_cents) || 699;
    if (!Number.isSafeInteger(price) || price < 100) return R(503, { error: 'Preço do adicional QR inválido' });
    const findPayment = async (status) => {
      const response = await sb(`payments?experience_id=eq.${expId}&user_id=eq.${u.id}&purpose=eq.qr_custom&status=eq.${encodeURIComponent(status)}&select=id,experience_id,user_id,purpose,status,provider,provider_ref,amount_cents`);
      if (!response.ok) throw new Error(`Não foi possível consultar o pagamento ${status}`);
      return (await response.json())[0];
    };
    const approvedPayment = await findPayment('approved').catch(() => null);
    if (approvedPayment && approvedPayment.status === 'approved') return R(200, { paid: true });
    let payment = await findPayment('pending').catch(() => null);
    if (!payment) {
      const created = await sb('payments', { method: 'POST', body: JSON.stringify({ experience_id: e.id, user_id: u.id, amount_cents: price, purpose: 'qr_custom', provider: 'mercadopago' }) });
      if (created.ok) payment = (await created.json())[0];
      else if (created.status === 409) payment = await findPending();
      else return R(502, { error: 'Não foi possível iniciar o pagamento' });
    }
    if (!payment) return R(409, { error: 'Já existe uma solicitação de pagamento em andamento' });
    if (payment.experience_id !== e.id || payment.user_id !== u.id || payment.purpose !== 'qr_custom' || payment.status !== 'pending') return R(409, { error: 'O pagamento pendente não corresponde a esta experiência e usuário' });
    price = Number(payment.amount_cents);
    if (!Number.isSafeInteger(price) || price < 100 || payment.provider !== 'mercadopago') return R(409, { error: 'O pagamento pendente não é válido. Atualize a página e tente novamente.' });
    if (payment.provider_ref) {
      const old = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(payment.provider_ref), { headers: { Authorization: 'Bearer ' + MP } });
      const existing = old.ok ? await old.json() : null;
      const transaction = existing && existing.point_of_interaction && existing.point_of_interaction.transaction_data;
      if (existing && (existing.status !== 'pending' || existing.payment_method_id !== 'pix' || existing.external_reference !== e.id || existing.currency_id !== 'BRL' || Math.round(Number(existing.transaction_amount) * 100) !== price)) return R(409, { error: 'Este pagamento não está mais pendente ou não corresponde a esta experiência. Aguarde a atualização do status.' });
      if (transaction && transaction.qr_code && transaction.qr_code_base64) return R(200, { code: transaction.qr_code, qr: transaction.qr_code_base64, amount: price });
      if (existing) return R(502, { error: 'Não foi possível recuperar o código PIX pendente' });
    }
    const r = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MP, 'Content-Type': 'application/json', 'X-Idempotency-Key': 'amoria-qr-' + payment.id },
      body: JSON.stringify({
        transaction_amount: price / 100,
        description: 'AMORIA - QR Code personalizado (pagamento único)',
        payment_method_id: 'pix',
        payer: { email: u.email },
        external_reference: e.id,
        notification_url: SITE.replace(/\/$/, '') + '/.netlify/functions/mp-webhook'
      })
    });
    const p = await r.json();
    if (!r.ok) return R(502, { error: p.message || 'Erro no Mercado Pago' });
    if (!p.id || p.status !== 'pending' || p.payment_method_id !== 'pix' || p.external_reference !== e.id || p.currency_id !== 'BRL' || Math.round(Number(p.transaction_amount) * 100) !== price) return R(502, { error: 'O Mercado Pago retornou um pagamento diferente do esperado' });
    const t = p.point_of_interaction && p.point_of_interaction.transaction_data;
    if (!t || !t.qr_code || !t.qr_code_base64) return R(502, { error: 'O Mercado Pago não retornou um código PIX válido' });
    const saved = await sb(`payments?id=eq.${payment.id}`, { method: 'PATCH', body: JSON.stringify({ provider_ref: String(p.id) }) });
    if (!saved.ok) return R(502, { error: 'O pagamento foi criado; tente novamente para recuperar o QR PIX' });
    return R(200, { code: t.qr_code, qr: t.qr_code_base64, amount: price });
  } catch (err) {
    return R(500, { error: 'Falha ao gerar o PIX' });
  }
};
