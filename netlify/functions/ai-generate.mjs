// AMORIA AI Studio — gera textos (Anthropic) e inicia fundos com IA (OpenAI, em segundo plano).
// O navegador nunca recebe chaves, e só envia opções fechadas e textos curtos e validados.
import H from '../lib/ai-handlers.js';

export default H.v2(H.generate);
