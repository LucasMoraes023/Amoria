const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const lines = html.split('\n');
const sourceLine = prefix => {
  const line = lines.find(value => value.startsWith(prefix));
  assert.ok(line, `Missing source function: ${prefix}`);
  return line;
};
const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const paymentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const user = { id: userId, email: 'buyer@example.test' };
const payment = {
  id: paymentId,
  experience_id: uuid,
  user_id: userId,
  amount_cents: 699,
  provider: 'mercadopago',
  provider_ref: 'mp-payment-1',
  purpose: 'qr_custom',
  status: 'pending'
};

process.env.SUPABASE_URL = 'https://supabase.example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-key';
process.env.MP_ACCESS_TOKEN = 'server-only-test-token';
process.env.URL = 'https://amoria.example.test';

const createPayment = require('../netlify/functions/create-payment').handler;
const mpWebhook = require('../netlify/functions/mp-webhook').handler;

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

function renderQrEditor({ enabled, custom = true, price = 699, dbid = '', supabase = true }) {
  const setup = `
    let SB = ${supabase ? '{}' : 'null'};
    let QR_PAYMENT_ENABLED = ${JSON.stringify(enabled)};
    let D = { qrCustom: ${JSON.stringify(custom)}, dbid: ${JSON.stringify(dbid)}, qrModel: 'romance', qrFg: '#5b1026', qrBg: '#fff1f2', qrTitle: 'Title', qrFooter: 'Footer', qrFrame: 'romantic', qrMargin: 4, qrSize: 2048, qrPhoto: '' };
    let BILL = { qr_custom_cents: ${price} };
    const QR_ADDON_CENTS = 699, QR_UNDO = [];
    const money = cents => (cents / 100).toFixed(2);
    const esc = value => String(value);
    const inp = (label, key) => '<input data-k="' + key + '">';
    ${sourceLine('function qrPaymentMessage(')}
    ${sourceLine('function qrEditor()')}
    return qrEditor();
  `;
  return new Function(setup)();
}

test('payment-disabled state renders the full editor, says checkout is unavailable, and keeps standard QR free', async () => {
  const editor = renderQrEditor({ enabled: false });
  for (const model of ['romance', 'aniversario', 'casamento', 'presente']) {
    assert.ok(editor.includes(`data-a="qr-model:${model}"`));
  }
  for (const key of ['qrFg', 'qrBg', 'qrFrame', 'qrTitle', 'qrFooter', 'qrMargin', 'qrSize']) {
    assert.ok(editor.includes(`data-k="${key}"`));
  }
  assert.match(editor, /Foto decorativa/);
  assert.match(editor, /qr-undo/);
  assert.match(editor, /qr-reset/);
  assert.match(editor, /qr-preview/);
  assert.match(editor, /temporariamente indisponível/);
  assert.match(editor, /QR padrão continua gratuito/);
});

test('missing Supabase configuration keeps every QR option visible and warns that changes are not saved or published', () => {
  const editor = renderQrEditor({ enabled: false, supabase: false });
  assert.match(editor, /Adicionar QR Code personalizado/);
  assert.match(editor, /Romântico/);
  assert.match(editor, /Aniversário/);
  assert.match(editor, /Casamento/);
  assert.match(editor, /Presente/);
  assert.match(editor, /não serão salvas nem publicadas/);
  assert.match(editor, /apenas uma prévia|opções não serão salvas/);
  assert.match(editor, /QR padrão gratuito continua disponível/);
});

test('payment-enabled state shows configured price and a persisted experience gets its public QR destination', () => {
  const editor = renderQrEditor({ enabled: true, price: 1299 });
  assert.match(editor, /12\.99/);
  assert.match(editor, /confirmação do servidor/);

  const destination = new Function('draft', 'location', `${sourceLine('function qrDestination(')}; return qrDestination(draft);`);
  assert.equal(destination({ slug: 'abc12345' }, { href: 'https://amoria.example.test/#/criar' }), '');
  assert.equal(
    destination({ slug: 'abc12345', dbid: uuid }, { href: 'https://amoria.example.test/#/criar' }),
    'https://amoria.example.test/#/amor/abc12345'
  );
});

