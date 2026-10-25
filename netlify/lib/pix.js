// Geração e validação do payload Pix (BR Code / EMV) para a modalidade de chave própria.
// Não depende de rede. O QR/código gerado aqui é ESTÁTICO: o banco não avisa o site quando o dinheiro entra.
const crc16 = s => {
  let c = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
};
const field = (id, value) => id + String(value.length).padStart(2, '0') + value;
// Nome e cidade do recebedor: ASCII, maiúsculas, sem acentos (exigência do BR Code)
const ascii = (s, max) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);

function buildPixPayload({ key, name, city, amountCents, txid }) {
  if (!key || String(key).length > 77) throw new Error('Chave Pix inválida');
  const n = ascii(name, 25), c = ascii(city, 15);
  if (!n) throw new Error('Nome do recebedor inválido');
  if (!c) throw new Error('Cidade do recebedor inválida');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Valor inválido');
  const tx = String(txid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const body = field('00', '01') + field('01', '11')
    + field('26', field('00', 'BR.GOV.BCB.PIX') + field('01', String(key)))
    + field('52', '0000') + field('53', '986') + field('54', (amountCents / 100).toFixed(2))
    + field('58', 'BR') + field('59', n) + field('60', c) + field('62', field('05', tx)) + '6304';
  return body + crc16(body);
}

// Confere CRC e estrutura mínima de um payload; usado no teste do painel.
function checkPixPayload(code) {
  if (typeof code !== 'string' || code.length < 40 || code.length > 512) return false;
  if (!/^[\x20-\x7E]+$/.test(code)) return false;
  if (code.slice(-8, -4) !== '6304') return false;
  if (crc16(code.slice(0, -4)) !== code.slice(-4)) return false;
  let i = 0;
  while (i < code.length) {
    const len = parseInt(code.slice(i + 2, i + 4), 10);
    if (!Number.isInteger(len)) return false;
    i += 4 + len;
  }
  return i === code.length;
}

module.exports = { crc16, buildPixPayload, checkPixPayload, ascii };
