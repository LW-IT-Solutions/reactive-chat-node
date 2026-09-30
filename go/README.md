# rc-node — Go

The reactive.chat "bring your own model" AI node as a single static binary.
It fetches the AI jobs of your workspace from reactive.chat, lets **your**
OpenAI-compatible model answer them and delivers the answers back. The node
always calls out; reactive.chat never connects to your machine.

Functionally identical to the other implementations in this repository: same
[`rc-node.json`](../rc-node.example.json), same command line, same wire
protocol ([CONTRACT.md](../CONTRACT.md), [PROTOCOL.md](../PROTOCOL.md)).

## Requirements

- To **run**: nothing. The binary is statically linked (no libc, no
  runtime); Linux, Windows and macOS are supported.
- To **build**: Go 1.21 or newer. Standard library only — no third-party
  modules, nothing is downloaded during the build.
- A language model behind an OpenAI-compatible API (`/v1/chat/completions`):
  vLLM, Ollama (`/v1`), LM Studio, llama.cpp (`llama-server`) or Azure OpenAI.
- Node ID and secret from the reactive.chat customer area (`/app/ai-node`).
  The secret is shown exactly once.
- A correct clock (NTP): every request is signed and valid for five minutes.

## Build and install

```sh
cd go
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o rc-node .
sudo install -m 755 rc-node /usr/local/bin/rc-node
```

Cross-compiling works from any machine, no C toolchain needed:

```sh
CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/rc-node-linux-amd64 .
CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o dist/rc-node-linux-arm64 .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/rc-node-windows-amd64.exe .
CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o dist/rc-node-darwin-arm64 .
```

Tests (known-answer vectors from `../conformance/vectors.json`, plus the
full black-box conformance suite):

```sh
go test ./...
node ../conformance/run.js --impl=go -- ./rc-node
```

## Configuration

Copy [`../rc-node.example.json`](../rc-node.example.json) to `rc-node.json`,
fill in `node_id`, `secret`, `model_endpoint` (base URL **with** `/v1`) and
`model`, then protect it — it contains your secret:

```sh
chmod 600 rc-node.json
```

