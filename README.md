# reactive.chat AI node

Run the AI answers of your [reactive.chat](https://reactive.chat) workspace on
**your own language model** — on your own server, behind any
OpenAI-compatible interface (vLLM, Ollama, LM Studio, llama.cpp, Azure OpenAI).

The node calls reactive.chat, never the other way round: it needs **no public
address, no open port and no fixed IP** — only outbound HTTPS.

```
visitor ── chat ──▶ reactive.chat ◀── long-poll (signed) ── rc-node ──▶ your model server
                                   ◀── answer / stream ────┘
```

## Pick your language

All implementations are functionally identical, read the same
[`rc-node.json`](rc-node.example.json) and pass the same
[conformance suite](conformance/).

| Language | Directory | Runtime | Start |
|---|---|---|---|
| PHP | [`php/`](php/) | PHP ≥ 8.1 + curl | `php rc-node.php --probe` |
| Node.js | [`node/`](node/) | Node ≥ 18 | `node rc-node.js --probe` |
| Python | [`python/`](python/) | Python ≥ 3.9 | `python3 rc_node.py --probe` |
| Ruby | [`ruby/`](ruby/) | Ruby ≥ 3.0 | `ruby bin/rc-node --probe` |
| .NET (C#) | [`dotnet/`](dotnet/) | .NET 8 | `rc-node --probe` |
| Go | [`go/`](go/) | none (static binary) | `rc-node --probe` |

No third-party dependencies in any of them — standard library only.

## Quick start

1. In reactive.chat, open **Settings → Own AI node** (`/app/ai-node`) and
   create a node. ID and secret are shown **once**.
2. Copy `rc-node.example.json` to `rc-node.json`, fill in `node_id`, `secret`,
   `model_endpoint` and `model`, then `chmod 600 rc-node.json`.
3. `rc-node --probe` — checks both sides, takes no job.
4. `rc-node --daemon` — runs permanently (see the systemd example in each
   language directory).
5. In reactive.chat, switch the workspace mode to **Own node preferred** or
   **Own node only**.

Configuration reference: [CONTRACT.md](CONTRACT.md).
Wire protocol (to write your own node): [PROTOCOL.md](PROTOCOL.md).

## What the node gets — and what it does not

- Only jobs of **your** workspace. Every request is signed with your node's
  secret (HMAC-SHA256, valid once, five minutes — keep the clock in sync).
- For every answer it receives the visitor's question and the matching
  excerpts of your knowledge base. It never writes into a conversation
  itself: its answer is a proposal that reactive.chat checks (every number
  must appear in the sources) before the visitor sees it.
- Embeddings (vectors for knowledge search) only if you configure an
  embedding server and the workspace is on "own node only".
- Images attached by visitors only with `"images": true` and a vision model.

## Security

- Keep `rc-node.json` readable by the service user only (`chmod 600`); the
  secret can also come from the environment (`RC_NODE_SECRET`).
- Lost secret → revoke the node in reactive.chat and create a new one.
- Report vulnerabilities privately via the repository's **Security → Report a
  vulnerability** (GitHub private advisory) — please do not open a public issue.

## License

[MIT](LICENSE)
