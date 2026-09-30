'use strict';
/**
 * rc-node.json: flat JSON object with English keys (see ../../CONTRACT.md).
 * Unknown keys are ignored. RC_NODE_SECRET and RC_NODE_MODEL_API_KEY override
 * the file. Any problem throws a ConfigError (exit code 2).
 */
const fs = require('node:fs');
const path = require('node:path');
const php = require('./php');

class ConfigError extends Error {}

const DEFAULTS = {
  base_url: '',
  node_id: '',
  secret: '',
  model: '',
  model_endpoint: '',
  chat_url: '',
  model_api_key: '',
  model_key_header: 'Authorization',
  kinds: ['chat'],
  capabilities: [],
  embed_url: '',
  embed_model: '',
  embed_timeout: 120,
  images: false,
  images_max: 1,
  stream: true,
  stream_ms: 400,
  concurrency: 1,
  poll_wait: 20,
  timeout: 120,
  temperature: 0.2,
  max_tokens: 300,
  basic_auth: '',
  resolve: '',
  tls_verify: true,
  log_file: '',
  timezone: '',
};

/** English aliases accepted in the config, mapped to the wire names. */
const KIND_ALIASES = {
  translation: 'uebersetzung',
  summary: 'zusammenfassung',
  embedding: 'einbettung',
};

const STRING_KEYS = ['base_url', 'node_id', 'secret', 'model', 'model_endpoint', 'chat_url', 'model_api_key',
  'model_key_header', 'embed_url', 'embed_model', 'basic_auth', 'resolve', 'log_file', 'timezone'];
const INT_KEYS = ['embed_timeout', 'images_max', 'stream_ms', 'concurrency', 'poll_wait', 'timeout', 'max_tokens'];
const BOOL_KEYS = ['images', 'stream', 'tls_verify'];

function kindList(v, key) {
  let list;
  if (typeof v === 'string') list = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  else if (Array.isArray(v)) list = v;
  else throw new ConfigError("'" + key + "' must be a list of strings");
  return list.map((k) => {
    if (typeof k !== 'string') throw new ConfigError("'" + key + "' must be a list of strings");
    return Object.prototype.hasOwnProperty.call(KIND_ALIASES, k) ? KIND_ALIASES[k] : k;
  });
}

function resolveConfigPath(argPath, env = process.env, cwd = process.cwd()) {
  if (argPath) return argPath;
  if (env.RC_NODE_CONFIG) return env.RC_NODE_CONFIG;
  return path.join(cwd, 'rc-node.json');
}

/** Validates and normalises a parsed config object. */
function normalise(raw, env = process.env) {
  if (!php.isArr(raw) || Array.isArray(raw)) throw new ConfigError('the configuration must be a JSON object');
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== null) c[k] = raw[k];
  }
  if (env.RC_NODE_SECRET) c.secret = env.RC_NODE_SECRET;
  if (env.RC_NODE_MODEL_API_KEY) c.model_api_key = env.RC_NODE_MODEL_API_KEY;

  for (const k of STRING_KEYS) {
    if (typeof c[k] === 'number') c[k] = String(c[k]);
    if (typeof c[k] !== 'string') throw new ConfigError("'" + k + "' must be a string");
  }
  for (const k of INT_KEYS) {
    if (typeof c[k] !== 'number' && typeof c[k] !== 'string') throw new ConfigError("'" + k + "' must be a number");
    c[k] = php.toInt(c[k]);
  }
  for (const k of BOOL_KEYS) c[k] = !php.empty(c[k]);
  if (typeof c.temperature !== 'number' && typeof c.temperature !== 'string') {
    throw new ConfigError("'temperature' must be a number");
  }
  c.temperature = php.toFloat(c.temperature);

  for (const k of ['base_url', 'node_id', 'secret', 'model']) {
    if (php.empty(c[k])) throw new ConfigError("the configuration is missing '" + k + "'");
  }
  if (php.empty(c.model_endpoint) && php.empty(c.chat_url)) {
    throw new ConfigError("the configuration is missing 'model_endpoint' (or 'chat_url' for Azure)");
  }
  if (!c.node_id.startsWith('kn-')) {
    throw new ConfigError("'node_id' must start with kn- (exactly as the customer area shows it)");
  }
  c.kinds = kindList(c.kinds, 'kinds');
  c.capabilities = kindList(c.capabilities, 'capabilities');
  if (c.kinds.includes('einbettung') && (c.embed_url === '' || c.embed_model === '')) {
    throw new ConfigError("'kinds' contains 'einbettung' - then 'embed_url' and 'embed_model' are required");
  }
  if (c.resolve !== '' && !parseResolve(c.resolve)) {
    throw new ConfigError("'resolve' must look like host:port:ip");
  }
  if (c.timezone !== '' && !validTimezone(c.timezone)) {
    throw new ConfigError("'timezone' is not a known IANA time zone: " + c.timezone);
  }
  // What the node can overall; empty = what this process fetches.
  c.can = c.capabilities.length ? c.capabilities : c.kinds;
  return c;
}

function load(file, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError('cannot read ' + file + ' (' + (e.code || e.message) + ') - copy rc-node.example.json, fill it in and chmod 600');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(file + ' is not valid JSON: ' + e.message);
  }
  return normalise(raw, env);
}

/** "host:port:ip" (curl --resolve). IPv6 may be written with or without brackets. */
function parseResolve(s) {
  const m = /^\+?([^:]+):([0-9]{1,5}):(.+)$/.exec(s.trim());
  if (!m) return null;
  let ip = m[3].split(',')[0].trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const net = require('node:net');
  if (!net.isIP(ip)) return null;
  return { host: m[1].toLowerCase(), port: parseInt(m[2], 10), ip };
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { ConfigError, DEFAULTS, KIND_ALIASES, load, normalise, resolveConfigPath, parseResolve };
