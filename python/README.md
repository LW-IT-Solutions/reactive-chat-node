# rc-node for Python

The reactive.chat AI node ("bring your own model") as a single Python file.
It fetches the AI jobs of your workspace from reactive.chat, lets **your**
OpenAI-compatible model answer them and delivers the answers back.

The node only makes outgoing HTTPS calls. reactive.chat never connects to
your machine: no public address, no open port, no fixed IP needed.

Licence: MIT. Version 2.0.0, User-Agent `rc-node-python/2.0.0`.

## Requirements

- Python 3.9 or newer. Standard library only: there are **no dependencies**,
  so you do not need a virtualenv.
- A language model behind an OpenAI-compatible API (`/v1/chat/completions`):
  vLLM, Ollama (`/v1`), LM Studio, llama.cpp (`llama-server`) or Azure OpenAI.
- Optional: an embedding server (`/v1/embeddings`) if your workspace is set
  to "own node only" for embeddings.
- Node ID (`kn-...`) and secret (`rcn_...`) from the customer area
  (`/app/ai-node`). The secret is shown there exactly once.
- A correct clock (NTP). Every request is signed and a signature is valid for
  five minutes.

## Install

Either use the single file:

```sh
sudo mkdir -p /opt/rc-node
sudo cp rc_node.py /opt/rc-node/
python3 /opt/rc-node/rc_node.py --help
```

or install it as a package, which gives you an `rc-node` command:

```sh
pip install .            # from this directory
rc-node --help
```

## Configuration

Copy [`../rc-node.example.json`](../rc-node.example.json) to `rc-node.json`,
fill it in and protect it:

```sh
cp rc-node.example.json /opt/rc-node/rc-node.json
chmod 600 /opt/rc-node/rc-node.json
```

The keys (`base_url`, `node_id`, `secret`, `model`, `model_endpoint` or
`chat_url`, `kinds`, `concurrency`, `stream`, ...) are the same for every
implementation and described in [`../CONTRACT.md`](../CONTRACT.md).
Two environment variables override the file: `RC_NODE_SECRET` and
`RC_NODE_MODEL_API_KEY`.

The config file is found in this order: `--config=PATH`, the environment
variable `RC_NODE_CONFIG`, `rc-node.json` in the current directory.
A configuration error exits with code 2 and a one-line message.

## Command line

```
rc-node [--config=PATH] [--probe | --once | --one | --daemon]
```

| flag | what it does |
|---|---|
| `--probe` | checks reactive.chat and your model, takes no job. Exit 0 when both answer. |
| `--once` (default) | one fetch cycle: fetch, process, deliver, exit. |
| `--one` | like `--once` with one slot; prints SYSTEM and PROMPT of each job. |
| `--daemon` | runs until SIGTERM/SIGINT, then finishes running jobs, delivers and exits 0. |

### First check: `--probe`

```sh
python3 rc_node.py --config=/opt/rc-node/rc-node.json --probe
```

prints for example

```
2026-09-30 19:40:00  Probe, rc-node-python 2.0.0.
2026-09-30 19:40:00    reactive.chat: https://reactive.chat
2026-09-30 19:40:00      HTTP 200 - signed in, 0 job(s) waiting.
2026-09-30 19:40:00    Model: http://127.0.0.1:8000/v1/chat/completions (mistral-small-24b)
2026-09-30 19:40:01      Answer in 412 ms: Bereit
2026-09-30 19:40:01    Node: kn-..., takes: chat, can: chat, images: no
2026-09-30 19:40:01    Result: OK - the node can run.
```

HTTP 401 means: wrong node ID or secret, a wrong clock, or the node was
revoked in the customer area.

## Run as a service (systemd)

```ini
# /etc/systemd/system/rc-node.service
[Unit]
Description=reactive.chat AI node
After=network-online.target
Wants=network-online.target

[Service]
User=rcnode
WorkingDirectory=/opt/rc-node
ExecStart=/usr/bin/python3 /opt/rc-node/rc_node.py --config=/opt/rc-node/rc-node.json --daemon
Restart=always
RestartSec=15
# SIGTERM lets running jobs finish; give them the model timeout.
TimeoutStopSec=150
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --home /opt/rc-node rcnode
sudo chown rcnode: /opt/rc-node/rc-node.json && sudo chmod 600 /opt/rc-node/rc-node.json
sudo systemctl daemon-reload && sudo systemctl enable --now rc-node
journalctl -u rc-node -f
```

If you set `log_file`, add it to `ReadWritePaths=` (because of
`ProtectSystem=strict`). Without `log_file` the log goes to stdout, i.e. the
journal.

Embeddings are best fetched by a second process with its own config file
(`"kinds": ["embedding"]`) so that no chat question waits behind a batch of
embeddings; both files then say `"capabilities": ["chat", "embedding"]`.

## Upgrade notes

- **From the PHP node `rc-knoten.php` 1.x:** the configuration is now JSON
  with English keys; see the mapping table in `../CONTRACT.md`
  (`basis` -> `base_url`, `knoten` -> `node_id`, `geheim` -> `secret`, ...).
  `--dauer` is now `--daemon`, `--einer` is `--one`, `--konf=` is `--config=`.
  Node ID and secret stay the same. The default log file is gone: without
  `log_file` the node logs to stdout only.
- **Newer rc-node versions:** replace `rc_node.py` (or `pip install -U .`) and
  restart the service. Unknown config keys are ignored, so an older config
  keeps working.

## Security notes

- The config file contains your node secret: `chmod 600`, owned by the
  service user. Better still, pass the secret via `RC_NODE_SECRET` from a
  systemd credential or environment file that is also mode 600.
- The node makes outgoing HTTPS calls to reactive.chat and outgoing calls to
  your model server only. It opens **no inbound port**.
- The secret and the model API key are never written to the log.
- Keep `tls_verify` at `true`. `false` exists only for staging setups.
- What the node delivers is a suggestion: reactive.chat checks it (every
  number of the answer must be in the sources) and otherwise falls back to a
  quote or a hand-over to a human.

## Tests

```sh
python3 -m unittest -v test_rc_node          # unit tests against ../conformance/vectors.json
node ../conformance/run.js --impl=python -- python3 rc_node.py   # conformance suite (mocks on 127.0.0.1)
```
