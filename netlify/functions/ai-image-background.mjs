// Função em segundo plano (Netlify "-background": até 15 min). Só aceita chamadas assinadas por ai-generate.
import H from '../lib/ai-handlers.js';

export default H.v2(H.background);
