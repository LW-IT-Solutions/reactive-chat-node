# rc-node — implementation contract (all languages)

Every implementation in this repository (`php/`, `node/`, `python/`, `ruby/`,
`dotnet/`, `go/`) MUST behave identically on the wire and MUST accept the
same configuration file and the same command line. The behavioural reference
is the original PHP node `reference/rc-knoten.php` (v1.3, German comments);
the wire protocol is described in `PROTOCOL.md`. Where this contract and the
reference disagree, this contract wins for configuration/CLI/logging, the
reference wins for everything on the wire.

Version of every implementation: **2.0.0**.
User-Agent towards reactive.chat: `rc-node-<lang>/2.0.0` (lang = php, node,
python, ruby, dotnet, go).

## Command line

```
rc-node [--config=PATH] [--probe | --once | --one | --daemon]
```

| flag | reference | behaviour |
|---|---|---|
| `--probe` | `--probe` | check both sides, take nothing (`hol` with `n=0&warte=0`), one test completion, one test embedding if `embed_url` set. Exit 0 if reactive.chat answered 200 AND the model answered, else 1. |
| `--once` (default) | no flag | one fetch cycle: fetch once, process, deliver, exit. Exit 1 if there was a connection error and nothing was done, else 0. |
| `--one` | `--einer` | like `--once` but exactly one slot (concurrency 1) and print SYSTEM/PROMPT of each job to stdout. |
| `--daemon` | `--dauer` | run forever; on SIGTERM/SIGINT (Windows: Ctrl+C / service stop) stop fetching, finish running jobs, deliver, exit 0. |

Config path resolution: `--config=PATH`, else env `RC_NODE_CONFIG`, else
`rc-node.json` in the current working directory.

Exit code 2 for any configuration error, with a one-line English message on
stderr.

## Configuration file (`rc-node.json`)

Flat JSON object. English keys. Unknown keys are ignored (forward compat).
Environment variables override the file: `RC_NODE_SECRET` → `secret`,
`RC_NODE_MODEL_API_KEY` → `model_api_key`.

| key | reference key | type | default | notes |
|---|---|---|---|---|
| `base_url` | basis | string | — required | e.g. `https://reactive.chat` |
| `node_id` | knoten | string | — required | must start with `kn-` |
| `secret` | geheim | string | — required | starts with `rcn_` (do not enforce) |
| `model` | modell | string | — required | model name the model server expects |
| `model_endpoint` | endpunkt | string | `""` | base URL WITH `/v1`; `/chat/completions`, `/models` appended |
| `chat_url` | chat_url | string | `""` | full URL (Azure); one of `model_endpoint`/`chat_url` required |
| `model_api_key` | modell_schluessel | string | `""` | |
| `model_key_header` | schluessel_kopf | string | `"Authorization"` | `Authorization` → `Bearer <key>`, anything else → `<header>: <key>` |
| `kinds` | arten | string[] | `["chat"]` | what THIS process fetches |
| `capabilities` | kann | string[] | `[]` (= kinds) | what the node can overall |
| `embed_url` | embed_url | string | `""` | full URL `/v1/embeddings` |
| `embed_model` | embed_modell | string | `""` | label of the vectors |
| `embed_timeout` | embed_wartezeit | int s | 120 | |
| `images` | bilder | bool | false | only with a vision model |
| `images_max` | bilder_max | int | 1 | |
| `stream` | strom | bool | true | |
| `stream_ms` | strom_ms | int ms | 400 | min 100 |
| `concurrency` | gleichzeitig | int | 1 | min 1 |
| `poll_wait` | warte | int s | 20 | clamp 0..60 |
| `timeout` | wartezeit | int s | 120 | per generation |
| `temperature` | temperatur | number | 0.2 | |
| `max_tokens` | max_tokens | int | 300 | when the job names none |
| `basic_auth` | basic | string | `""` | `user:password` for a staging site |
| `resolve` | resolve | string | `""` | `host:port:ip` — fixed name resolution (like curl `--resolve`); connect to ip, keep Host header and TLS SNI/cert name |
| `tls_verify` | tls_pruefen | bool | true | |
| `log_file` | protokoll | string | `""` | append log lines here too; empty = stdout only |
| `timezone` | zeitzone | string | `""` | for log timestamps (IANA name); empty = system |

