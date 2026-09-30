# rc-node — PHP edition

The reactive.chat AI node ("bring your own model") as **one PHP file**:
[`rc-node.php`](rc-node.php). It fetches the AI jobs of your workspace from
reactive.chat, lets your own OpenAI-compatible model (vLLM, Ollama, LM Studio,
llama.cpp, Azure OpenAI) answer them and delivers the answers back.

Version 2.0.0 — the English rewrite of `rc-knoten.php` 1.3. Same wire
protocol, same behaviour; existing 1.x installations keep their config
(see [Upgrading from rc-knoten.php 1.x](#upgrading-from-rc-knotenphp-1x)).

## Requirements

- PHP **8.1 or newer** on the command line with the **curl** and **json**
  extensions. Debian/Ubuntu: `apt install php-cli php-curl`
  (json is built in since PHP 8.0).
- Optional: `pcntl` (part of `php-cli` on Debian/Ubuntu) for a graceful stop
  on SIGTERM/SIGINT in `--daemon` mode. `mbstring` is not needed.
- A language model behind an OpenAI-compatible `/v1/chat/completions`.
- Node ID and secret from the reactive.chat customer area (`/app/ai-node`).
  The secret is shown exactly once.

No Composer packages, no other dependencies.

## Install

```sh
sudo useradd --system --home /opt/rc-node --shell /usr/sbin/nologin rcnode
sudo mkdir -p /opt/rc-node
# put php/rc-node.php and rc-node.example.json from this repository into /opt/rc-node
cd /opt/rc-node && sudo cp rc-node.example.json rc-node.json
sudo chown rcnode: rc-node.json && sudo chmod 600 rc-node.json
```

With Composer (`composer create-project`), the entry point is `bin/rc-node`;
it simply runs `rc-node.php`.

## Configure

Edit `rc-node.json` — a flat JSON object, all keys and defaults are listed in
[`../rc-node.example.json`](../rc-node.example.json) and explained in
[`../CONTRACT.md`](../CONTRACT.md). The minimum:

```json
{
  "base_url": "https://reactive.chat",
  "node_id": "kn-...",
  "secret": "rcn_...",
  "model_endpoint": "http://127.0.0.1:8000/v1",
  "model": "mistral-small-24b"
}
```

Where the config is looked up: `--config=PATH`, else `$RC_NODE_CONFIG`, else
`rc-node.json` in the current directory, else (1.x drop-in) a legacy
`rc-knoten.conf.php` next to the script. `RC_NODE_SECRET` and
`RC_NODE_MODEL_API_KEY` in the environment override the file, so the secret
does not have to be on disk at all. A config error exits with code 2 and a
one-line message.

## Run

```sh
php rc-node.php --probe     # check both sides, take no job (exit 0 = all good)
php rc-node.php             # one fetch cycle, then exit (= --once)
php rc-node.php --one       # one slot, prints SYSTEM/PROMPT of each job
php rc-node.php --daemon    # run until SIGTERM/SIGINT
php rc-node.php --config=/etc/rc-node/rc-node.json --daemon
```

`--probe` prints what it checked and why something failed, e.g.:

```
2026-09-30 19:22:31  Probe, rc-node-php 2.0.0 (config: rc-node.json).
2026-09-30 19:22:31    reactive.chat: https://reactive.chat
2026-09-30 19:22:31      OK: HTTP 200 - signed in, 0 job(s) waiting.
2026-09-30 19:22:31    Model: http://127.0.0.1:8000/v1/chat/completions (mistral-small-24b)
2026-09-30 19:22:31      OK: answer in 412 ms: Bereit
2026-09-30 19:22:31    Node: kn-..., takes: chat, can: chat, images: no, streaming: yes.
2026-09-30 19:22:31  Probe passed: reactive.chat and the model both answered.
```

A `401` means wrong node ID/secret, a wrong clock (signatures are valid for
five minutes — use NTP) or a revoked node.

## Run as a service (systemd)

`/etc/systemd/system/rc-node.service`:

```ini
[Unit]
Description=reactive.chat AI node (PHP)
After=network-online.target
Wants=network-online.target

[Service]
User=rcnode
WorkingDirectory=/opt/rc-node
ExecStart=/usr/bin/php /opt/rc-node/rc-node.php --config=/opt/rc-node/rc-node.json --daemon
Restart=always
RestartSec=15
# finish running jobs on stop (the node stops fetching, then delivers)
TimeoutStopSec=180
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/rc-node

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now rc-node
journalctl -u rc-node -f
```

Several processes are fine — e.g. a second one with `"kinds": ["embedding"]`
and its own config, so chat questions never wait behind a batch of
embeddings. Give both `"capabilities": ["chat", "embedding"]`.

## Upgrading from rc-knoten.php 1.x

`rc-node.php` is a drop-in replacement:

- `--konf=/path/rc-knoten.conf.php` still loads the German 1.x config, and
  without any config option a `rc-knoten.conf.php` next to the script is
  used when there is no `rc-node.json` in the working directory.
- `--dauer` and `--einer` still work (aliases of `--daemon` and `--one`).
- With a 1.x config the log still goes to `rc-knoten.log` next to the script
  unless `protokoll` says otherwise.
- Changes you may notice: log lines are English, the User-Agent is
  `rc-node-php/2.0.0`. What goes over the wire is unchanged.

To move to the new format, copy the values into `rc-node.json`
(`basis` → `base_url`, `knoten` → `node_id`, `geheim` → `secret`,
`endpunkt` → `model_endpoint`, `modell` → `model`, `arten` → `kinds`, … — the
full mapping is the "reference key" column in [`../CONTRACT.md`](../CONTRACT.md)).

## Security notes

- The config holds your node secret: `chmod 600`, owned by the service user.
  The node warns on stderr when the file is readable by others. Or keep the
  secret out of the file with `RC_NODE_SECRET`.
- The node only makes **outbound** HTTPS requests to reactive.chat and
  requests to your model server. It opens **no port** and needs no inbound
  firewall rule.
- Every request is signed (HMAC-SHA256 with a nonce, valid once, five
  minutes). The secret and the model API key are never logged.
- Keep `tls_verify` at `true`. `resolve` and `basic_auth` are for staging
  setups only.
- Answers are proposals: reactive.chat checks every answer (e.g. every number
  must appear in the sources) before a visitor sees it.

## Tests

```sh
php tests/unit.php          # signature, clean-up, number check, stream cut, SSE, embeddings, images
node ../conformance/run.js --impl=php -- php rc-node.php   # end-to-end against mock servers
```

The unit tests read the known vectors from `../conformance/vectors.json`.

## Licence

MIT — see [`../LICENSE`](../LICENSE).
