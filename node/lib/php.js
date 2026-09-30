'use strict';
/**
 * Small helpers that reproduce the PHP semantics the reference node relies on
 * (trim, empty, casts, json_encode/json_decode, rawurlencode, mb_substr).
 * The wire has to stay byte-compatible with the PHP reference, so these are
 * deliberately literal rather than "the JavaScript way".
 */

const PHP_TRIM_CHARS = ' \t\n\r\0\x0B';

/** PHP trim(): strips only " \t\n\r\0\x0B" (JavaScript's trim strips far more). */
function trim(s, chars = PHP_TRIM_CHARS) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

function rtrim(s, chars = PHP_TRIM_CHARS) {
  let b = s.length;
  while (b > 0 && chars.includes(s[b - 1])) b--;
  return s.slice(0, b);
}

/** is_array() for decoded JSON: lists and objects are both PHP arrays. */
function isArr(v) {
  return v !== null && typeof v === 'object';
}

/** $a[$k] without touching inherited properties. */
function get(o, k) {
  if (!isArr(o) || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
  return o[k];
}

/** isset($a[$k]). */
function isset(o, k) {
  const v = get(o, k);
  return v !== undefined && v !== null;
}

/** $a[$k] ?? $default. */
function pick(o, k, dflt) {
  const v = get(o, k);
  return v === undefined || v === null ? dflt : v;
}

/** PHP empty(). */
function empty(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isArr(v)) return Object.keys(v).length === 0;
  return false;
}

/** (array) cast, values only (array_values). */
function toList(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.slice();
  if (isArr(v)) return Object.values(v);
  return [v];
}

const NUMERIC_PREFIX = /^[ \t\n\r\v\f]*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/;

/** (float) cast. */
function toFloat(v) {
  if (v === undefined || v === null || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = NUMERIC_PREFIX.exec(v);
    return m ? Number(m[1]) : 0;
  }
  if (isArr(v)) return empty(v) ? 0 : 1;
  return 0;
}

/** (int) cast. */
function toInt(v) {
  if (typeof v === 'string') {
    const m = NUMERIC_PREFIX.exec(v);
    if (!m) return 0;
    if (/^[+-]?[0-9]+$/.test(m[1])) {
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) ? n : 0;
    }
    v = Number(m[1]);
  }
  const f = toFloat(v);
  if (!Number.isFinite(f) || Math.abs(f) >= 9.2233720368547758e18) return 0;
  return Math.trunc(f) || 0;
}

/** (string) of a float with PHP's precision=14 (%.14G). */
function floatToString(x) {
  if (Number.isNaN(x)) return 'NAN';
  if (!Number.isFinite(x)) return x > 0 ? 'INF' : '-INF';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const e = x.toExponential(13);
  const [mant, expS] = e.split('e');
  const exp = parseInt(expS, 10);
  if (exp < -4 || exp >= 14) {
    let m = mant.replace(/0+$/, '');
    if (m.endsWith('.')) m += '0';
    if (!m.includes('.')) m += '.0';
    return m + 'E' + (exp < 0 ? '-' : '+') + Math.abs(exp);
  }
  let s = x.toFixed(Math.max(0, 13 - exp));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** (string) cast / strval(). Integral JSON numbers count as PHP ints. */
function toStr(v) {
  if (v === undefined || v === null || v === false) return '';
  if (v === true) return '1';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return String(v);
    return floatToString(v);
  }
  if (isArr(v)) return 'Array';
  return String(v);
}