test('draft preview remains visual but uses a clearly identified valid homepage URL', async () => {
  const image = {}, destination = {};
  const encoded = [];
  const createPreview = new Function('draft', 'nodes', 'location', 'encoded', `
    const D = draft;
    const $ = selector => nodes[selector] || null;
    const loadQrPhoto = async () => {};
    const qrStyle = () => ({ fg: '#5b1026' });
    const qrCanvas = (url, size, style) => { encoded.push({ url, size, style }); return { toDataURL: () => 'data:image/png;base64,preview' }; };
    ${sourceLine('function qrDestination(')}
    ${sourceLine('async function drawQrPreview(')}
    return drawQrPreview;
  `);
  await createPreview(
    { qrCustom: true },
    { '#qr-preview': image, '#qr-destination': destination },
    { href: 'https://amoria.example.test/#/criar' },
    encoded
  )();
  assert.equal(encoded[0].url, 'https://amoria.example.test/');
  assert.equal(image.src, 'data:image/png;base64,preview');
  assert.match(image.alt, /exemplo abre a página inicial/);
  assert.match(destination.textContent, /QR definitivo será gerado após publicar/);
});

test('customized publishing without Supabase is blocked and never saves or shows success', async () => {
  const publishSource = sourceLine('async function publish(');
  const effects = { saved: false, completed: false, messages: [] };
  const publish = new Function('effects', `
    let SB = null;
    const D = { qrCustom: true };
    const toast = message => effects.messages.push(message);
    const load = () => { throw new Error('local fallback must not run'); };
    const save = () => { effects.saved = true; };
    const done = () => { effects.completed = true; };
    const cloudPublish = () => { effects.completed = true; };
    const nid = () => 'new-id';
    const mkLink = async () => 'https://amoria.example.test';
    const safeGiftUrl = () => true;
    const qrContrast = () => 7;
    ${publishSource}
    return publish();
  `)(effects);
  await publish;
  assert.equal(effects.saved, false);
  assert.equal(effects.completed, false);
  assert.ok(effects.messages[0].includes('Conecte-se ao Supabase'));
});

test('free local publishing remains available when personalized QR is not selected', async () => {
  const publishSource = sourceLine('async function publish(');
  const effects = { saved: false, completed: false };
  await new Function('effects', `
    let SB = null;
    const D = { qrCustom: false, to: 'Recebe', from: 'Envia', msg: 'Mensagem', line: '', priv: 'public', giftUrl: '', id: '' };
    const toast = () => {};
    const load = () => [];
    const save = () => { effects.saved = true; return true; };
    const done = () => { effects.completed = true; };
    const cloudPublish = () => { throw new Error('cloud publish must not run'); };
    const nid = () => 'local-id';
    const mkLink = async () => 'https://amoria.example.test/#/amor/local-id';
    const safeGiftUrl = () => true;
    const qrContrast = () => 7;
    ${publishSource}
    return publish();
  `)(effects);
  assert.equal(effects.saved, true);
  assert.equal(effects.completed, true);
});

test('unpaid custom selection continues to generate the free standard QR', async () => {
  const qrSource = sourceLine('async function qrShow(');
  const renderedStyles = [];
  const nodes = { '#qri': {}, '#dlq': {} };
  const createQrShow = new Function('draft', 'canvasStyles', 'nodes', `
    let PR = 0, D2 = draft, D = draft, LK = 'https://amoria.example.test/#/amor/abc12345';
    const $ = selector => nodes[selector] || null;
    const loadQrPhoto = async () => {};
    const qrCanvas = (text, size, style) => { canvasStyles.push(style); return { toDataURL: () => 'data:image/png;base64,qr' }; };
    const printCv = () => qrCanvas(LK, 900, null);
    ${qrSource}
    return qrShow;
  `);
  const show = createQrShow({ qrCustom: true, qr_custom_paid: false, qrSize: 2048 }, renderedStyles, nodes);
  await show(0);
  assert.equal(renderedStyles[0], null);
  assert.equal(nodes['#qri'].src, 'data:image/png;base64,qr');
});

