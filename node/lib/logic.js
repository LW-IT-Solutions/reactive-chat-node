'use strict';
/**
 * The pure parts of the node: signature, clean-up, number check, stream cut,
 * SSE parsing, image filter, reading model and embedding answers, building
 * request bodies. Everything here mirrors reference/rc-knoten.php v1.3 and is
 * covered by conformance/vectors.json.
 */
const crypto = require('node:crypto');
const php = require('./php');

/** Appended to the prompt for the one retry after an invented number (German on purpose - it goes to the model). */
const RETRY_SUFFIX = '\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, '
  + 'die nicht in den Quellen steht. Uebernimm Zahlen genau so, '
  + 'wie sie dort stehen, oder lass sie weg.';

// ---------------------------------------------------------------------------
// Signature (RC-KI-v2)
// ---------------------------------------------------------------------------
function stringToSign(ts, method, path, query, body) {
  return 'RC-KI-v2\n' + ts + '\n' + method + '\n' + path + '\n' + query + '\n' + (body == null ? '' : body);
}

function sign(secret, ts, method, path, query, body) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(stringToSign(ts, method, path, query, body), 'utf8'))
    .digest('hex');
}

function nonce() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Character classes of the reference's PCRE patterns.
// With /u PHP turns on UCP: \s, \d, \b and \R are Unicode-aware.
// ---------------------------------------------------------------------------
// \s under UCP = \p{Z} + \h + \v.
const WS_U = '\\t\\n\\x0B\\f\\r\\x85\\p{Z}\\u180E';
// \R in UTF mode.
const NL_U = '\\n\\x0B\\f\\r\\x85\\u2028\\u2029';
// \w under UCP (PCRE2 >= 10.43): letters, numbers, Mn, Pc.
const WORD_U = '\\p{L}\\p{N}\\p{Mn}\\p{Pc}';

// ---------------------------------------------------------------------------
// Number check (zahlenPruefen)
// ---------------------------------------------------------------------------
const THOUSANDS_RE = new RegExp('(\\p{Nd})[ .,\\u00A0\\u202F\\u2009](?=\\p{Nd}\\p{Nd}\\p{Nd}(?![' + WORD_U + ']))', 'gu');

function digitRuns(s) {
  const joined = s.replace(THOUSANDS_RE, '$1');
  // Second pattern has no /u: ASCII digits only.
  return joined.match(/[0-9]+/g) || [];
}