/** mb_substr($s, 0, $n) - counts code points, not UTF-16 units. */
function mbSubstr(s, n) {
  let out = '';
  let i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

/** strlen(): UTF-8 byte length. */
function strlen(s) {
  return Buffer.byteLength(s, 'utf8');
}

/** rawurlencode() (RFC 3986: everything but A-Z a-z 0-9 - _ . ~). */
function rawurlencode(s) {
  let enc;
  try {
    enc = encodeURIComponent(s);
  } catch (e) {
    enc = encodeURIComponent(s.toWellFormed ? s.toWellFormed() : s.replace(/[\uD800-\uDFFF]/g, '\uFFFD'));
  }
  return enc.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Decode bytes as UTF-8; null when invalid (PHP's json_decode refuses invalid UTF-8). */
function utf8OrNull(buf) {
  try {
    return FATAL_UTF8.decode(buf);
  } catch (e) {
    return null;
  }
}

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** Walks a decoded value: PHP rejects lone surrogates and nesting deeper than 512. */
function phpAcceptable(v, depth) {
  if (typeof v === 'string') return !hasLoneSurrogate(v);
  if (!isArr(v)) return true;
  if (depth + 1 > 512) return false;
  if (Array.isArray(v)) {
    for (const x of v) if (!phpAcceptable(x, depth + 1)) return false;
    return true;
  }
  for (const k of Object.keys(v)) {
    if (hasLoneSurrogate(k) || !phpAcceptable(v[k], depth + 1)) return false;
  }
  return true;
}

/** json_decode($s, true): null for anything PHP would not decode. */
function jsonDecode(input) {
  let s = input;
  if (Buffer.isBuffer(s)) {
    s = utf8OrNull(s);
    if (s === null) return null;
  } else if (typeof s !== 'string') {
    s = toStr(s);
  }
  if (s === '') return null;
  let v;
  try {
    v = JSON.parse(s);
  } catch (e) {
    return null;
  }
  return phpAcceptable(v, 0) ? v : null;
}

/** Marks a number that PHP holds as float (json_encode writes 1.0, not 1). */
class PhpFloat {
  constructor(v) { this.v = v; }
}

/** A float as json_encode writes it (serialize_precision=-1: shortest digits, php_gcvt layout). */
function encodeFloat(x) {
  if (!Number.isFinite(x)) return '0';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const sign = x < 0 ? '-' : '';
  const [mant, expS] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = parseInt(expS, 10);
  const decpt = exp + 1;
  if (decpt < 0 ? decpt < -3 : decpt > 17) {
    return sign + digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0')
      + 'e' + (exp < 0 ? '-' : '+') + Math.abs(exp);
  }
  if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
  if (decpt >= digits.length) return sign + digits + '0'.repeat(decpt - digits.length);
  return sign + digits.slice(0, decpt) + '.' + digits.slice(decpt);
}

function encodeString(s, o) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '/') out += o.unescapedSlashes ? '/' : '\\/';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else if (c < 0x80) out += ch;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const d = s.charCodeAt(i + 1);
      const pair = c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff;
      if (!pair) {
        // Invalid UTF-8 on the PHP side; JSON_INVALID_UTF8_SUBSTITUTE semantics.
        out += o.unescapedUnicode ? '\uFFFD' : '\\ufffd';
        continue;
      }
      out += o.unescapedUnicode ? s[i] + s[i + 1]
        : '\\u' + c.toString(16).padStart(4, '0') + '\\u' + d.toString(16).padStart(4, '0');
      i++;
    } else if (c === 0x2028 || c === 0x2029) out += '\\u' + c.toString(16);
    else out += o.unescapedUnicode ? ch : '\\u' + c.toString(16).padStart(4, '0');
  }
  return out + '"';
}

/**
 * json_encode() with the flags the reference uses:
 *   { unescapedUnicode: JSON_UNESCAPED_UNICODE, unescapedSlashes: JSON_UNESCAPED_SLASHES }
 * Without JSON_UNESCAPED_SLASHES PHP writes "/" as "\/".
 */
function jsonEncode(v, o = {}) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v instanceof PhpFloat) return encodeFloat(v.v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : encodeFloat(v);
  if (typeof v === 'string') return encodeString(v, o);
  if (Array.isArray(v)) return '[' + v.map((x) => jsonEncode(x, o)).join(',') + ']';
  const keys = Object.keys(v);
  return '{' + keys.map((k) => encodeString(k, o) + ':' + jsonEncode(v[k], o)).join(',') + '}';
}

module.exports = {
  trim, rtrim, isArr, get, isset, pick, empty, toList, toFloat, toInt, toStr, floatToString,
  mbSubstr, strlen, rawurlencode, utf8OrNull, jsonDecode, jsonEncode, PhpFloat,
};