Kind names: the wire names are `chat`, `uebersetzung`, `zusammenfassung`,
`einbettung`. The config ALSO accepts the English aliases `translation`,
`summary`, `embedding` and maps them to the wire names. Validation as in the
reference: if kinds contain `einbettung` then `embed_url` and `embed_model`
are required (exit 2).

The PHP implementation additionally reads a legacy `rc-knoten.conf.php`
(German keys) when `--konf=PATH` is given, so existing installations keep
working. No other implementation needs that.

## Logging

One line per event: `YYYY-MM-DD HH:MM:SS  <text>` to stdout (and `log_file`).
English texts. Never log the secret or the model API key. Job log line
format (mirrors the reference): `  #<id> <ms> ms: <first 100 chars>` /
`  #<id> discarded: <reason>`.

## Behaviour that MUST match the reference exactly

- HMAC signature (`RC-KI-v2`), nonce (16 hex chars) in the query, headers
  `X-RC-KI-TS`, `X-RC-KI-SIG`, `Content-Type: application/json`.
  GET without body for `hol`; POST with body for `bring` and `teil`.
  The signed query string is byte-identical to the one sent.
- Long-poll `hol` with `n`, `warte`, `arten`, `kann`, `bilder=1` (only when
  `images`), heartbeat `hol` with `n=0&warte=0&kann=...` every 45 s while all
  slots are busy.
- Backoff after a failed `hol`: `min(300, 5 * consecutive_failures)` seconds.
- Model readiness check before fetching (`GET {endpoint}/models` 200, or
  `chat_url` set, or embedding-only process → embed readiness).
- Job fields: `id, art, system, prompt, fakten, max_tokens, texte, bilder, strom`.
- Image filter (`bilderAusAuftrag`), image content-list format.
- Clean-up (`saeubern`) incl. German/English lead-in removal — same regexes.
- Number check (`zahlenPruefen`) and ONE retry with the exact German retry
  suffix from the reference; `KEINE_ANTWORT` passed through unchanged.
- Streaming: SSE `stream:true`, parts via `teil` (max 8 entries per call, one
  `teil` call in flight at a time, per job at most every `stream_ms`, text
  cut at the last whitespace (`stromSchnitt`), only grown text, > 16000 bytes
  → stop parts for that job, `weiter:false` stops parts for that job,
  400/404 on `teil` → streaming off until restart). The final result is still
  delivered via `bring`. Each retry starts with empty text; `n` keeps counting.
- Embedding jobs → `embed_url`, result JSON string exactly as `einbettenLesen`
  builds it.
- Failures are delivered too (`text: ""`, `grund: <reason>`).
- `bring` body: `{"ergebnisse":[{"id","text","grund","modell","ms","knoten"}]}`.

Reasons (`grund`) sent to the server keep the reference's German strings
(the server and dashboards know them). Log texts are English.

## Tests

- `conformance/` contains a mock reactive.chat server and a mock
  OpenAI-compatible model server plus a runner:
  `node conformance/run.js --impl=<name> -- <command to start the node...>`
  The runner writes a config file and appends `--config=<file>` and a mode
  flag itself.
- NEVER point any test at reactive.chat or any
  real model server. Mocks on 127.0.0.1 only.
- Every implementation also ships its own small unit tests for
  signature, clean-up, number check and stream cut (known vectors from
  `conformance/vectors.json`).

## Dependencies

Standard library only wherever possible (security-sensitive software that
people run on their servers): Node ≥ 18 (global fetch or http/https),
Python ≥ 3.9 stdlib, Ruby ≥ 3.0 stdlib, Go ≥ 1.21 stdlib, .NET 8, PHP ≥ 8.1
with curl + json.