test('create-payment uses the owner, configured price, one stable idempotency key, and correct notification URL', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse(user);
    if (target.includes('/rest/v1/experiences?')) return jsonResponse([{ id: uuid, qr_custom_paid: false, content: { qrCustom: true } }]);
    if (target.includes('/rest/v1/settings?')) return jsonResponse([{ value: { qr_custom_cents: 699 } }]);
    if (target.includes('/rest/v1/payments?') && options.method !== 'POST') return jsonResponse([]);
    if (target.endsWith('/rest/v1/payments') && options.method === 'POST') return jsonResponse([{ ...payment, provider_ref: null }]);
    if (target === 'https://api.mercadopago.com/v1/payments' && options.method === 'POST') {
      return jsonResponse({
        id: 'mp-payment-1',
        status: 'pending',
        payment_method_id: 'pix',
        external_reference: uuid,
        currency_id: 'BRL',
        transaction_amount: 6.99,
        point_of_interaction: { transaction_data: { qr_code: 'pix-code', qr_code_base64: 'cGl4' } }
      });
    }
    if (target.includes('/rest/v1/payments?id=eq.')) return jsonResponse([payment]);
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    const result = await createPayment({
      httpMethod: 'POST',
      headers: { authorization: 'Bearer user-session-token' },
      body: JSON.stringify({ expId: uuid })
    });
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(body.amount, 699);
    assert.equal(body.code, 'pix-code');
    const providerCall = calls.find(call => call.target === 'https://api.mercadopago.com/v1/payments');
    assert.equal(providerCall.options.headers['X-Idempotency-Key'], `amoria-qr-${paymentId}`);
    const request = JSON.parse(providerCall.options.body);
    assert.equal(request.external_reference, uuid);
    assert.equal(request.transaction_amount, 6.99);
    assert.equal(request.notification_url, 'https://amoria.example.test/.netlify/functions/mp-webhook');
    assert.ok(calls.some(call => call.target.includes(`user_id=eq.${userId}`)));
  } finally {
    global.fetch = oldFetch;
  }
});

test('a matching pending PIX is reused without creating a duplicate payment', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse(user);
    if (target.includes('/rest/v1/experiences?')) return jsonResponse([{ id: uuid, qr_custom_paid: false, content: { qrCustom: true } }]);
    if (target.includes('/rest/v1/settings?')) return jsonResponse([{ value: { qr_custom_cents: 699 } }]);
    if (target.includes('/rest/v1/payments?')) return jsonResponse([payment]);
    if (target.includes('/v1/payments/mp-payment-1')) {
      return jsonResponse({
        id: 'mp-payment-1',
        status: 'pending',
        payment_method_id: 'pix',
        external_reference: uuid,
        currency_id: 'BRL',
        transaction_amount: 6.99,
        point_of_interaction: { transaction_data: { qr_code: 'existing-pix-code', qr_code_base64: 'cGl4' } }
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    const result = await createPayment({
      httpMethod: 'POST',
      headers: { authorization: 'Bearer user-session-token' },
      body: JSON.stringify({ expId: uuid })
    });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).code, 'existing-pix-code');
    assert.equal(calls.some(call => call.target === 'https://api.mercadopago.com/v1/payments' && call.options.method === 'POST'), false);
    assert.equal(calls.some(call => call.target.endsWith('/rest/v1/payments') && call.options.method === 'POST'), false);
  } finally {
    global.fetch = oldFetch;
  }
});

test('an unconfirmed provider payment cannot release the custom QR', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/v1/payments/mp-payment-1')) {
      return jsonResponse({ id: 'mp-payment-1', status: 'pending' });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    const result = await mpWebhook({ queryStringParameters: { 'data.id': 'mp-payment-1' } });
    assert.equal(result.statusCode, 200);
    assert.equal(calls.some(call => call.target.includes('/rest/v1/')), false);
  } finally {
    global.fetch = oldFetch;
  }
});

