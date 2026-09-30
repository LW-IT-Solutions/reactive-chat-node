# Conformance suite

Checks that a node implementation behaves on the wire exactly as described in
[`PROTOCOL.md`](../PROTOCOL.md) and [`CONTRACT.md`](../CONTRACT.md).

Everything runs locally: the runner starts a mock reactive.chat server and a
mock OpenAI-compatible model server on `127.0.0.1` (ephemeral ports) for every
case. Nothing is sent anywhere else. Node.js 18 or newer, no npm packages.

## Files

| file | purpose |
|---|---|
| `run.js` | the runner with both mock servers and all cases |
| `vectors.json` | known-answer vectors (signature, clean-up, number check, stream cut, SSE parsing, embedding result, image filter, retry suffix) for each implementation's unit tests |
| `verify_vectors.php` | re-checks `vectors.json` against the reference functions (`php conformance/verify_vectors.php`) |
| `adapters/reference.sh` | runs the legacy reference node (`reference/rc-knoten.php`) with a JSON config |
| `tools/` | the generator that produced `vectors.json` from the reference |

## Running

From the repository root:

```sh
node conformance/run.js --impl=<name> -- <command that starts your node...>
```

The runner appends `--config=<temp file>` and exactly one mode flag
(`--probe`, `--once`, `--one` or `--daemon`) to your command. The command is
started in the directory you run the runner from. Examples:

```sh
node conformance/run.js --impl=php    -- php php/rc-node.php
node conformance/run.js --impl=node   -- node node/rc-node.js
node conformance/run.js --impl=python -- python3 python/rc_node.py
node conformance/run.js --impl=go     -- ./go/rc-node
node conformance/run.js --impl=dotnet -- dotnet dotnet/bin/Release/net8.0/rc-node.dll
node conformance/run.js --impl=ruby   -- ruby ruby/rc-node.rb
node conformance/run.js --impl=reference -- sh conformance/adapters/reference.sh
```

Options (before `--`):

| option | effect |
|---|---|
| `--impl=<name>` | name printed in the summary; `reference` skips the cases the legacy node cannot pass by design |
| `--only=a,b` | run only these cases (a slow case named here runs without `--slow`) |
| `--slow` | include slow cases (`heartbeat` takes about 55 s) |
| `--verbose` / `-v` | print exit code, stdout and stderr of failed cases |
| `--keep` | keep the temp directories (config, log file) |
| `--list` | list the case names |

Output: one line per case, then a summary; exit code 1 if any case failed.

```
PASS probe_ok 0.3s
FAIL stream_parts teil #701 n=2 cut after digit+space (thousands separator rule): "Wir haben 1 "
SKIP heartbeat slow (use --slow)
impl=node pass=45 fail=1 skip=2
```

A full run takes about 35 s (plus about 55 s with `--slow`).

## What your node must support for the suite

* The command line and JSON config of `CONTRACT.md`. The config the runner
  writes uses `base_url`, `node_id`, `secret`, `model`, `model_endpoint`,
  `poll_wait` (usually 1), `timeout`, `log_file` and, depending on the case,
  most other keys, including unknown keys that must be ignored.
* `RC_NODE_SECRET` / `RC_NODE_MODEL_API_KEY` overriding the file.
* Exit codes: 0/1 as in `CONTRACT.md`, 2 for configuration errors (with a
  message on stderr and no network traffic).
* SIGTERM in `--daemon` mode: stop fetching, finish and deliver running jobs,
  exit 0.
* The secret and the model API key must never appear in stdout, stderr or
  the log file - this is checked in every case.

## What the mocks check in every case

* Every request to reactive.chat is signed correctly (RC-KI-v2 HMAC over the
  raw path, raw query and raw body, `|ts - now| <= 300`, lowercase hex); every
  signature is accepted only once.
* A 16-hex-character `nonce` in every query, `Content-Type: application/json`,
  `hol` as GET without body, `bring`/`teil` as POST.

## Cases

