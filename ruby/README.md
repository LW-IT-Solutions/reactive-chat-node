# rc-node for Ruby

The reactive.chat AI node ("bring your own model") in Ruby. It runs on
**your** machine, fetches the AI jobs of your reactive.chat workspace, lets
**your** OpenAI-compatible model server answer them and delivers the
results. The node always calls out; reactive.chat never connects to your
machine, so it needs no public address, no open port and no fixed IP.

Behaviour, wire format and configuration are identical to the other
implementations in this repository (PHP, Node.js, Python, Go, .NET); the
binding description is [`../CONTRACT.md`](../CONTRACT.md).

## Requirements

- Ruby **3.0 or newer** with the standard `openssl` extension (Debian/Ubuntu:
  `sudo apt install ruby`). No gems are needed - standard library only.
- A model server with an OpenAI-compatible API (`/v1/chat/completions`):
  vLLM, Ollama (`/v1`), LM Studio, llama.cpp (`llama-server`) or Azure OpenAI.
  Optional: an embeddings server (`/v1/embeddings`).
- Node id (`kn-...`) and secret (`rcn_...`) from the customer area
  (`/app/ai-node`). The secret is shown exactly once.
- A correct clock (NTP): every request is signed and valid for five minutes.

## Install

From the repository (GitHub or the download on reactive.chat):

```sh
git clone <repository URL> /opt/rc-node
/opt/rc-node/ruby/bin/rc-node --version
```

Or as a gem built from this directory:

```sh
cd ruby && gem build rc-node.gemspec && gem install ./rc-node-2.0.0.gem
rc-node --version
```

## Configure

Copy [`../rc-node.example.json`](../rc-node.example.json) to `rc-node.json`,
fill in `node_id`, `secret`, `model_endpoint` (base URL **with** `/v1`) and
`model`, and protect it - it contains your secret:

```sh
cp rc-node.example.json /etc/rc-node/rc-node.json
chmod 600 /etc/rc-node/rc-node.json
```

All keys, defaults and the English aliases for job kinds are listed in
[`../CONTRACT.md`](../CONTRACT.md). The config file is found via
`--config=PATH`, else the environment variable `RC_NODE_CONFIG`, else
`rc-node.json` in the current directory. `RC_NODE_SECRET` and
`RC_NODE_MODEL_API_KEY` override the file, so the secrets can also come from
the service manager instead of the file.

## Run

```
rc-node [--config=PATH] [--probe | --once | --one | --daemon]
```

| flag | what it does |
|---|---|
| `--probe` | checks both sides and takes nothing: signs in at reactive.chat, asks the model one test question, embeds one test text if `embed_url` is set. Exit 0 when reactive.chat answered 200 and the model answered. |
| `--once` (default) | one fetch cycle: fetch, answer, deliver, exit. |
| `--one` | like `--once` with one slot, and prints SYSTEM/PROMPT of each job. |
| `--daemon` | runs until SIGTERM/SIGINT, then stops fetching, finishes the running jobs, delivers and exits 0. |

Always start with `--probe`:

```
$ rc-node --config=/etc/rc-node/rc-node.json --probe
2026-09-30 19:35:51  Probe, rc-node-ruby/2.0.0.
2026-09-30 19:35:51    reactive.chat: https://reactive.chat
2026-09-30 19:35:51      HTTP 200 - signed in, 0 job(s) waiting.
2026-09-30 19:35:51    Model: http://127.0.0.1:8000/v1/chat/completions (mistral-small-24b)
2026-09-30 19:35:51      Answer in 412 ms: Bereit
2026-09-30 19:35:51    Node: kn-0123456789abcdef, takes: chat, can: chat, images: no
```

Exit codes: 0 ok, 1 connection problem and nothing done (or probe failed),
2 configuration error (one line on stderr).

## Run as a service (systemd)

`/etc/systemd/system/rc-node.service`:

```ini
[Unit]
Description=reactive.chat AI node (Ruby)
After=network-online.target
Wants=network-online.target

[Service]
User=rcnode
ExecStart=/usr/bin/ruby /opt/rc-node/ruby/bin/rc-node --config=/etc/rc-node/rc-node.json --daemon
Restart=always
RestartSec=15
# Optional: keep the secret out of the file
# Environment=RC_NODE_SECRET=rcn_...
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --no-create-home rcnode
sudo chown rcnode: /etc/rc-node/rc-node.json && sudo chmod 600 /etc/rc-node/rc-node.json
sudo systemctl daemon-reload && sudo systemctl enable --now rc-node
journalctl -u rc-node -f
```

If you set `log_file`, the directory must be writable for the service user
(add it to `ReadWritePaths=` when using `ProtectSystem=strict`).

Embeddings in a second process: a copy of the config with
`"kinds": ["embedding"]`, `embed_url` and `embed_model`, a second unit; both
configs with `"capabilities": ["chat", "embedding"]`.

## Upgrade

Replace the files (`git pull` or install the new gem) and restart the
service: `sudo systemctl restart rc-node`. On SIGTERM the node finishes the
jobs it is running and delivers them, so a restart loses nothing. The config
format stays compatible within 2.x; unknown keys are ignored.

Coming from the PHP node 1.x (`rc-knoten.php`, `rc-knoten.conf.php`): the
Ruby node reads only `rc-node.json` with English keys - see the mapping table
in [`../CONTRACT.md`](../CONTRACT.md). `--dauer` and `--einer` are accepted as
aliases of `--daemon` and `--one`.

## Security notes

- The config file contains your node secret: `chmod 600`, owned by the
  service user. Or pass the secret via `RC_NODE_SECRET`.
- The node never logs the secret or the model API key.
- Outbound HTTPS to reactive.chat only; no inbound port, nothing listens.
- Every request is HMAC-SHA256 signed with a nonce; a signature is valid for
  five minutes and exactly once.
- Leave `tls_verify` on. `resolve` and `basic_auth` exist for staging setups.
- The node only proposes answers: reactive.chat checks every result (every
  number must occur in the sources) before a visitor sees it.
- Images reach your model only with `"images": true` (and then only as
  re-encoded JPEG data URLs); use it only with a vision model.

## Development

```sh
ruby test/run.rb      # unit tests against ../conformance/vectors.json
node ../conformance/run.js --impl=ruby -- ruby bin/rc-node   # conformance suite
```

Layout: `lib/rc_node/wire.rb` (signing, calls to reactive.chat),
`node.rb` (the loop: one long-poll, one delivery, one part call in flight,
model calls in threads), `text.rb` (clean-up, number check, stream cut, image
filter), `stream.rb` (SSE), `model.rb` (model and embedding answers),
`php.rb` (the PHP semantics the wire format depends on, e.g. `json_encode`).

Licence: MIT.