The node looks for its configuration in this order: `--config=PATH`, the
environment variable `RC_NODE_CONFIG`, `./rc-node.json`. `RC_NODE_SECRET`
and `RC_NODE_MODEL_API_KEY` override the file, so the secrets can come from
a systemd credential or a secret store instead. Every key is described in
[CONTRACT.md](../CONTRACT.md#configuration-file-rc-nodejson). A
configuration error exits with code 2 and a one-line message on stderr.

## Command line

```
rc-node [--config=PATH] [--probe | --once | --one | --daemon]
```

| flag | what it does |
|---|---|
| `--probe` | checks reactive.chat and the model, takes **no** job; exit 0 when both answered |
| `--once` | one fetch cycle, then exit (default) |
| `--one` | like `--once` with one slot; prints SYSTEM and PROMPT of each job |
| `--daemon` | runs until SIGTERM/SIGINT (Windows: Ctrl+C / service stop); then fetches nothing more, finishes and delivers running jobs, exits 0 |

Start with the probe:

```
$ rc-node --probe
2026-09-30 19:40:02  Probe, rc-node-go 2.0.0.
2026-09-30 19:40:02    reactive.chat: https://reactive.chat
2026-09-30 19:40:02      HTTP 200 - signed in, 0 job(s) waiting.
2026-09-30 19:40:02    Model: http://127.0.0.1:8000/v1/chat/completions (mistral-small-24b)
2026-09-30 19:40:03      Answer in 412 ms: Bereit
2026-09-30 19:40:03    Node: kn-0123456789abcdef, takes: chat, can: chat, images: no
2026-09-30 19:40:03  Result: ready - reactive.chat accepted the node and the model answered.
```

`HTTP 401` means: wrong `node_id`/`secret`, a wrong clock, or the node was
revoked in the customer area.

## Run as a service

### Linux (systemd)

```ini
# /etc/systemd/system/rc-node.service
[Unit]
Description=reactive.chat AI node
After=network-online.target
Wants=network-online.target

[Service]
User=rcnode
Group=rcnode
WorkingDirectory=/etc/rc-node
ExecStart=/usr/local/bin/rc-node --config=/etc/rc-node/rc-node.json --daemon
Restart=always
RestartSec=15
# graceful stop: the node finishes running jobs (up to `timeout` s)
TimeoutStopSec=180
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
# only needed if log_file is set:
# ReadWritePaths=/var/log/rc-node

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

For embeddings in "own node only" mode run a second unit with its own
config (`"kinds": ["embedding"]`), so no chat question waits behind a batch
of embeddings; both configs then say `"capabilities": ["chat", "embedding"]`.

### Windows

The same binary runs on Windows (`rc-node-windows-amd64.exe`). Log
timestamps use the embedded time-zone database, so `timezone` works without
extra files. To run it as a service, wrap it with
[NSSM](https://nssm.cc/) — it stops the program with Ctrl+C, which the node
treats like SIGTERM (graceful stop):

```bat
nssm install rc-node C:\rc-node\rc-node.exe --config=C:\rc-node\rc-node.json --daemon
nssm set rc-node AppStopMethodConsole 180000
nssm start rc-node
```

`sc.exe create` alone is not enough, because the binary does not implement
the Windows service control protocol; use NSSM (or a similar wrapper such as
WinSW). Restrict the config file to the service account
(`icacls rc-node.json /inheritance:r /grant:r "NT SERVICE\rc-node:R" Administrators:F`).

### macOS

Use a `launchd` job with `ProgramArguments` = `rc-node --config=... --daemon`
and `KeepAlive` = true.

## Upgrading

- Replace the binary and restart the service. The node keeps no state on
  disk; running jobs are finished before a graceful stop.
- From the PHP node `rc-knoten.php` (v1.x): the configuration keys are now
  English and the file is JSON — see the "reference key" column in
  [CONTRACT.md](../CONTRACT.md). The flags `--dauer` and `--einer` are still
  accepted as aliases of `--daemon` and `--one`. The PHP default log file
  (`rc-knoten.log` next to the script) is gone: set `log_file` if you want
  one, otherwise the log goes to stdout (journald).
- The User-Agent is now `rc-node-go/2.0.0`.

## Security notes

- The config file holds the node secret (and possibly a model API key):
  `chmod 600` (or 640 with a dedicated group), owned by the service user's
  group, never world-readable. Alternatively pass the secrets via
  `RC_NODE_SECRET` / `RC_NODE_MODEL_API_KEY`.
- **Outbound only.** The node opens no listening port. It needs outbound
  HTTPS to reactive.chat and a connection to your model server — nothing
  else. A firewall can drop all inbound traffic.
- Every request to reactive.chat is signed (HMAC-SHA256 over method, path,
  query and body, with a timestamp and a single-use nonce); the secret itself
  is never sent and never logged.
- `tls_verify: false` disables certificate checks towards reactive.chat —
  only for a staging system with a self-signed certificate. `resolve`
  (`host:port:ip`) pins the address while keeping the host name for TLS and
  the `Host` header. Both, and `basic_auth`, apply to reactive.chat only,
  not to the model server (as in the reference).
- The node never follows HTTP redirects and caps any buffered response at
  64 MB.
- Model answers are proposals: reactive.chat checks every number against the
  sources before a visitor sees an answer.

## Behavioural notes

- Up to `concurrency` model calls run in parallel (goroutines) while the
  long-poll, the delivery (`bring`) and the stream parts (`teil`) continue —
  one of each in flight at a time. When all slots are busy the node sends a
  heartbeat every 45 s. After a failed fetch it waits
  `min(300, 5 × failures)` seconds.
- Before fetching, the node checks that the model server answers
  (`GET {model_endpoint}/models`; with `chat_url` it is assumed up; an
  embedding-only process checks the embedding server instead).
- Log texts are English; the reasons (`grund`) sent to reactive.chat stay
  German, byte for byte as in the reference, because the server and the
  dashboards know them.
