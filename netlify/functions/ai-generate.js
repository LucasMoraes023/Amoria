// AMORIA AI Studio — gera textos (Anthropic) e inicia fundos com IA (OpenAI, em segundo plano).
// O navegador nunca recebe chaves, e só envia opções fechadas e textos curtos e validados.
const A = require('../lib/ai');
const L = require('../lib/payments');
const { R, sb, rows } = L;

const settings = async () => (await rows(await sb('ai_settings?slot=eq.true&select=*')))[0];
const keys = () => ({ text: !!process.env.ANTHROPIC_API_KEY, image: !!process.env.OPENAI_API_KEY });
const REASON = { disabled: 'A IA ainda não foi ativada para este site.', budget: 'O limite mensal de uso da IA foi atingido. Tente novamente no próximo mês.', limit: 'Você atingiu o limite diário de gerações com IA. Tente novamente amanhã.' };

exports.handler = async ev => {
  const e = L.env();
  if (!e.SU || !e.SK) return R(503, { error: 'A IA ainda não está configurada.' });
  try {
    const u = await L.getUser(ev);
    if (ev.httpMethod === 'GET') {
      if (!u) return R(200, { text: false, image: false });
      const [s, q] = [await settings(), (await L.rpcJson('ai_quota', { p_uid: u.id })).data], k = keys();
      if (!s || !q) return R(200, { text: false, image: false });
      const tl = Math.max(0, q.text_limit - q.text_used), il = Math.max(0, q.image_limit - q.image_used);
      return R(200, { text: !!(q.text_enabled && k.text && q.budget_ok && tl > 0), image: !!(q.image_enabled && k.image && q.budget_ok && il > 0 && e.SITE),
        text_left: tl, image_left: il, configured: !!((q.text_enabled && k.text) || (q.image_enabled && k.image)) });
    }
    if (ev.httpMethod !== 'POST') return R(405, { error: 'Método inválido' });
    if (!u) return R(401, { error: 'Faça login para usar a IA.' });
    if ((ev.body || '').length > 5000) return R(413, { error: 'Pedido muito grande.' });
    let body; try { body = JSON.parse(ev.body || '{}'); } catch { return R(400, { error: 'Pedido inválido' }); }

    // Acompanhamento de uma imagem em segundo plano
    if (body.action === 'job') {
      const id = parseInt(body.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return R(400, { error: 'Pedido inválido' });
      const [job] = await rows(await sb(`ai_usage?id=eq.${id}&user_id=eq.${u.id}&kind=eq.image&select=status,error,result_url,result_path,created_at`));
      if (!job) return R(404, { error: 'Geração não encontrada.' });
      if (job.status === 'pending' && Date.now() - new Date(job.created_at).getTime() > 6 * 60 * 1000) {
        await L.rpcJson('ai_finish', { p_id: id, p_status: 'error', p_error: 'Tempo esgotado na geração em segundo plano', p_in: null, p_out: null });
        return R(200, { status: 'error', error: 'A geração demorou demais. Tente novamente.' });
      }
      if (job.status === 'ok') return R(200, { status: 'ok', url: job.result_url, path: job.result_path });
      if (job.status === 'error') return R(200, { status: 'error', error: 'Não foi possível gerar a imagem agora.' });
      return R(200, { status: 'pending' });
    }

    let inp; try { inp = A.parseInput(body); } catch (err) { return R(400, { error: err.message }); }
    const s = await settings(), k = keys();
    if (!s) return R(503, { error: 'A IA ainda não está configurada.' });
    const image = inp.kind === 'image';
    if (image ? !(s.image_enabled && k.image && e.SITE) : !(s.text_enabled && k.text)) return R(503, { error: REASON.disabled });
    const model = image ? s.image_model : s.text_model;
    const begin = await L.rpcJson('ai_begin', { p_uid: u.id, p_kind: image ? 'image' : 'text', p_tool: inp.tool, p_model: model });
    if (!begin.ok || !begin.data) return R(503, { error: 'Não foi possível iniciar a geração.' });
    if (!begin.data.ok) return R(429, { error: REASON[begin.data.reason] || REASON.disabled, reason: begin.data.reason });
    const id = begin.data.id, fail = async (err, code) => {
      await L.rpcJson('ai_finish', { p_id: id, p_status: 'error', p_error: (err && err.internal) || 'Falha inesperada', p_in: null, p_out: null });
      return R(err && err.status || code || 502, { error: err && err.status ? err.message : 'Não foi possível gerar agora. Tente novamente.' });
    };

    if (image) {
      try {
        const sig = A.sign(e.SK, String(id), u.id);
        const r = await fetch(e.SITE + '/.netlify/functions/ai-image-background', { method: 'POST', headers: { 'content-type': 'application/json', 'x-amoria-signature': sig },
          body: JSON.stringify({ job: id, uid: u.id, params: { tool: 'fundo_imagem', style: inp.style, palette: inp.palette, layout: inp.layout, elements: inp.elements } }) });
        if (!r.ok && r.status !== 202) throw new A.ProviderError('Não foi possível iniciar a geração.', 502, 'Falha ao iniciar a função em segundo plano (HTTP ' + r.status + ')');
        return R(202, { job: id, status: 'pending' });
      } catch (err) { return fail(err); }
    }

    try {
      const p = A.buildPrompt(inp, s.max_tokens);
      const out = await A.callAnthropic({ key: process.env.ANTHROPIC_API_KEY, model, system: p.system, user: p.user, maxTokens: p.maxTokens });
      let result = { text: out.text, truncated: out.truncated };
      if (p.json) { try { result = { data: A.validateStructured(inp.tool, out.text) }; } catch (verr) { return fail({ status: 502, message: 'A IA não devolveu um resultado utilizável. Tente novamente.', internal: verr.message }); } }
      await L.rpcJson('ai_finish', { p_id: id, p_status: 'ok', p_error: null, p_in: out.usage.input_tokens || 0, p_out: out.usage.output_tokens || 0 });
      const q = (await L.rpcJson('ai_quota', { p_uid: u.id })).data;
      return R(200, { ...result, tool: inp.tool, left: q ? Math.max(0, q.text_limit - q.text_used) : null });
    } catch (err) { return fail(err); }
  } catch (err) { return R(500, { error: 'Falha ao gerar com IA.' }); }
};
