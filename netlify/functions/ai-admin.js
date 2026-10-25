// Estado da integração de IA para o painel admin. Só o admin principal. Nunca devolve valores de chaves.
const A = require('../lib/ai');
const L = require('../lib/payments');
const { R, rows, sb } = L;

exports.handler = async ev => {
  const e = L.env();
  if (!e.SU || !e.SK) return R(503, { error: 'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas no Netlify' });
  try {
    const u = await L.getUser(ev);
    if (!u) return R(401, { error: 'Faça login' });
    if (!(await L.isPrimaryAdmin(u.id))) return R(403, { error: 'Acesso restrito ao administrador principal' });
    if (ev.httpMethod === 'POST') {
      let body = {}; try { body = JSON.parse(ev.body || '{}'); } catch { body = {}; }
      const s = (await rows(await sb('ai_settings?slot=eq.true&select=*')))[0];
      if (body.target === 'text') {
        if (!process.env.ANTHROPIC_API_KEY) return R(200, { ok: false, detail: 'ANTHROPIC_API_KEY ausente no Netlify' });
        try { await A.callAnthropic({ key: process.env.ANTHROPIC_API_KEY, model: s.text_model, system: 'Responda apenas com a palavra: ok', user: 'ok', maxTokens: 16, timeoutMs: 8000 }); return R(200, { ok: true, detail: 'Chave aceita e modelo "' + s.text_model + '" respondeu.' }); }
        catch (err) { return R(200, { ok: false, detail: (err && err.internal) || 'Falha no teste' }); }
      }
      if (body.target === 'image') {
        if (!process.env.OPENAI_API_KEY) return R(200, { ok: false, detail: 'OPENAI_API_KEY ausente no Netlify' });
        try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY } }); return R(200, { ok: r.ok, detail: r.ok ? 'Credencial aceita pelo provedor de imagens (nenhuma imagem foi gerada neste teste).' : 'Falha na validação (HTTP ' + r.status + ')' }); }
        catch { return R(200, { ok: false, detail: 'Provedor de imagens inacessível' }); }
      }
      return R(400, { error: 'Alvo inválido' });
    }
    return R(200, { text_key: process.env.ANTHROPIC_API_KEY ? 'configurado' : 'ausente', image_key: process.env.OPENAI_API_KEY ? 'configurado' : 'ausente',
      background_url: e.SITE ? e.SITE + '/.netlify/functions/ai-image-background' : null, site_url: e.SITE || null });
  } catch { return R(500, { error: 'Falha ao consultar a integração' }); }
};
