'use strict';
/** PHP-compat helpers, config handling, model body and transport details. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const php = require('../lib/php');
const logic = require('../lib/logic');
const config = require('../lib/config');
const transport = require('../lib/transport');

test('json_encode like PHP', () => {
  assert.equal(php.jsonEncode({ a: 'x/y', b: '\u00E4' }, { unescapedUnicode: true }), '{"a":"x\\/y","b":"\u00E4"}');
  assert.equal(php.jsonEncode({ a: 'x/y', b: '\u00E4' }, { unescapedSlashes: true }), '{"a":"x/y","b":"\\u00e4"}');
  assert.equal(php.jsonEncode('\u2028\u0001\n', { unescapedUnicode: true }), '"\\u2028\\u0001\\n"');
  assert.equal(php.jsonEncode(new php.PhpFloat(1)), '1');
  assert.equal(php.jsonEncode(new php.PhpFloat(0.2)), '0.2');
  assert.equal(php.jsonEncode([]), '[]');
});

test('json_decode like PHP', () => {
  assert.equal(php.jsonDecode(''), null);
  assert.equal(php.jsonDecode('"\\ud800"'), null);
  assert.equal(php.jsonDecode(Buffer.from([0x22, 0xff, 0x22])), null);
  assert.deepEqual(php.jsonDecode('{"a":1}'), { a: 1 });
});

test('trim, casts, rawurlencode, mb_substr', () => {
  assert.equal(php.trim('\u00A0 x \n'), '\u00A0 x');
  assert.equal(php.toInt('12abc'), 12);
  assert.equal(php.toInt('1e3'), 1000);
  assert.equal(php.toInt(' 7'), 7);
  assert.equal(php.toStr(1.5), '1.5');
  assert.equal(php.toStr(true), '1');
  assert.equal(php.rawurlencode("chat,a b!*'()~"), 'chat%2Ca%20b%21%2A%27%28%29~');
  assert.equal(php.mbSubstr('\u{1F600}abc', 2), '\u{1F600}a');
  assert.equal(php.empty('0'), true);
  assert.equal(php.empty({}), true);
});

test('KEINE_ANTWORT: ASCII case folding only', () => {
  assert.equal(logic.isNoAnswer('Leider keine_antwort.'), true);
  assert.equal(logic.isNoAnswer('KE\u0130NE_ANTWORT'), false);
});

test('model body mirrors the reference', () => {
  const cfg = { model: 'm/1', temperature: 0.2, max_tokens: 300 };
  assert.equal(logic.modelBody(cfg, 'S', 'P \u00E4', 0, [], false),
    '{"model":"m\\/1","stream":false,"temperature":0.2,"max_tokens":300,"messages":'
    + '[{"role":"system","content":"S"},{"role":"user","content":"P \u00E4"}]}');
  assert.equal(logic.modelBody({ ...cfg, temperature: 1 }, 'S', 'P', 50, ['data:image/png;base64,AA=='], true),
    '{"model":"m\\/1","stream":true,"temperature":1,"max_tokens":50,"messages":'
    + '[{"role":"system","content":"S"},{"role":"user","content":[{"type":"text","text":"P"},'
    + '{"type":"image_url","image_url":{"url":"data:image\\/png;base64,AA=="}}]}]}');
});

const base = {
  base_url: 'https://reactive.chat', node_id: 'kn-1', secret: 'rcn_x', model: 'm', model_endpoint: 'http://127.0.0.1:1/v1',
};

test('config: defaults, aliases, env override', () => {
  const c = config.normalise({ ...base, kinds: ['chat', 'translation'], unknown_key: 1 },
    { RC_NODE_SECRET: 'rcn_env', RC_NODE_MODEL_API_KEY: 'k' });
  assert.deepEqual(c.kinds, ['chat', 'uebersetzung']);
  assert.deepEqual(c.can, ['chat', 'uebersetzung']);
  assert.equal(c.secret, 'rcn_env');
  assert.equal(c.model_api_key, 'k');
  assert.equal(c.poll_wait, 20);
  assert.equal(c.stream, true);
  assert.equal(c.log_file, '');
});

test('config errors', () => {
  const bad = [
    { ...base, node_id: 'x-1' },
    { ...base, secret: '' },
    { ...base, model_endpoint: '' },
    { ...base, kinds: ['embedding'] },
    { ...base, resolve: 'nonsense' },
    { ...base, timezone: 'Mars/Olympus' },
    [],
  ];
  for (const b of bad) assert.throws(() => config.normalise(b, {}), config.ConfigError);
  assert.doesNotThrow(() => config.normalise({ ...base, model_endpoint: '', chat_url: 'https://x/y' }, {}));
});

test('resolve parsing', () => {
  assert.deepEqual(config.parseResolve('reactive.chat:443:10.0.0.5'), { host: 'reactive.chat', port: 443, ip: '10.0.0.5' });
  assert.deepEqual(config.parseResolve('h:8443:[::1]'), { host: 'h', port: 8443, ip: '::1' });
});

test('splitUrl keeps the signed path and query', () => {
  const u = transport.splitUrl('https://example.test:8443/sub/v1/ki?action=hol&knoten=kn-1&nonce=ab');
  assert.equal(u.path, '/sub/v1/ki');
  assert.equal(u.query, 'action=hol&knoten=kn-1&nonce=ab');
  assert.equal(u.port, 8443);
  assert.equal(u.hostname, 'example.test');
});

test('transport: resolve pins the address and keeps the Host header', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.headers.host); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await transport.request({
      url: 'http://no-such-host.invalid:' + port + '/x', method: 'GET', headers: {}, body: null,
      timeoutMs: 5000, connectTimeoutMs: 2000, resolve: { host: 'no-such-host.invalid', port, ip: '127.0.0.1' },
    });
    assert.equal(r.error, '');
    assert.equal(r.code, 200);
    assert.equal(seen[0], 'no-such-host.invalid:' + port);
    const r2 = await transport.request({
      url: 'http://127.0.0.1:1/x', method: 'GET', headers: {}, body: null, timeoutMs: 5000, connectTimeoutMs: 2000,
    });
    assert.equal(r2.error, "Couldn't connect to server");
  } finally {
    transport.destroyAgents();
    srv.close();
  }
});

test('transport: total timeout', async () => {
  const srv = http.createServer(() => { /* never answers */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await transport.request({
      url: 'http://127.0.0.1:' + srv.address().port + '/', method: 'GET', headers: {}, body: null,
      timeoutMs: 300, connectTimeoutMs: 200,
    });
    assert.equal(r.error, 'Timeout was reached');
  } finally {
    transport.destroyAgents();
    srv.closeAllConnections();
    srv.close();
  }
});
