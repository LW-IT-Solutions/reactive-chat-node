#!/usr/bin/env node
'use strict';
/**
 * reactive.chat - own AI node ("bring your own model"), Node.js edition.
 *
 * Runs on YOUR machine: fetches the AI jobs of your workspace from
 * reactive.chat, lets YOUR language model answer them and delivers the
 * sentences back. reactive.chat never connects to your machine - the node
 * calls out, not the other way round. No public address, no open port.
 *
 *   rc-node [--config=PATH] [--probe | --once | --one | --daemon]
 *
 * See README.md, ../CONTRACT.md and ../PROTOCOL.md. MIT licence.
 */
const { ConfigError, load, resolveConfigPath } = require('./lib/config');
const { Logger } = require('./lib/log');
const { Node, VERSION } = require('./lib/worker');
const transport = require('./lib/transport');

const USAGE = 'usage: rc-node [--config=PATH] [--probe | --once | --one | --daemon]';

function parseArgs(argv) {
  const a = { config: '', mode: 'once' };
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--config=')) a.config = x.slice(9);
    else if (x === '--config' && i + 1 < argv.length) a.config = argv[++i];
    else if (x === '--probe' || x === '--once' || x === '--one' || x === '--daemon') modes.push(x.slice(2));
    else if (x === '--version' || x === '-V') a.mode = 'version';
    else if (x === '--help' || x === '-h') a.mode = 'help';
    else throw new ConfigError('unknown argument ' + x + ' - ' + USAGE);
  }
  if (a.mode === 'version' || a.mode === 'help') return a;
  if (new Set(modes).size > 1) throw new ConfigError('only one of --probe, --once, --one, --daemon - ' + USAGE);
  if (modes.length) a.mode = modes[0];
  return a;
}

function finish(code) {
  transport.destroyAgents();
  process.exitCode = code;
  // Whatever still holds the event loop must not keep a finished node alive.
  setTimeout(() => process.exit(code), 2000).unref();
}

async function main() {
  let args;
  let cfg;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.mode === 'version') { process.stdout.write('rc-node-node ' + VERSION + '\n'); return finish(0); }
    if (args.mode === 'help') { process.stdout.write(USAGE + '\n'); return finish(0); }
    cfg = load(resolveConfigPath(args.config));
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write('rc-node: ' + e.message.replace(/\s*\n\s*/g, ' ') + '\n');
      return finish(2);
    }
    throw e;
  }

  const logger = new Logger(cfg);
  const node = new Node(cfg, logger, { one: args.mode === 'one' });

  if (args.mode === 'probe') return finish(await node.probe());
  if (args.mode === 'once' || args.mode === 'one') {
    const n = await node.loop(true);
    return finish(n < 0 ? 1 : 0);
  }
  // --daemon: SIGTERM / SIGINT (Windows: Ctrl+C, service stop) end fetching,
  // running jobs are finished and delivered.
  const onSignal = (name) => () => node.stop(name);
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
  if (process.platform === 'win32') process.on('SIGBREAK', onSignal('SIGBREAK'));
  const code = await node.daemon();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  return finish(code);
}

main().catch((e) => {
  process.stderr.write('rc-node: unexpected error: ' + (e && e.stack ? e.stack : e) + '\n');
  finish(1);
});