/** Returns the first digit sequence of text that is not in facts, or null. */
function checkNumbers(text, facts) {
  const allowed = new Set(digitRuns(php.toStr(facts)));
  for (const z of digitRuns(php.toStr(text))) {
    if (!allowed.has(z)) return z;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clean-up (saeubern)
// ---------------------------------------------------------------------------
const THINK_RE = /<think>[\s\S]*?<\/think>/gu;
const TAG_RE = /<[^>]*>/g;
// No /u in the reference: ASCII \s, ASCII case-insensitivity.
const LEAD_IN_RE = /^[\t\n\x0B\f\r ]*(hier (ist|sind)[^:\n]*:|here (is|are)[^:\n]*:|antwort:|answer:)[\t\n\x0B\f\r ]*/i;
const QUOTED_RE = /^["\u201C\u201E\u00AB]([\s\S]*)["\u201D\u201C\u00BB]$/u;
const LINEBREAK_RE = new RegExp('[' + WS_U + ']*[' + NL_U + '][' + WS_U + ']*', 'gu');
const MULTISPACE_RE = new RegExp('[' + WS_U + ']{2,}', 'gu');

function clean(text) {
  let t = php.toStr(text);
  t = t.replace(THINK_RE, ' ');
  t = t.replace(TAG_RE, ' ');
  for (const s of ['**', '__', '`', '#']) t = t.split(s).join('');
  t = php.trim(t);
  t = t.replace(LEAD_IN_RE, '');
  t = php.trim(t);
  const m = QUOTED_RE.exec(t);
  if (m) t = php.trim(m[1]);
  t = t.replace(LINEBREAK_RE, ' ');
  return php.trim(t.replace(MULTISPACE_RE, ' '));
}

/** stripos($s, 'KEINE_ANTWORT') !== false - ASCII case folding only. */
function isNoAnswer(s) {
  return s.replace(/[A-Z]+/g, (x) => x.toLowerCase()).includes('keine_antwort');
}

// ---------------------------------------------------------------------------
// Stream cut (stromSchnitt)
// ---------------------------------------------------------------------------
function isDigit(c) {
  return c >= '0' && c <= '9';
}

/**
 * The text up to and including the last whitespace - never half a word or
 * half a number. A space between digits (or after a digit at the very end)
 * may be a thousands separator ("1 000") and is not a cut point.
 * Whitespace and digits are ASCII, so UTF-16 indexing equals byte indexing here.
 */
function streamCut(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') continue;
    if (c === ' ' && i > 0 && isDigit(text[i - 1])
      && (i + 1 === text.length || isDigit(text[i + 1]))) continue;
    return text.slice(0, i + 1);
  }
  return '';
}

// ---------------------------------------------------------------------------
// SSE state of one streamed model call (stromNeu / stromFuettern / ...)
// ---------------------------------------------------------------------------
const RAW_CAP = 4 * 1024 * 1024;

class StreamState {
  constructor() {
    this.rawChunks = [];
    this.rawLen = 0;
    this.buffer = Buffer.alloc(0);
    this.text = '';
    this.sse = false;
    this.hasContent = false;
    this.ended = false;
    this.error = '';
  }

  /** The recorded body (capped like the reference) for non-SSE answers. */
  get raw() {
    return Buffer.concat(this.rawChunks, this.rawLen);
  }

  feed(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (this.rawLen < RAW_CAP) { this.rawChunks.push(data); this.rawLen += data.length; }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    let p;
    while ((p = this.buffer.indexOf(0x0a)) !== -1) {
      this.line(stripTrailingCR(this.buffer.subarray(0, p)));
      this.buffer = this.buffer.subarray(p + 1);
    }
  }

  /** Whatever follows the last newline, at the end of the call. */
  finish() {
    if (this.buffer.length) {
      const rest = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.line(stripTrailingCR(rest));
    }
  }

  /** One SSE line (bytes). Only "data: {...}" and "data: [DONE]" count. */
  line(bytes) {
    if (bytes.length < 5 || bytes.toString('latin1', 0, 5) !== 'data:') return;
    this.sse = true;
    const payloadBytes = bytes.subarray(5);
    const latin = php.trim(payloadBytes.toString('latin1'));
    if (latin === '[DONE]') { this.ended = true; return; }
    const j = php.jsonDecode(Buffer.from(latin, 'latin1'));
    if (!php.isArr(j)) return;
    // vLLM reports an error in the middle of a stream as its own event.
    if (php.isset(j, 'error') || php.pick(j, 'object', '') === 'error') {
      const f = php.pick(j, 'error', j);
      this.error = php.isArr(f) ? php.toStr(php.pick(f, 'message', 'Fehler ohne Text')) : php.toStr(f);
      return;
    }
    const c = php.pick(php.get(j, 'choices'), 0, null);
    if (!php.isArr(c)) return;
    const delta = php.get(c, 'delta');
    const content = php.get(delta, 'content');
    if (typeof content === 'string') {
      this.text += content;
      this.hasContent = true;
    }
    if (!php.empty(php.get(c, 'finish_reason'))) this.ended = true;
  }
}

function stripTrailingCR(buf) {
  let e = buf.length;
  while (e > 0 && buf[e - 1] === 0x0d) e--;
  return buf.subarray(0, e);
}

// ---------------------------------------------------------------------------
// Images of a job (bilderAusAuftrag)
// ---------------------------------------------------------------------------
// PCRE "$" also matches before one final "\n".
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*\n?$/;

function imagesFromJob(raw, imagesEnabled, imagesMax) {
  if (php.empty(imagesEnabled) || !php.isArr(raw)) return [];
  const max = Math.max(0, php.toInt(imagesMax));
  const out = [];
  for (const url of php.toList(raw)) {
    if (out.length >= max) break;
    if (typeof url !== 'string' || php.strlen(url) > 4 * 1024 * 1024) continue;
    if (!IMAGE_RE.test(url)) continue;
    out.push(url);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model request / answer (OpenAI style)
// ---------------------------------------------------------------------------
function modelBody(cfg, system, prompt, maxTokens, images, stream) {
  let content = php.toStr(prompt);
  if (Array.isArray(images) && images.length) {
    content = [{ type: 'text', text: php.toStr(prompt) }];
    for (const url of images) content.push({ type: 'image_url', image_url: { url: php.toStr(url) } });
  }
  return php.jsonEncode({
    model: cfg.model,
    stream: !!stream,
    temperature: new php.PhpFloat(php.toFloat(cfg.temperature)),
    max_tokens: maxTokens > 0 ? php.toInt(maxTokens) : php.toInt(cfg.max_tokens),
    messages: [
      { role: 'system', content: php.toStr(system) },
      { role: 'user', content },
    ],
  }, { unescapedUnicode: true });
}

function bodyText(raw) {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return php.toStr(raw);
}

/**
 * modellLesen: {text, ms, fehler}. text === null means failure; fehler is the
 * German reason that goes to reactive.chat.
 */
function readModel(code, raw, transportError, ms, stream) {
  if (transportError !== '') return { text: null, ms, fehler: 'Modell nicht erreichbar: ' + transportError };
  if (code !== 200) {
    return { text: null, ms, fehler: 'Modell HTTP ' + code + ': ' + php.mbSubstr(bodyText(raw), 160) };
  }
  if (stream && stream.sse) {
    if (stream.error !== '') return { text: null, ms, fehler: 'Modell-Strom: ' + php.mbSubstr(stream.error, 160) };
    if (!stream.hasContent) return { text: null, ms, fehler: 'Antwort ohne Text' };
    if (!stream.ended) return { text: null, ms, fehler: 'Strom ohne Abschluss' };
    return { text: stream.text, ms, fehler: '' };
  }
  let v = php.jsonDecode(Buffer.isBuffer(raw) ? raw : php.toStr(raw));
  for (const step of ['choices', 0, 'message', 'content']) {
    if (!php.isArr(v) || !php.isset(v, step)) return { text: null, ms, fehler: 'Antwort ohne Text' };
    v = v[step];
  }
  return { text: php.toStr(v), ms, fehler: '' };
}

// ---------------------------------------------------------------------------
// Embeddings (/v1/embeddings)
// ---------------------------------------------------------------------------
function embedBody(embedModel, texts) {
  return php.jsonEncode({ model: embedModel, input: texts.slice() }, { unescapedUnicode: true });
}

/**
 * einbettenLesen -> [payload|null, error]. Payload:
 * {"vektoren":["<base64 float32 LE>", ...],"dims":N,"modell":"..."}, sorted by index.
 */
function readEmbedding(code, raw, transportError, count, embedModel) {
  if (transportError !== '') return [null, 'Einbettungsserver nicht erreichbar: ' + transportError];
  if (code !== 200) return [null, 'Einbettung HTTP ' + code + ': ' + php.mbSubstr(bodyText(raw), 160)];
  const j = php.jsonDecode(Buffer.isBuffer(raw) ? raw : php.toStr(raw));
  if (!php.isArr(j) || !php.isset(j, 'data') || !php.isArr(j.data)) return [null, 'Einbettung unlesbar'];
  const idx = (x) => (php.isArr(x) ? php.toInt(php.pick(x, 'index', 0)) : 0);
  const data = php.toList(j.data).sort((x, y) => idx(x) - idx(y));
  const vectors = [];
  let dims = 0;
  for (const e of data) {
    const values = php.toList(php.isArr(e) ? php.pick(e, 'embedding', []) : []);
    if (values.length === 0 || (dims > 0 && values.length !== dims)) return [null, 'Vektor leer oder ungleich lang'];
    dims = values.length;
    const b = Buffer.alloc(4 * values.length);
    values.forEach((w, i) => b.writeFloatLE(php.toFloat(w), 4 * i));
    vectors.push(b.toString('base64'));
  }
  if (vectors.length !== count) return [null, vectors.length + ' Vektoren fuer ' + count + ' Texte'];
  return [php.jsonEncode({ vektoren: vectors, dims, modell: php.toStr(embedModel) }, { unescapedSlashes: true }), ''];
}

module.exports = {
  RETRY_SUFFIX, stringToSign, sign, nonce, checkNumbers, clean, isNoAnswer, streamCut,
  StreamState, imagesFromJob, modelBody, readModel, embedBody, readEmbedding,
};
