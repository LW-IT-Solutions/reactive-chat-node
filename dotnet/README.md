# rc-node for .NET

The reactive.chat **"bring your own model"** AI node, written in C# for .NET 8.

The node runs on **your** machine. It fetches the AI jobs of your workspace from
reactive.chat, has **your** language model answer them (any OpenAI-compatible server:
vLLM, Ollama, LM Studio, llama.cpp, Azure OpenAI) and delivers the answers back.
The node always calls out: reactive.chat never connects to it. You need no public
address, no open port and no fixed IP.

This is the .NET flavour of rc-node, alongside the PHP, Node.js, Python, Ruby and Go
versions in this repository. All of them read the same configuration file, take the same
command line and behave identically on the wire (see [`../CONTRACT.md`](../CONTRACT.md)).
It is a plain console worker without a web server, so it is **not** an ASP.NET web app. It
depends only on the .NET base class library (no NuGet packages).

## Requirements

* **To run a published build:** nothing. The self-contained builds below bring their own
  runtime. Supported: Linux x64, Linux arm64 (for example a Raspberry Pi 4/5 with a
  64-bit OS) and Windows x64.
* **To build it yourself:** the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).
  Without root you can use `./dotnet-install.sh --channel 8.0 --install-dir ~/.dotnet`.
* A model server with an OpenAI-compatible `/v1/chat/completions` endpoint.
  For embedding jobs you also need a `/v1/embeddings` endpoint.
* The node ID (`kn-...`) and secret (`rcn_...`) from the customer area (`/app/ai-node`).
  The secret is shown exactly once there.
* A correct system clock (NTP). Every request is signed, and a signature is valid for
  five minutes.

## Build and install

```sh
cd dotnet
dotnet build -c Release                      # -> bin/Release/net8.0/rc-node.dll
dotnet bin/Release/net8.0/rc-node.dll --help
```

Self-contained single-file builds. Copy the one file to the target machine; no .NET is
needed there:

```sh
dotnet publish RcNode.csproj -c Release -r linux-x64   --self-contained -p:PublishSingleFile=true -p:PublishTrimmed=true -o out/linux-x64
dotnet publish RcNode.csproj -c Release -r linux-arm64 --self-contained -p:PublishSingleFile=true -p:PublishTrimmed=true -o out/linux-arm64
dotnet publish RcNode.csproj -c Release -r win-x64     --self-contained -p:PublishSingleFile=true -p:PublishTrimmed=true -o out/win-x64
```

With trimming, the file is about 12 MB (about 34 MB without `-p:PublishTrimmed=true`).
The node uses no reflection-based serialisation, so trimming is safe. The conformance
suite passes against the trimmed linux-arm64 binary.
If you want a framework-dependent build that uses an installed .NET 8 runtime, use
`dotnet publish -c Release -o out/fdd` and start it with `dotnet out/fdd/rc-node.dll`.

On Linux, for example:

```sh
sudo useradd --system --home /opt/rc-node --shell /usr/sbin/nologin rcnode
sudo install -d -o rcnode -g rcnode -m 750 /opt/rc-node
sudo install -m 755 out/linux-x64/rc-node /opt/rc-node/rc-node
sudo install -o rcnode -g rcnode -m 600 ../rc-node.example.json /opt/rc-node/rc-node.json
sudo -u rcnode nano /opt/rc-node/rc-node.json          # fill in node_id, secret, model ...
```

## Configuration

One flat JSON file. Start from [`../rc-node.example.json`](../rc-node.example.json);
[`../CONTRACT.md`](../CONTRACT.md) lists every key with its default. The node looks for
the file in this order:

1. `--config=PATH`
2. the environment variable `RC_NODE_CONFIG`
3. `rc-node.json` in the current directory

`RC_NODE_SECRET` and `RC_NODE_MODEL_API_KEY` override `secret` and `model_api_key` from the
file, so you can keep both out of the file if you prefer. Unknown keys are ignored.
The English kind names `translation`, `summary` and `embedding` are accepted in `kinds` and
`capabilities`. A configuration error ends the node with exit code 2 and one line on stderr.

Minimal example:

```json
{
  "base_url": "https://reactive.chat",
  "node_id": "kn-0000000000000000",
  "secret": "rcn_...",
  "model_endpoint": "http://127.0.0.1:8000/v1",
  "model": "mistral-small-24b",
  "concurrency": 2,
  "log_file": "/var/log/rc-node/rc-node.log",
  "timezone": "Europe/Berlin"
}
```

`timezone` takes an IANA name. The builds run in .NET's invariant globalization mode
(no ICU needed). On Windows, an IANA name therefore may not resolve. In that case, use
the Windows zone ID instead (for example `"W. Europe Standard Time"`), or leave the key
empty to use the system zone. The node logs a warning if it cannot find the zone.

