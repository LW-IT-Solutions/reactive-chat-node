'use strict';
/**
 * One HTTP(S) request with curl-like semantics: a connect timeout, a total
 * timeout, optional fixed name resolution (curl --resolve: connect to the
 * given IP, keep Host header, TLS SNI and certificate name), optional
 * disabled certificate check, and an optional streaming data callback.
 *
 * Never rejects. Resolves to { code, body: Buffer, error: '' | <curl-like text> }.
 * Error texts follow curl_strerror() so reasons delivered to reactive.chat
 * read the same as with the PHP node.
 */
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const agents = new Map();

function agentFor(protocol, key, extra) {
  const id = protocol + '|' + key;
  let a = agents.get(id);
  if (!a) {
    const mod = protocol === 'https:' ? https : http;
    a = new mod.Agent({ keepAlive: true, ...extra });
    agents.set(id, a);
  }
  return a;
}

function destroyAgents() {
  for (const a of agents.values()) a.destroy();
  agents.clear();
}

/** Maps a Node.js socket/TLS error to curl_strerror() wording. */
function curlText(err, gotResponse) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || '';
  if (code === 'RC_TIMEOUT') return 'Timeout was reached';
  if (code === 'RC_BAD_URL') return 'URL using bad/illegal format or missing URL';
  if (code === 'RC_PROTOCOL') return 'Unsupported protocol';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'EAI_NONAME') {
    return "Couldn't resolve host name";
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') {
    return "Couldn't connect to server";
  }
  if (code === 'ETIMEDOUT') return 'Timeout was reached';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|HOSTNAME_MISMATCH/.test(code)) {
    return 'SSL peer certificate or SSH remote key was not OK';
  }
  if (/^ERR_SSL|^ERR_TLS|SSL|TLS/.test(code) || /SSL|TLS/.test(msg)) return 'SSL connect error';
  if (/^HPE_/.test(code)) return 'Weird server reply';
  if (!gotResponse && (code === 'ECONNRESET' || msg === 'socket hang up')) {
    return 'Server returned nothing (no headers, no status line)';
  }
  if (gotResponse) return 'Transferred a partial file';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'Failure when receiving data from the peer';
  return 'Failure when receiving data from the peer';
}

/** Splits scheme://authority/path?query without normalising the path (it is signed). */
function splitUrl(url) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(url);
  if (!m) return null;
  let parsed;
  try {
    parsed = new URL(m[1] + '://' + m[2] + '/');
  } catch (e) {
    return null;
  }
  const protocol = m[1].toLowerCase() + ':';
  const hostname = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : (protocol === 'https:' ? 443 : 80);
  const pathPart = m[3] === '' ? '/' : m[3];
  return {
    protocol, hostname, port, host: m[2].replace(/^[^@]*@/, ''),
    path: pathPart, query: m[4] === undefined ? '' : m[4],
    requestPath: pathPart + (m[4] === undefined ? '' : '?' + m[4]),
    auth: parsed.username ? decodeURIComponent(parsed.username) + ':' + decodeURIComponent(parsed.password) : '',
  };
}

/**
 * opts: url, method, headers (object), body (string|Buffer|null), timeoutMs,
 * connectTimeoutMs, resolve ({host, port, ip}|null), tlsVerify (bool),
 * onData (fn(Buffer)|null - when set the body is not collected).
 */
function request(opts) {
  return new Promise((resolveP) => {
    const u = splitUrl(opts.url);
    let settled = false;
    let gotResponse = false;
    let req = null;
    const chunks = [];
    let total = 0;
    let totalTimer = null;
    let connectTimer = null;
    let code = 0;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      resolveP({ code: error ? 0 : code, body: Buffer.concat(chunks, total), error: error || '' });
    };

    if (!u) { finish('URL using bad/illegal format or missing URL'); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { finish('Unsupported protocol'); return; }

    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (body !== null && body !== undefined) {
      body = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      headers['Content-Length'] = String(body.length);
    }
    if (u.auth && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
      headers.Authorization = 'Basic ' + Buffer.from(u.auth, 'utf8').toString('base64');
    }

    const tlsVerify = opts.tlsVerify !== false;
    const r = opts.resolve;
    const pinned = r && r.host === u.hostname.toLowerCase() && r.port === u.port ? r.ip : null;
    const extra = {};
    let agentKey = 'default';
    if (u.protocol === 'https:' && !tlsVerify) { extra.rejectUnauthorized = false; agentKey = 'noverify'; }
    if (pinned) {
      const family = net.isIP(pinned);
      extra.lookup = (hostname, lopts, cb) => {
        if (typeof lopts === 'function') { cb = lopts; lopts = {}; }
        if (lopts && lopts.all) cb(null, [{ address: pinned, family }]);
        else cb(null, pinned, family);
      };
      agentKey += '|pin:' + pinned;
    } else {
      extra.lookup = dns.lookup;
    }
    const agent = agentFor(u.protocol, agentKey + '|' + u.hostname + ':' + u.port, extra);
    const mod = u.protocol === 'https:' ? https : http;

    const reqOpts = {
      method: opts.method,
      hostname: u.hostname,
      port: u.port,
      path: u.requestPath,
      headers,
      agent,
      lookup: extra.lookup,
    };
    if (u.protocol === 'https:') {
      reqOpts.rejectUnauthorized = tlsVerify;
      if (!net.isIP(u.hostname)) reqOpts.servername = u.hostname;
    }

    try {
      req = mod.request(reqOpts);
    } catch (e) {
      finish(curlText(e, false));
      return;
    }

    const fail = (e) => {
      if (settled) return;
      const text = curlText(e, gotResponse);
      finish(text);
      try { req.destroy(); } catch (x) { /* ignore */ }
    };

    if (opts.timeoutMs > 0) {
      totalTimer = setTimeout(() => fail({ code: 'RC_TIMEOUT' }), opts.timeoutMs);
    }

    req.on('socket', (socket) => {
      if (!(socket.connecting || socket.pending) || !(opts.connectTimeoutMs > 0)) return;
      connectTimer = setTimeout(() => fail({ code: 'RC_TIMEOUT' }), opts.connectTimeoutMs);
      const done = () => clearTimeout(connectTimer);
      socket.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', done);
    });

    req.on('response', (res) => {
      gotResponse = true;
      code = res.statusCode || 0;
      res.on('data', (chunk) => {
        if (settled) return;
        if (opts.onData) {
          try { opts.onData(chunk); } catch (e) { /* a parser error must not kill the transfer */ }
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      });
      res.on('end', () => finish(''));
      res.on('aborted', () => fail({ code: 'ECONNRESET' }));
      res.on('error', (e) => fail(e));
    });
    req.on('error', (e) => fail(e));

    if (body) req.end(body);
    else req.end();
  });
}

module.exports = { request, splitUrl, curlText, destroyAgents };
