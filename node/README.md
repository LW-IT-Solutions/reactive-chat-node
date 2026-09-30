# rc-node for Node.js

The reactive.chat AI node ("bring your own model") as a single Node.js
program. It fetches the AI jobs of your workspace from reactive.chat, lets
**your** OpenAI-compatible model answer them (vLLM, Ollama, LM Studio,
llama.cpp, Azure OpenAI) and delivers the results. It only makes outbound
requests; reactive.chat never connects to your machine.

Same configuration file, command line and wire behaviour as every other
implementation in this repository - see [../CONTRACT.md](../CONTRACT.md) and
[../PROTOCOL.md](../PROTOCOL.md).

## Requirements

- Node.js 18 or newer (tested with Node 20).
- No npm packages: standard library only (`node:http`, `node:https`,
  `node:crypto`, ...). `package.json` lists zero dependencies.
- A model server with an OpenAI-compatible `/v1/chat/completions`.
- Node ID and secret from reactive.chat (**Settings -> Own AI node**,
  `/app/ai-node`). The secret is shown once.

## Install

Copy this directory (`rc-node.js`, `lib/`, `package.json`) anywhere, e.g.
`/opt/rc-node`, or install it as a command:

```sh
cd node && npm install -g .       # provides the command "rc-node"
# or simply run it in place:
node /opt/rc-node/rc-node.js --probe
```

## Configure

Copy [../rc-node.example.json](../rc-node.example.json) to `rc-node.json`,
fill in at least `base_url`, `node_id`, `secret`, `model` and
`model_endpoint` (or `chat_url` for Azure), then protect it:

```sh
chmod 600 rc-node.json
```

The config file is looked up in this order: `--config=PATH`, the environment
variable `RC_NODE_CONFIG`, `rc-node.json` in the current directory.
`RC_NODE_SECRET` and `RC_NODE_MODEL_API_KEY` override the values in the
file, so the secret does not have to be stored on disk at all.
All keys, defaults and the kind names (`chat`, `translation`, `summary`,
`embedding` or the wire names) are documented in
[../CONTRACT.md](../CONTRACT.md). A configuration error exits with code 2 and
a one-line message on stderr.

## Run

```
rc-node [--config=PATH] [--probe | --once | --one | --daemon]
```

| flag | what it does |
|---|---|
| `--probe` | Checks both sides and takes nothing: one signed `hol` with `n=0`, one test completion, one test embedding if `embed_url` is set. Exit 0 when reactive.chat answered 200 and the model answered. |
| `--once` (default) | One fetch cycle: fetch, answer, deliver, exit. |
| `--one` | Like `--once` with exactly one slot; prints SYSTEM and PROMPT of each job - for checking what your model gets. |
| `--daemon` | Runs until SIGTERM/SIGINT (Ctrl+C); then it stops fetching, finishes and delivers the running jobs and exits 0. |

Start with the probe:

```
$ node rc-node.js --probe
2026-09-30 19:27:12  Probe, rc-node-node 2.0.0.
2026-09-30 19:27:12    reactive.chat: https://reactive.chat
2026-09-30 19:27:12      HTTP 200 - signed in, 0 job(s) waiting.
2026-09-30 19:27:12    Model: http://127.0.0.1:8000/v1/chat/completions (mistral-small-24b)
2026-09-30 19:27:13      Answer in 305 ms: Bereit.
2026-09-30 19:27:13    Node: kn-..., fetches: chat, can: chat, images: no
2026-09-30 19:27:13  Probe OK.
```

`HTTP 401` means the ID or secret is wrong, the node was revoked, or the
clock of this machine is off (signatures are valid for five minutes - use
NTP).

Log lines go to stdout (`YYYY-MM-DD HH:MM:SS  text`) and, with `log_file`,
are appended to that file too. `timezone` (an IANA name such as
`Europe/Berlin`) sets the zone of the timestamps.

## Run as a service (systemd)