## Usage

```
rc-node [--config=PATH] [--probe | --once | --one | --daemon]
```

| flag | what it does | exit code |
|---|---|---|
| `--probe` | Checks both sides and takes no job: a `hol` with `n=0`, one test completion, one test embedding if `embed_url` is set. Prints a readable report. | 0 if reactive.chat answered 200 **and** the model answered, else 1 |
| `--once` (default) | One fetch cycle: fetch, compute, deliver, exit. | 1 if a connection error left nothing done, or the model server was down; else 0 |
| `--one` | Like `--once` with a single slot. Prints SYSTEM and PROMPT of each job to stdout (for debugging prompts). | as `--once` |
| `--daemon` | Runs until SIGTERM/SIGINT (Ctrl+C on Windows). On a stop signal it fetches nothing more, finishes the running jobs, delivers them and exits with 0. | 0 |

Always start with the probe:

```
$ rc-node --probe
2026-09-30 19:40:42  Probe, rc-node-dotnet 2.0.0.
2026-09-30 19:40:42    reactive.chat: https://reactive.chat
2026-09-30 19:40:42      HTTP 200 - signed in, 3 job(s) open.
2026-09-30 19:40:42    Model: http://127.0.0.1:8000/v1/chat/completions (mistral-small-24b)
2026-09-30 19:40:42      Answer in 410 ms: Bereit.
2026-09-30 19:40:42    Node: kn-0000000000000000, fetches: chat, can: chat, images: no
2026-09-30 19:40:42  Result: OK - reactive.chat accepted the node and the model answered.
```

HTTP 401 usually means a wrong node ID or secret, a wrong clock, or a revoked node.

In daemon mode, each finished job logs one line, for example
`  #1234 812 ms: We open at 9.  parts 6  [0/2]` or `  #1235 discarded: number not in the sources: 59  [1/2]`.
The reason that goes to reactive.chat stays the reference's German `grund` text.

## Run as a service

### Linux (systemd)

`/etc/systemd/system/rc-node.service`:

```ini
[Unit]
Description=reactive.chat AI node (rc-node, .NET)
After=network-online.target
Wants=network-online.target

[Service]
User=rcnode
Group=rcnode
WorkingDirectory=/opt/rc-node
ExecStart=/opt/rc-node/rc-node --daemon --config=/opt/rc-node/rc-node.json
# Graceful stop: SIGTERM, then the node finishes and delivers the running jobs.
# Allow at least poll_wait + timeout (+ some margin) seconds for that.
KillSignal=SIGTERM
TimeoutStopSec=180
Restart=always
RestartSec=15
# Hardening: the node only needs outbound network access and its log file.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/log/rc-node
# Should a single-file build ever need to unpack native parts, it may use the private
# /tmp only (the home directory is read-only here).
Environment=DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp

[Install]
WantedBy=multi-user.target
```

```sh
sudo install -d -o rcnode -g rcnode -m 750 /var/log/rc-node
sudo systemctl daemon-reload
sudo systemctl enable --now rc-node
journalctl -u rc-node -f
```

If you keep `log_file` empty, the node logs to stdout only, and the systemd journal
collects the lines.

### Windows

The node is a plain console program without dependencies. `sc.exe create` cannot run
a console program directly as a service (the Service Control Manager expects a service
handshake and reports error 1053). Use a service wrapper that stops the program with
Ctrl+C, so that the running jobs are finished and delivered:

**WinSW** ([github.com/winsw/winsw](https://github.com/winsw/winsw)): put
`WinSW-x64.exe` next to `rc-node.exe` as `rc-node-service.exe`, and add
`rc-node-service.xml`:

```xml
<service>
  <id>rc-node</id>
  <name>reactive.chat AI node</name>
  <description>Fetches reactive.chat AI jobs and answers them with the local model.</description>
  <executable>%BASE%\rc-node.exe</executable>
  <arguments>--daemon --config="%BASE%\rc-node.json"</arguments>
  <stoptimeout>180 sec</stoptimeout>
  <onfailure action="restart" delay="15 sec"/>
  <log mode="roll-by-size"/>
</service>
```

```bat
rc-node-service.exe install
rc-node-service.exe start
```

**NSSM** ([nssm.cc](https://nssm.cc)):

```bat
nssm install rc-node C:\rc-node\rc-node.exe --daemon --config=C:\rc-node\rc-node.json
nssm set rc-node AppStopMethodConsole 180000
nssm set rc-node AppExit Default Restart
nssm start rc-node
```

Protect the configuration file so that only administrators and the service account can
read it, for example:
`icacls C:\rc-node\rc-node.json /inheritance:r /grant:r Administrators:F SYSTEM:R`.

## Upgrading

* **From `rc-knoten.php` 1.x:** the configuration moves from `rc-knoten.conf.php`
  (German keys) to `rc-node.json` (English keys). [`../CONTRACT.md`](../CONTRACT.md) maps
  every old key to its new name (`basis` -> `base_url`, `knoten` -> `node_id`,
  `geheim` -> `secret`, `endpunkt` -> `model_endpoint`, `gleichzeitig` -> `concurrency`,
  `warte` -> `poll_wait`, `strom` -> `stream`, ...). The flags are renamed as well:
  `--dauer` -> `--daemon` and `--einer` -> `--one`. `--konf=` becomes `--config=`.
  Log texts are now English. `log_file` is empty by default (1.x wrote `rc-knoten.log`
  next to the script). The User-Agent is now `rc-node-dotnet/2.0.0`. What goes over
  the wire stays unchanged, including the German `grund` reasons. Node ID and secret
  stay the same, so you do not need a new node.
* **Within 2.x:** stop the service, replace the binary, then start it again. The
  configuration file stays compatible. On a stop, the node finishes and delivers the
  running jobs first, so no job is lost.
* **Running several processes:** for example, one for `chat` and one for `einbettung`.
  Give each process its own configuration file with its own `kinds`, and set the same
  `capabilities` in both, as in the reference.

## Security notes

* **Secret file:** `rc-node.json` contains the node secret (and maybe a model API key).
  Set `chmod 600`, make it owned by the service user, and do not put it in version
  control. You can pass the secret via `RC_NODE_SECRET` instead (for example with a
  systemd `EnvironmentFile=` that also has mode 600). A leaked secret can be revoked in
  the customer area. Then create a new node.
* **Outbound only:** the node opens no port and accepts no connection. It makes outbound
  HTTPS requests to `base_url`, and requests to your model and embedding servers
  (usually on localhost or your LAN). A firewall can block all inbound traffic.
* **Signed requests:** every request to reactive.chat carries an HMAC-SHA256 signature
  over time, method, path, query (with a random nonce) and body. Each signature is valid
  once, for five minutes.
* **Never logged:** the secret and the model API key never appear in stdout or the log
  file. The model API key is sent only to the chat completions and `/models` endpoints,
  not to the embedding server and not to reactive.chat. `basic_auth`, `resolve` and
  `tls_verify` apply only to the reactive.chat connection.
* **`tls_verify: false`** turns off certificate checks for reactive.chat. Use it only
  against a staging system that you control.
* **Your data:** the node receives only jobs of your own workspace. Its answers are
  proposals: reactive.chat checks them (every number must appear in the sources) before
  anything reaches a visitor.
* **Images** (`images: true`) arrive as re-encoded JPEG data URLs without EXIF/GPS. Enable
  them only with a vision model.

## Tests

Unit tests (signature, clean-up, number check, stream cut, SSE parsing, embedding result,
image filter) against the known vectors in `../conformance/vectors.json`. The tests need
no test framework and nothing from NuGet:

```sh
cd dotnet/tests && dotnet run -c Release
# OK: 269 passed, 0 failed (.../conformance/vectors.json)
```

End-to-end conformance against the mock reactive.chat and model servers (from the
repository root):

```sh
node conformance/run.js --impl=dotnet -- dotnet dotnet/bin/Release/net8.0/rc-node.dll
node conformance/run.js --impl=dotnet --slow -- dotnet/out/linux-x64/rc-node   # incl. the 45 s heartbeat case
```

## How it works

A single loop owns all state. It mirrors the reference's `curl_multi` loop. Every HTTP
exchange is a `Task` running in parallel: up to `concurrency` model calls, plus at most
one long-poll `hol`, one `bring` and one `teil` in flight. The loop starts them, waits
for the next one to finish (or a 0.1 s / 1 s tick), and handles what is done. Model
answers are streamed over SSE when the job and the configuration ask for it. The loop
sends the text so far as parts, at most every `stream_ms` per job. The final answer
still goes through clean-up, the number check (one retry) and `bring`.

Source layout: `src/Program.cs` (command line), `src/Config.cs`, `src/Worker.cs` (the
loop), `src/Net.cs` (HTTP, signature, resolve/TLS), `src/StreamState.cs` (SSE),
`src/Answers.cs` (model/embedding answers), `src/TextRules.cs` (clean-up, number check,
stream cut, image filter), `src/Php.cs` (PHP-compatible JSON), `src/Probe.cs`.

## License

MIT - see [`../LICENSE`](../LICENSE).
