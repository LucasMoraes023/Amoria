// Função em segundo plano (Netlify "-background": até 15 min). Só aceita chamadas assinadas por ai-generate.
const A = require('../lib/ai');
const L = require('../lib/payments');
const { sb, rows } = L;

exports.handler = async ev => {
  const e = L.env();
  let body = {};
  try { body = JSON.parse(ev.body || '{}'); } catch { return { statusCode: 400 }; }
  const h = {}; for (const k of Object.keys(ev.headers || {})) h[k.toLowerCase()] = ev.headers[k];
  const id = parseInt(body.job, 10), uid = String(body.uid || '');
  if (!e.SK || !Number.isSafeInteger(id) || !A.sameSig(h['x-amoria-signature'], A.sign(e.SK, String(id), uid))) return { statusCode: 401 };
  const [job] = await rows(await sb(`ai_usage?id=eq.${id}&user_id=eq.${encodeURIComponent(uid)}&kind=eq.image&status=eq.pending&select=id,model`));
  if (!job) return { statusCode: 404 };
  const finish = (st, err, url, path) => L.rpcJson('ai_finish', { p_id: id, p_status: st, p_error: err || null, p_in: null, p_out: null, p_url: url || null, p_path: path || null });
  try {
    const inp = A.parseInput(body.params);
    if (inp.kind !== 'image' || !process.env.OPENAI_API_KEY) throw new A.ProviderError('A IA não está configurada.', 503, 'Chave de imagens ausente');
    const model = job.model, bytes = await A.callOpenAIImage({ key: process.env.OPENAI_API_KEY, model, prompt: A.imagePrompt(inp), size: A.imageSize(model, inp.layout) });
    if (!bytes || bytes.length < 100 || bytes.length > 12 * 1024 * 1024) throw new A.ProviderError('A IA devolveu uma imagem inválida.', 502, 'Imagem fora do tamanho esperado');
    const path = `${uid}/ai/${require('crypto').randomUUID()}.png`;
    const up = await fetch(`${e.SU}/storage/v1/object/photos/${path}`, { method: 'POST', headers: { apikey: e.SK, Authorization: 'Bearer ' + e.SK, 'content-type': 'image/png', 'x-upsert': 'false' }, body: bytes });
    if (!up.ok) throw new A.ProviderError('Não foi possível salvar a imagem.', 502, 'Falha ao gravar no armazenamento (HTTP ' + up.status + ')');
    await finish('ok', null, `${e.SU}/storage/v1/object/public/photos/${path}`, path);
    return { statusCode: 200 };
  } catch (err) {
    await finish('error', (err && err.internal) || 'Falha inesperada');
    return { statusCode: 200 };
  }
};