```ini
# /etc/systemd/system/rc-node.service
[Unit]
Description=reactive.chat AI node (Node.js)
After=network-online.target
Wants=network-online.target

[Service]
User=rcnode
WorkingDirectory=/opt/rc-node
ExecStart=/usr/bin/node /opt/rc-node/rc-node.js --config=/etc/rc-node/rc-node.json --daemon
Restart=always
RestartSec=15
# Running jobs are finished and delivered on stop; give them time.
TimeoutStopSec=180
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --no-create-home rcnode
sudo install -d -o root -g rcnode -m 750 /etc/rc-node
sudo install -o root -g rcnode -m 640 rc-node.json /etc/rc-node/rc-node.json
sudo systemctl daemon-reload && sudo systemctl enable --now rc-node
journalctl -u rc-node -f
```

If you set `log_file`, allow writing it (`ReadWritePaths=/var/log/rc-node`).

**Windows:** run it in a console with `node rc-node.js --daemon` (Ctrl+C
stops it gracefully), or register it with a service wrapper of your choice
(for example NSSM or WinSW) using the same command line. Service wrappers
are not part of this package.

Several processes may run side by side, e.g. one for `chat` and one for
`embedding` with its own config file - both with
`"capabilities": ["chat", "einbettung"]`.

## Upgrade

- From the PHP node 1.x (`rc-knoten.php`): translate the German keys of
  `rc-knoten.conf.php` into `rc-node.json` (table in
  [../CONTRACT.md](../CONTRACT.md), e.g. `basis` -> `base_url`, `knoten` ->
  `node_id`, `geheim` -> `secret`, `endpunkt` -> `model_endpoint`,
  `arten` -> `kinds`, `gleichzeitig` -> `concurrency`). `--dauer` is now
  `--daemon`, `--einer` is `--one`, `--konf=` is `--config=`. The node ID and
  secret stay the same; stop the old process before starting the new one.
- Note one changed default: `log_file` is empty (stdout only); the PHP node
  wrote `rc-knoten.log` next to itself.
- Between 2.x releases: replace `rc-node.js` and `lib/` and restart the
  service. Your `rc-node.json` stays; unknown keys are ignored, so an older
  node accepts a newer config file.

## Security notes

- The config holds your node secret: `chmod 600` (or 640 with a dedicated
  group), readable only by the service user. Prefer `RC_NODE_SECRET` from a
  root-owned environment file (`EnvironmentFile=` in systemd). A lost or
  leaked secret: revoke the node in reactive.chat and create a new one.
- The secret and the model API key are never logged and never sent anywhere:
  requests carry an HMAC signature (`X-RC-KI-SIG`), not the secret.
- Outbound only: HTTPS to reactive.chat and HTTP(S) to your model server. The
  node opens **no inbound port** and needs no public address.
- Keep `tls_verify` on. `tls_verify: false` and `resolve` exist for staging
  setups; they apply to the connection to reactive.chat only (as in the PHP
  reference), never to your model server.
- Jobs contain visitor questions and excerpts of your knowledge base. The
  node keeps nothing on disk except the log lines you configure (they
  contain the first 100 characters of each answer).

## Tests

```sh
cd node
npm test            # = node --test test/vectors.test.js test/unit.test.js
```

`test/vectors.test.js` checks signature, clean-up, number check, stream cut,
SSE parsing, embedding result and image filter against
`../conformance/vectors.json` (produced by the PHP reference). The full
behaviour against mock servers:

```sh
node ../conformance/run.js --impl=node -- node rc-node.js
```

## Files

| file | purpose |
|---|---|
| `rc-node.js` | command line entry point |
| `lib/worker.js` | fetch/answer/deliver loop, heartbeat, backoff, streaming parts, `--probe` |
| `lib/logic.js` | signature, clean-up, number check, stream cut, SSE parser, image filter, embeddings |
| `lib/transport.js` | HTTP(S) with connect/total timeouts, `resolve`, `tls_verify` |
| `lib/php.js` | the PHP semantics the wire depends on (`json_encode`, `trim`, casts, ...) |
| `lib/config.js` | `rc-node.json`, environment overrides, validation |
| `lib/log.js` | log lines, `log_file`, `timezone` |

Licence: MIT (see [../LICENSE](../LICENSE)).
