# reactive.chat node protocol ("bring your own model")

This document describes the wire protocol between a **node** and
reactive.chat. A node is a small program that runs on your own machine,
fetches the AI jobs of your workspace from reactive.chat, has them answered by
your own language model (any OpenAI-compatible server) and delivers the
results back.

The node always calls reactive.chat; reactive.chat never connects to the
node. A node therefore needs no public address, no open port and no fixed IP.

Everything here is normative for anyone writing their own node. The
implementations in this repository follow it and are checked with the
conformance suite in [`conformance/`](conformance/README.md); the known-answer
vectors for every string transformation are in
[`conformance/vectors.json`](conformance/vectors.json).

Field names on the wire are German and must be used verbatim. They are
translated in the prose below.

Contents

1. [Endpoint](#1-endpoint)
2. [Authentication: the request signature](#2-authentication-the-request-signature)
3. [Responses and status codes](#3-responses-and-status-codes)
4. [`hol` - fetch jobs (long poll)](#4-hol---fetch-jobs-long-poll)
5. [`bring` - deliver results](#5-bring---deliver-results)
6. [`teil` - partial text while streaming](#6-teil---partial-text-while-streaming)
7. [Job kinds](#7-job-kinds)
8. [Processing a chat job](#8-processing-a-chat-job)
9. [Processing an embedding job](#9-processing-an-embedding-job)
10. [Streaming](#10-streaming)
11. [Main loop, concurrency, heartbeat, backoff, shutdown](#11-main-loop-concurrency-heartbeat-backoff-shutdown)
12. [Failure reasons (`grund`)](#12-failure-reasons-grund)
13. [Versioning](#13-versioning)

---

## 1. Endpoint

One endpoint, three actions:

```
{base_url}/v1/ki?action=hol|bring|teil&knoten=<node id>[&...]&nonce=<16 hex chars>
```

| parameter | meaning |
|---|---|
| `action` | `hol` (fetch), `bring` (deliver), `teil` (partial text) |
| `knoten` | the node id from the customer area, e.g. `kn-0123456789abcdef`. Always starts with `kn-`; allowed characters `A-Z a-z 0-9 . _ -`, at most 64. |
| `nonce` | 16 random lowercase hex characters (8 random bytes), new for every request. The nodes in this repository put it last. |

`base_url` is `https://reactive.chat` in production. It may contain a path
prefix (for a staging installation); the path is then part of the signature
(see the `subpath_base_url` vector).

Every request carries

| header | value |
|---|---|
| `X-RC-KI-TS` | Unix time in seconds, decimal (e.g. `1790000000`) |
| `X-RC-KI-SIG` | the signature, 64 lowercase hex characters |
| `Content-Type` | `application/json` (also on `GET`) |
| `User-Agent` | `rc-node-<lang>/<version>`, e.g. `rc-node-go/2.0.0` |
| `Authorization` | only if a staging installation needs HTTP basic auth (`basic_auth` in the config) |

`hol` is a `GET` **without a body**. `bring` and `teil` are `POST` with a JSON
body. Never send a body with `GET`, and never let an HTTP library turn the
request into a `POST` because a body was attached - the method is signed.

## 2. Authentication: the request signature

Each node has a secret (`rcn_...`), shown exactly once in the customer area.
Every request is signed with HMAC-SHA256 under that secret:

```
string_to_sign = "RC-KI-v2" + "\n"
               + ts        + "\n"      // the X-RC-KI-TS value
               + METHOD    + "\n"      // "GET" or "POST", upper case
               + path      + "\n"      // e.g. "/v1/ki"
               + query     + "\n"      // everything after "?", byte for byte
               + body                  // raw body bytes; "" for GET

X-RC-KI-SIG = lowercase_hex( HMAC-SHA256(key = secret, message = string_to_sign) )
```

Rules - each of them has broken a real node at some point:

* **Path and query are taken raw** from the request line the server receives:
  the path up to the first `?`, the query after it, exactly as sent (same
  parameter order, same percent-encoding). Build the query string once, sign
  that string, and send that same string. Do not let a URL library re-encode
  or reorder it after signing. Values are percent-encoded like PHP
  `rawurlencode` (`,` becomes `%2C`, space becomes `%20`).
* **The body is signed as bytes.** Serialize the JSON once, sign those bytes,
  send those bytes. UTF-8 is sent as UTF-8 (no requirement to escape non-ASCII;
  whatever you sign is what counts).
* **The clock matters.** The server accepts `|server_time - ts| <= 300`
  seconds. Keep the machine on NTP.
* **Every signature is valid exactly once.** A second request with the same
  signature gets `401 {"fehler":"Signatur schon verbraucht"}`. Two otherwise
  identical requests in the same second would collide - this is what the
  `nonce` is for. It is part of the query and therefore signed.
* A wrong secret, an unknown node id and a revoked node are indistinguishable:
  all get `401 {"fehler":"Signatur abgelehnt"}`. Repeated rejections (20
  within 10 minutes) can get the source address blocked for 15 minutes
  (`429`, `Retry-After`). A node that gets 401 should not hammer the server.

### Worked example (GET)

```
secret  = rcn_test_secret_0123456789abcdef
ts      = 1790000000
method  = GET
path    = /v1/ki
query   = action=hol&knoten=kn-0123456789abcdef&n=0&warte=0&arten=chat&kann=chat&nonce=00112233aabbccdd
body    = (empty)

string_to_sign (\n shown as line breaks):
RC-KI-v2
1790000000
GET
/v1/ki
action=hol&knoten=kn-0123456789abcdef&n=0&warte=0&arten=chat&kann=chat&nonce=00112233aabbccdd
<empty last line>

X-RC-KI-SIG = 5ce16ad733e66e8cfe0964a05b144027d7bf0d7e52c85abb70912a9c6f7a602a
```

Note the final `"\n"` after the query even though the body is empty.

### Worked example (POST with UTF-8)

```
ts     = 1790000003, method = POST, path = /v1/ki
query  = action=bring&knoten=kn-0123456789abcdef&nonce=a1b2c3d4e5f60718
body   = {"ergebnisse":[{"id":17,"text":"Grüße – schön, 49 €","grund":"","modell":"mistral","ms":812,"knoten":"kn-0123456789abcdef"}]}
         (raw UTF-8, not \u-escaped)

X-RC-KI-SIG = 5d0b8256fe8edf3bdbabada4ab1e8e8ca197601c44b14a3fb3ab95ac2fc4adcf
```

More cases are in `conformance/vectors.json` (`signature`, each with its
`string_to_sign`).

## 3. Responses and status codes

Responses are JSON (`Content-Type: application/json; charset=utf-8`). Errors
carry a German message in `fehler` ("error"), sometimes a hint such as
`wiederholen_in_s` ("retry in seconds") or `deckel` ("limit").

| status | when | node reaction |
|---|---|---|
| 200 | success | see the action |
| 400 | `knoten` missing/invalid (`knoten fehlt oder ist unzulaessig`), unknown action (`unbekannte action`), `bring` without `ergebnisse` array, `teil` without `teile` array | configuration or programming error; for `teil` see [section 6](#6-teil---partial-text-while-streaming) |
| 401 | signature rejected or reused | check id, secret and clock |
| 413 | body too large, more than 100 results in one `bring`, more than 8 entries in one `teil` | split the request |
| 429 | source address temporarily blocked after repeated 401 (`Retry-After`) | wait |
| 503 | temporarily unable (queue locked, too many concurrent long polls, node could not be verified), with `Retry-After` | treat as a failed request (backoff) |

The server allows at most 2 concurrent long polls per node id (plus a global
limit); more are answered with 503. A node process keeps exactly one `hol`
open at a time.

## 4. `hol` - fetch jobs (long poll)

```
GET {base_url}/v1/ki?action=hol&knoten=<id>&n=<n>&warte=<s>&arten=<kinds>&kann=<kinds>[&bilder=1]&nonce=<hex>
```

| parameter | meaning |
|---|---|
| `n` | "number": how many jobs the node takes at most. Server clamps to 0..20, default 1. `n=0` is a **probe**: look, take nothing. |
| `warte` | "wait": long-poll seconds, clamped to 0..60. The server holds the request until at least one job is available or `warte` seconds have passed. |
| `arten` | "kinds": comma-separated job kinds THIS process fetches (default `chat`), e.g. `chat` or `einbettung`. |
| `kann` | "can": comma-separated kinds the node handles overall (all its processes together). The server records the node's kinds from `kann` (from `arten` if `kann` is absent). A node that splits chat and embeddings over two processes sends the same `kann` from both, so neither process "loses" the other's kind. |
| `bilder` | "images": `bilder=1` only if the node has a vision model and accepts images. Omit the parameter otherwise. |

Commas may be sent literally or as `%2C`; the reference sends
`rawurlencode(implode(',', ...))`, i.e. `%2C`.

The node's client-side timeout for a long poll is `warte + 20` seconds.

### Response of a probe (`n=0`)

```json
{"auftraege": [], "offen": 3}
```

`offen` ("open") is the number of waiting jobs this node would get. A probe
never takes a job.

### Response of a fetch (`n>=1`)

```json
{"auftraege": [
  {"id": 4711, "art": "chat",
   "system": "You are the assistant of ...",
   "prompt": "Visitor question plus sources ...",
   "fakten": "Opening hours 9-17 ...",
   "max_tokens": 300,
   "strom": 1,
   "bilder": ["data:image/jpeg;base64,/9j/4AAQ..."]},
  {"id": 4712, "art": "einbettung", "system": "", "prompt": "", "fakten": "",
   "texte": ["first text", "second text"], "zweck": "crawl"}
]}
```

An empty long poll ends with `{"auftraege": []}`.

Job fields ("Auftrag" = job):

| field | type | present | meaning |
|---|---|---|---|
| `id` | int | always | job id, positive. Deliver the result under this id. |
| `art` | string | always | kind: `chat`, `uebersetzung`, `zusammenfassung`, `einbettung` |
| `system` | string | always | system prompt for the model |
| `prompt` | string | always | user message for the model (for a chat job it already contains the sources) |
| `fakten` | string | always | "facts": the source text every number of the answer must come from. It is used by the number check and **never** sent to the model. |
| `max_tokens` | int | optional | token limit for this job; if absent or `<= 0` use the node's configured `max_tokens` |
| `strom` | int (1) | optional, chat only | "stream": the caller would like partial text (see [section 10](#10-streaming)) |
| `texte` | string[] | embedding only | "texts" to embed |
| `zweck` | string | embedding only | "purpose" (`frage` = visitor question, `crawl` = knowledge base); informational |
| `bilder` | string[] | optional, chat only, only with `bilder=1` | "images": visitor attachments as `data:image/jpeg;base64,...` URLs (downscaled to 768 px, re-encoded, no EXIF). Without `bilder=1` the server instead appends a note to `prompt` that an image was attached which the model cannot see. |

Unknown fields must be ignored. Missing strings count as `""`, a missing
`art` as `chat`. Skip entries whose `id` is not a positive integer and ids the
node is already working on.

Handing out a job starts its lease. A chat job is only useful while a visitor
waits: deliver within seconds, and **always** deliver - also a failure (see
[section 5](#5-bring---deliver-results)) - so the server can hand the
conversation to a human at once instead of waiting for the lease to run out.
Jobs that were never delivered fall back to the queue or expire (chat after
90 s, embeddings after 300 s at the time of writing).

## 5. `bring` - deliver results

```
POST {base_url}/v1/ki?action=bring&knoten=<id>&nonce=<hex>
```

```json
{"ergebnisse": [
  {"id": 4711, "text": "We open at 9.", "grund": "", "modell": "mistral-small-24b", "ms": 812, "knoten": "kn-0123456789abcdef"},
  {"id": 4713, "text": "", "grund": "erfundene Zahl: 59", "modell": "mistral-small-24b", "ms": 1530, "knoten": "kn-0123456789abcdef"}
]}
```

| field | meaning |
|---|---|
| `ergebnisse` | "results", at most 100 per request |
| `id` | the job id (integer) |
| `text` | the result: the cleaned answer, `KEINE_ANTWORT`, or for an embedding job the JSON string of [section 9](#9-processing-an-embedding-job). `""` means the job failed. |
| `grund` | "reason": `""` on success, otherwise why the job failed (German strings, [section 12](#12-failure-reasons-grund)); stored up to 255 characters |
| `modell` | the configured model name (shown in the customer area) |
| `ms` | milliseconds spent at the model for this job (all attempts added up), integer |
| `knoten` | the node id |

All six fields are always sent, in this order.

Response, one entry per result in the same order:

```json
{"ergebnisse": [
  {"id": 4711, "angenommen": true,  "grund": ""},
  {"id": 4713, "angenommen": false, "grund": "als gescheitert vermerkt"}
]}
```

`angenommen` ("accepted"). Possible `grund` values of the response:

| `grund` | meaning |
|---|---|
| `""` | accepted |
| `als gescheitert vermerkt` | "recorded as failed" - you delivered `text: ""` |
| `erfundene Zahl: <digits>` | "invented number": the server's number check rejected the text (same rule as [8.4](#84-number-check)) |
| `unbekannt` | unknown job id |
| `nicht mehr offen (<state>)` | "no longer open": lease expired, delivered twice, ... |
| `gehoert inzwischen einem anderen Knoten` | "now belongs to another node" |
| `nicht zustaendig` | "not responsible": job of another workspace |
| `inzwischen vergeben` | "taken in the meantime" |
| `Sperrkonflikt - bitte erneut liefern` | transient lock conflict - deliver that result again |

A rejected result is final except for the last line; the node just logs it.
A failed `bring` (network error, non-200) is logged; the reference does not
retry it.

The server trims `text`, re-runs the number check on everything except
embeddings and `KEINE_ANTWORT`, and treats `KEINE_ANTWORT` as a successful
answer that hands the conversation to a human.

## 6. `teil` - partial text while streaming

For chat jobs with `strom` the node may send the text generated so far, so the
visitor sees the answer grow. `teil` ("part") is signed like `bring`:

```
POST {base_url}/v1/ki?action=teil&knoten=<id>&nonce=<hex>
```

```json
{"teile": [
  {"id": 4711, "n": 3, "text": "We open on Monday at "},
  {"id": 4714, "n": 1, "text": "Unfortunately "}
]}
```

| field | meaning |
|---|---|
| `teile` | "parts", at most 8 entries per request (more: 413) |
| `id` | job id |
| `n` | sequence number per job, integer starting at 1, +1 for every part sent for that job (also across a retry) |
| `text` | the whole raw model text so far, cut at whitespace ([10.2](#102-cut-and-send-parts)), at most 16000 characters |

Response, one entry per part in the same order:

```json
{"teile": [
  {"id": 4711, "angenommen": true,  "weiter": true,  "grund": ""},
  {"id": 4714, "angenommen": false, "weiter": false, "grund": "erfundene Zahl: 5"}
]}
```

`angenommen` = accepted, `weiter` ("continue") = whether more parts for this
job are wanted. **`weiter: false` means: send no more parts for this job**
(the job itself continues and is delivered with `bring` as usual). Reasons
include `n oder text unzulaessig`, `text ueber 16000 Zeichen`, `unbekannt`,
`kein chat-Auftrag`, `nicht mehr offen (...)`, `gehoert einem anderen Knoten`,
`nicht zustaendig`, `erfundene Zahl: <digits>` (a part with a number that is not
in the facts ends the stream of that job), all with `weiter: false`, and
`n nicht groesser als <k>`, `Sperrkonflikt`, `nicht gespeichert`,
`Zwischenspeicher nicht erreichbar` with `weiter: true`.

A part is a preview, never a delivery: the final answer always comes with
`bring`, cleaned and checked.

**A server without streaming support** answers `teil` with 400 or 404. A
node that sees 400 or 404 on `teil` stops streaming for the rest of its
process lifetime (no more `teil`, and new model requests without
`stream: true`). Any other `teil` failure (network, 5xx) is ignored; the next
part comes anyway.

## 7. Job kinds

| wire name | config alias | handled as |
|---|---|---|
| `chat` | `chat` | chat completion ([section 8](#8-processing-a-chat-job)), may stream |
| `uebersetzung` | `translation` | chat completion, never streams |
| `zusammenfassung` | `summary` | chat completion, never streams |
| `einbettung` | `embedding` | embeddings ([section 9](#9-processing-an-embedding-job)) |

Only the wire names go on the wire. A node asks for embedding jobs only if
it has an embedding server; it is recommended to run a separate process for
them (`arten=einbettung`) so no chat question waits behind a batch, with the
same `kann` in both processes.

## 8. Processing a chat job

`chat`, `uebersetzung` and `zusammenfassung` jobs. If `prompt` is `""` the
job fails immediately with `Auftrag ohne Text` (no model call).

### 8.1 Model request

`POST {model_endpoint}/chat/completions` (or the full `chat_url`, e.g. Azure
OpenAI):

```json
{"model": "<model>",
 "stream": false,
 "temperature": 0.2,
 "max_tokens": 300,
 "messages": [
   {"role": "system", "content": "<system>"},
   {"role": "user",   "content": "<prompt>"}
 ]}
```

* `max_tokens`: the job's value if > 0, else the configured `max_tokens`.
* `stream`: `true` only when streaming ([section 10](#10-streaming)).
* API key: `Authorization: Bearer <key>` for the default header, otherwise
  `<header>: <key>` (Azure: `api-key: <key>`). No key, no header.
* **Images.** Only when the node is configured for images: the job's
  `bilder` are filtered - kept are strings of at most 4 MiB matching
  `^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$` (PCRE semantics: `$`
  also matches before one final `\n`; a JSON object counts as the list of its
  values), in order, at most `images_max`; with images off the list is always
  empty. With at least one image the user `content` becomes a list:
  ```json
  [{"type": "text", "text": "<prompt>"},
   {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}]
  ```
  Without images `content` stays a plain string - a text-only model sees the
  exact same request as before images existed. Vectors: `images`.

Answer text: `choices[0].message.content` of the JSON response (for
streaming see [10.1](#101-reading-sse)). Errors:

| situation | `grund` |
|---|---|
| connection error / timeout (`timeout` seconds per attempt) | `Modell nicht erreichbar: <error text>` |
| HTTP status other than 200 | `Modell HTTP <status>: <first 160 characters of the body>` |
| no `choices[0].message.content` | `Antwort ohne Text` |

A model error ends the job at once (no retry).

### 8.2 Clean-up

The answer is cleaned before anything else. The steps, in this order
(PCRE/PHP semantics - a pattern marked **/u** is Unicode-aware: `\s` matches
Unicode white space such as U+00A0, `\R` matches `\n`, `\r\n`, `\r`, `\v`,
`\f`, U+0085, U+2028, U+2029; a pattern without /u works on ASCII only;
"trim" strips exactly `" \t\n\r\0\x0B"`):

1. `<think>.*?</think>` (dot matches newlines, /u) is replaced by one space.
2. `<[^>]*>` is replaced by one space.
3. The substrings `**`, `__`, `` ` ``, `#` are deleted (single `*` and `_` stay).
4. trim.
5. Lead-in removal, once, case-insensitive, ASCII `\s`:
   `^\s*(hier (ist|sind)[^:\n]*:|here (is|are)[^:\n]*:|antwort:|answer:)\s*` is replaced by `""`.
   ("Hier ist die Antwort:", "Here are the details:", "Antwort:", "Answer:" ...)
6. trim.
7. If the whole text matches `^["\x{201C}\x{201E}\x{00AB}](.*)["\x{201D}\x{201C}\x{00BB}]$`
   (dot matches newlines, /u) it is replaced by the trimmed group: one pair of
   surrounding quotes `"..."`, `“...”`, `„...“`, `«...»` (any opening/closing
   combination) is removed.
8. `\s*\R\s*` (/u) is replaced by one space.
9. `\s{2,}` (/u) is replaced by one space; then trim.

Vectors: `clean` (38 cases, including the traps: NBSP runs collapse but a
single NBSP at the edge survives the ASCII trim; `„a“ und „b“` loses only the
outer quotes).

### 8.3 KEINE_ANTWORT

If the cleaned text contains `KEINE_ANTWORT` ("no answer"), case-insensitive,
anywhere, the result is exactly `KEINE_ANTWORT` - delivered as a success, no
number check, no retry. It is the agreed word for "the sources do not answer
this" and leads to a hand-over to a human.

### 8.4 Number check

Every digit sequence of the answer must occur in `fakten`:

```
digits(s):
    s = replace( /(\d)[ .,\x{00A0}\x{202F}\x{2009}](?=\d\d\d\b)/u  ->  "$1" )   # join thousands groups
    return all matches of /[0-9]+/ (ASCII digits), in order

invented = first d in digits(answer) that is not in set(digits(fakten)), else none
```

Comparison is on the digit strings (`09` is not `9`). Separators are space,
dot, comma, NBSP (U+00A0), narrow NBSP (U+202F) and thin space (U+2009).
Vectors: `numbers`.

### 8.5 One retry

If the cleaned text is empty or contains an invented number, the job is sent
to the model **once more**, with exactly this suffix appended to the prompt
(German, byte for byte; `\n` = line feed):

```
\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, die nicht in den Quellen steht. Uebernimm Zahlen genau so, wie sie dort stehen, oder lass sie weg.
```

(It is in `vectors.json` as `retry_suffix`.) The retry uses the same system
prompt, images and `max_tokens`. If the second attempt also fails the check,
the job fails with `grund` `leer nach dem Saeubern` ("empty after clean-up")
or `erfundene Zahl: <digits>` of the second attempt. `ms` adds both attempts.

## 9. Processing an embedding job

If the node has no embedding server configured the job fails with
`kein Einbettungsserver`; if `texte` is empty, with `Einbettung ohne Texte`.

Request: `POST {embed_url}` (OpenAI style `/v1/embeddings`), header
`Content-Type: application/json`, timeout `embed_timeout`:

```json
{"model": "<embed_model>", "input": ["first text", "second text"]}
```

The result string (the `text` of `bring`) is built like this:

1. Take `data` of the response, sort by `index` (missing index = 0; stable).
2. Every `embedding` must be non-empty and all must have the same length.
3. Each vector: every value as IEEE-754 float32 little-endian, concatenated,
   standard base64 with padding.
4. The number of vectors must equal the number of texts.
5. `text = JSON({"vektoren": [<base64>, ...], "dims": <length>, "modell": "<embed_model>"})`
   - keys in this order, no spaces, `/` not escaped, non-ASCII characters
   escaped as `\uXXXX`.

`vektoren` = vectors, `dims` = dimensions, `modell` = the label of the vector
space. Keep `embed_model` unchanged as long as the same model computes; a
different label is a different vector space.

Errors (`grund`): `Einbettungsserver nicht erreichbar: <error>`,
`Einbettung HTTP <status>: <first 160 characters of the body>`,
`Einbettung unlesbar` (no `data` array), `Vektor leer oder ungleich lang`,
`<k> Vektoren fuer <n> Texte`. Embedding jobs are never streamed, never
cleaned, never number-checked, never retried. Vectors: `embed_result`.

## 10. Streaming

A chat job streams only if the job has `strom`, the node's `stream` setting is
on (default) and streaming was not switched off by a 400/404 on `teil`. Each
attempt (also the retry) decides this anew and starts with empty text.

### 10.1 Reading SSE

The model request gets `"stream": true`. The response bytes are split into
lines at `\n` (a line may span several network chunks, a chunk may end inside
a UTF-8 sequence - buffer bytes, not characters); a trailing `\r` is removed;
bytes left after the last `\n` form a last line at the end. Per line:

* Lines not starting with `data:` are ignored (comments, `event:`, `id:`,
  indented lines).
* A `data:` line marks the response as SSE. Payload = the rest after
  `data:`, trimmed.
* `[DONE]` sets "ended".
* Otherwise the payload is JSON; unparseable payloads are ignored.
  * `{"error": ...}` or `{"object": "error", ...}`: stream error, message =
    `error.message` (or `message`, or the error string).
  * `choices[0].delta.content`, if a string (also `""`), is appended and
    marks "has content".
  * a non-empty `choices[0].finish_reason` sets "ended".

At the end: stream error -> `Modell-Strom: <first 160 characters>`; no
content -> `Antwort ohne Text`; not ended -> `Strom ohne Abschluss`; otherwise
the accumulated text is the answer (then clean-up, check, retry as in
[section 8](#8-processing-a-chat-job)). If the server answered without any
`data:` line (it ignored `stream`), the body is read as a normal JSON
completion. Vectors: `sse` (byte streams as base64 chunks).

### 10.2 Cut and send parts

While the model writes, the node sends parts:

* **Cut** (`stream_cut` vectors): the text up to and including the last
  space, `\n`, `\r` or `\t` - never half a word, never half a number. A space
  that follows a digit and is followed by a digit or by nothing may be a
  thousands separator (`1 000`) and is skipped as a cut point. No whitespace:
  nothing to send. Work on bytes/code units; only ASCII characters are cut
  points.
* A part is sent only if the cut text is **longer** than the last part sent
  for that job in the current attempt.
* Per job at most one part every `stream_ms` milliseconds (minimum 100,
  default 400).
* **One `teil` request in flight at a time** for the whole process; it bundles
  up to 8 due jobs. A slow server slows the parts, never the answers.
* If the cut text exceeds 16000 bytes, no more parts for that job.
* `n` counts per job from 1, +1 per part sent, continuing across the retry.
* `weiter: false` stops parts for that job; 400/404 stops streaming entirely
  (see [section 6](#6-teil---partial-text-while-streaming)).
* The final result is delivered with `bring` as always.

## 11. Main loop, concurrency, heartbeat, backoff, shutdown

A node has `concurrency` slots (default 1). A slot is a job in progress.

1. **Model readiness.** Before fetching while idle, check the model:
   `GET {model_endpoint}/models` must answer 200 (with the API key header).
   With `chat_url` the model counts as ready. A process that only fetches
   `einbettung` checks the embedding server instead (an embedding request
   with input `["Bereit"]` must answer 200) and does not need the chat
   model; a process that fetches both checks both. Not ready: log, wait
   10 s, try again (a one-shot run exits with 1).
2. **Fetch.** With free slots and no fetch open:
   `hol` with `n = free slots` (never more than `concurrency`),
   `warte = poll_wait` (0..60), `arten`, `kann`, `bilder=1` if images. One
   `hol` at a time; it runs in parallel to model calls, deliveries and parts.
3. **Process** each job ([8](#8-processing-a-chat-job) / [9](#9-processing-an-embedding-job)),
   several at once.
4. **Deliver** finished results with `bring` as soon as possible, bundled
   (one `bring` at a time).
5. **Heartbeat.** If all slots are busy, no `hol` is open and the last `hol`
   started 45 s ago or more, send `hol` with `n=0&warte=0&kann=<kinds>`
   (no `arten`); the answer is ignored. Without it the server considers a
   busy node dead.
6. **Backoff.** A `hol` that fails (network error, status other than 200, or
   no `auftraege` in the answer) pauses fetching for
   `min(300, 5 * consecutive_failures)` seconds; a successful `hol` resets the
   counter. Failed `bring`/`teil` do not count.
7. **Shutdown** (SIGTERM/SIGINT, service stop): start no new `hol`, finish
   the running jobs, deliver them, exit 0.

A probe (`--probe`) sends `hol` with `n=0&warte=0&arten=...&kann=...`, one
test completion (system `Antworte mit genau einem Wort.`, prompt
`Sag: Bereit`, `max_tokens` 20, no streaming) and, with an embedding server,
one test embedding (`["Bereit"]`). It takes no job.

## 12. Failure reasons (`grund`)

Sent by the node in `bring` (German, verbatim - dashboards know them):

| `grund` | cause |
|---|---|
| `Auftrag ohne Text` | chat job with empty `prompt` |
| `Modell nicht erreichbar: <error>` | connection error or timeout at the model |
| `Modell HTTP <status>: <body, 160 chars>` | model answered with an error status |
| `Modell-Strom: <message, 160 chars>` | error event inside the SSE stream |
| `Antwort ohne Text` | no content in the answer |
| `Strom ohne Abschluss` | stream ended without `[DONE]`/`finish_reason` |
| `leer nach dem Saeubern` | empty after clean-up, also after the retry |
| `erfundene Zahl: <digits>` | invented number, also after the retry |
| `kein Einbettungsserver` | embedding job, but no embedding server |
| `Einbettung ohne Texte` | embedding job without `texte` |
| `Einbettungsserver nicht erreichbar: <error>` | connection error at the embedding server |
| `Einbettung HTTP <status>: <body, 160 chars>` | embedding server error status |
| `Einbettung unlesbar` | embedding response without `data` |
| `Vektor leer oder ungleich lang` | empty vector or differing lengths |
| `<k> Vektoren fuer <n> Texte` | wrong number of vectors |

"160 chars" means characters (not bytes) of the raw response body. The text
after a colon for connection errors is implementation specific.

## 13. Versioning

* The signature scheme is versioned by its prefix `RC-KI-v2`. A future scheme
  gets a new prefix; the server accepts old and new side by side during a
  transition.
* Actions and fields are only ever **added**. Nodes ignore unknown fields in
  responses and jobs; the server ignores unknown fields in requests.
* New behaviour is opt-in per request: `bilder=1` (images), `kann`
  (capabilities), `strom` in a job (streaming, and 400/404 on `teil` from an
  older server switches it off).
* Nodes identify themselves with `User-Agent: rc-node-<lang>/<version>`.
  This document describes node version 2.0.0; the behaviour on the wire is
  identical to the original PHP node 1.3.