test('an approved webhook cannot revive a payment that was already rejected', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/v1/payments/mp-payment-1')) {
      return jsonResponse({
        id: 'mp-payment-1',
        status: 'approved',
        payment_method_id: 'pix',
        external_reference: uuid,
        currency_id: 'BRL',
        transaction_amount: 6.99
      });
    }
    if (target.includes('/rest/v1/payments?provider_ref=')) return jsonResponse([{ ...payment, status: 'rejected' }]);
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    const result = await mpWebhook({ queryStringParameters: { 'data.id': 'mp-payment-1' } });
    assert.equal(result.statusCode, 200);
    assert.equal(calls.some(call => call.options.method === 'PATCH'), false);
  } finally {
    global.fetch = oldFetch;
  }
});

test('approved webhook releases only a PIX payment linked to the same user and experience', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/v1/payments/mp-payment-1')) {
      return jsonResponse({
        id: 'mp-payment-1',
        status: 'approved',
        payment_method_id: 'pix',
        external_reference: uuid,
        currency_id: 'BRL',
        transaction_amount: 6.99
      });
    }
    if (target.includes('/rest/v1/payments?provider_ref=')) return jsonResponse([payment]);
    if (target.includes('/rest/v1/experiences?')) return jsonResponse([{ owner: userId }]);
    if (target.includes('/rest/v1/payments?id=') && options.method === 'PATCH') return jsonResponse([{ ...payment, status: 'approved' }]);
    if (target.includes('/rest/v1/experiences?id=') && options.method === 'PATCH') return jsonResponse([{ id: uuid, qr_custom_paid: true }]);
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    const result = await mpWebhook({ queryStringParameters: { 'data.id': 'mp-payment-1' } });
    assert.equal(result.statusCode, 200);
    assert.ok(calls.some(call => call.target.includes('/rest/v1/payments?id=') && call.options.method === 'PATCH'));
    assert.ok(calls.some(call => call.target.includes('/rest/v1/experiences?id=') && call.options.method === 'PATCH'));
  } finally {
    global.fetch = oldFetch;
  }
});

test('Supabase and payment-status network errors do not prevent metadata initialization', async () => {
  let navigated = false;
  let paymentStateRefreshed = false;
  const messages = [];
  const metaSource = sourceLine('async function meta()');
  const runMeta = new Function('settingsClient', 'fetchStatus', 'toast', 'logger', 'markReady', `
    let SB = settingsClient, U = null, MUS = [], TS = {}, BILL = { qr_custom_cents: 699 };
    let PROF = null, IS_PRIMARY_ADMIN = false, QR_PAYMENT_ENABLED = true;
    const fetch = fetchStatus;
    const console = logger;
    const refreshQrPaymentUi = () => markReady('payment-status');
    const nav = () => markReady('navigation');
    ${metaSource}
    return meta();
  `);
  const settingsClient = {
    from: table => table === 'music'
      ? { select: () => ({ eq: () => ({ order: () => Promise.reject(new Error('offline')) }) }) }
      : { select: () => Promise.reject(new Error('offline')) }
  };
  const errors = [];
  const logger = { error: (...args) => errors.push(args) };
  const toast = message => messages.push(message);
  const markReady = name => {
    if (name === 'navigation') navigated = true;
    if (name === 'payment-status') paymentStateRefreshed = true;
  };
  await runMeta(settingsClient, async () => { throw new Error('offline'); }, toast, logger, markReady);
  assert.equal(navigated, true);
  assert.equal(paymentStateRefreshed, true);
  assert.ok(messages.some(message => message.includes('Supabase')));
  assert.ok(errors.length >= 2);
});

test('webhook refuses to unlock an experience owned by a different user', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/v1/payments/mp-payment-1')) {
      return jsonResponse({
        id: 'mp-payment-1',
        status: 'approved',
        payment_method_id: 'pix',
        external_reference: uuid,
        currency_id: 'BRL',
        transaction_amount: 6.99
      });
    }
    if (target.includes('/rest/v1/payments?provider_ref=')) return jsonResponse([payment]);
    if (target.includes('/rest/v1/experiences?')) return jsonResponse([{ owner: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }]);
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    const result = await mpWebhook({ queryStringParameters: { 'data.id': 'mp-payment-1' } });
    assert.equal(result.statusCode, 200);
    assert.equal(calls.some(call => call.options.method === 'PATCH'), false);
  } finally {
    global.fetch = oldFetch;
  }
});