| case | checks |
|---|---|
| `probe_ok` | `hol n=0&warte=0`, test completion (system/prompt/max_tokens 20), takes no job, exit 0 |
| `probe_401` | wrong secret: exit 1 |
| `probe_model_down` | model unreachable: exit 1 |
| `probe_embed` | test embedding `["Bereit"]` with `embed_model` |
| `once_empty` | readiness `GET /models` before `hol`, `n=1&warte=<poll_wait>`, exit 0 |
| `once_chat` | request body (model, temperature, config `max_tokens`, messages, no stream), clean-up, exact `bring` entry |
| `one_mode` | `--one`: `n=1` despite `concurrency: 3`, SYSTEM/PROMPT on stdout |
| `concurrency_3` | three jobs arriving together during a long poll, `n=3`, three overlapping model calls, job `max_tokens` |
| `retry_invented_number_then_ok` | second request = prompt + exact German suffix, then success |
| `retry_invented_number_fails` | exactly one retry, `grund: "erfundene Zahl: 69"` |
| `keine_antwort_passthrough` | `KEINE_ANTWORT` delivered unchanged, no retry, no number check |
| `empty_after_clean` | retry, then `leer nach dem Saeubern` |
| `model_http_error` | `Modell HTTP 500: <160 chars>`, failure delivered, no retry |
| `model_timeout` | `timeout` respected, `Modell nicht erreichbar: ...` |
| `job_without_prompt` | `Auftrag ohne Text`, no model call |
| `embedding_job` | embedding-only process (`kinds: ["embedding"]`): embed readiness, no chat model, request body, exact result string (vectors returned out of order) |
| `embedding_without_embed_url` | `kein Einbettungsserver` |
| `embedding_without_texts` | `Einbettung ohne Texte`, `arten=chat,einbettung` |
| `embedding_http_error` | `Einbettung HTTP 500: ...` |
| `images_on` | `bilder=1`, content list with one image (`images_max: 1`) |
| `images_filter` | invalid/unsupported images dropped, order kept, `images_max: 2` |
| `images_off` | no `bilder=1`, plain string content even if the server sends images |
| `stream_parts` | `stream: true`, parts cut at whitespace (not after `1 `), grown text, `n` 1,2,3..., `stream_ms` spacing, one `teil` in flight, final `bring` |
| `stream_weiter_false` | `weiter: false` stops parts for the job, `bring` still sent |
| `stream_teil_404` | 404 on `teil`: no more parts, the retry does not stream, `bring` still sent |
| `stream_retry_n_continues` | retry streams from empty text, `n` keeps counting |
| `stream_many_jobs` | 10 streaming jobs: at most 8 entries per `teil`, one in flight |
| `stream_config_off` | `stream: false` never streams |
| `heartbeat` (slow) | `hol n=0&warte=0&kann=chat` about 45 s after the fetch while the only slot is busy |
| `backoff_after_failed_hol` | second `hol` about 5 s after a failed one (daemon), exit 0 on SIGTERM |
| `model_not_ready` | `/models` 503: no `hol`, exit 1 |
| `rc_unreachable` | connection error, nothing done: exit 1 |
| `daemon_sigterm_finishes_job` | SIGTERM during a model call: no new `hol`, job delivered, exit 0 |
| `model_key_bearer` | `Authorization: Bearer <key>` on `/models` and completions |
| `azure_chat_url_api_key` | `chat_url` used verbatim, `api-key` header, no `/models` |
| `basic_auth` | HTTP basic auth on every reactive.chat request, never to the model |
| `resolve_fixed_address` | `resolve` pins the address, `Host` header keeps the name |
| `kinds_aliases_and_capabilities` | `translation`/`summary`/`embedding` mapped to wire names in `arten`/`kann` |
| `poll_wait_clamp` | `poll_wait: 99` sends `warte=60` |
| `config_*` | missing `node_id`, `node_id` without `kn-`, embedding without `embed_url`, no model endpoint, invalid JSON: exit 2, stderr, no traffic |
| `env_override` | `RC_NODE_SECRET` and `RC_NODE_MODEL_API_KEY` override the file |
| `unknown_keys_ignored` | unknown config keys are ignored |
| `secret_not_logged` | `log_file` written, `YYYY-MM-DD HH:MM:SS  ` line format, no secrets |
| `user_agent` | `User-Agent: rc-node-<lang>/2.0.0` (skipped for the reference) |

## Unit test vectors

`vectors.json` sections: `signature`, `clean`, `numbers`, `stream_cut`, `sse`
(byte chunks as base64; feed them one by one, then finish), `embed_result`,
`images`, plus `retry_suffix` and `constants`. Each entry has a `name`, the
input and the expected output as produced by the reference. Non-ASCII
characters are `\u`-escaped, so any JSON parser reads them correctly.
`transport_error` texts are implementation specific; only the prefix is
normative.

Regenerate (only when the reference changes) with
`php conformance/tools/gen_vectors.php conformance/vectors.json` and verify
with `php conformance/verify_vectors.php`.
