#!/usr/bin/env node
/*
 * rc-node conformance runner.
 *
 *   node conformance/run.js --impl=<name> [--only=a,b] [--slow] [--verbose] [--keep] [--list] -- <cmd> [args...]
 *
 * For every case it starts, in-process and on 127.0.0.1 ephemeral ports only,
 *   (a) a mock reactive.chat endpoint (/v1/ki: hol, bring, teil) that verifies
 *       signatures exactly like the real server (RC-KI-v2 HMAC, +-300 s window,
 *       every signature usable once, 401 otherwise), and
 *   (b) a mock OpenAI-compatible model server (/v1/models, /v1/chat/completions
 *       with and without SSE, /v1/embeddings, Azure-style deployment path),
 * writes a config file (CONTRACT.md keys), runs
 *   <cmd> [args...] --config=<file> <--probe|--once|--one|--daemon>
 * and asserts on what the mocks observed, the exit code and the output.
 *
 * Output: one line per case "PASS|FAIL|SKIP <case> <detail>", then
 *   impl=<name> pass=N fail=M skip=K
 * Exit 1 if any case failed. Node >= 18, standard library only.
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));
const RETRY_SUFFIX = VECTORS.retry_suffix;
const HINT_NO_IMAGE = '\n\n(Hinweis: Der Besucher hat ein Bild angehaengt, das du NICHT sehen kannst.'
    + ' Beschreibe es nicht und rate nicht, was darauf ist.)';
const KINDS = ['chat', 'uebersetzung', 'zusammenfassung', 'einbettung'];

// Tiny valid-looking images (the node only checks the data: URL shape).
const IMG_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const IMG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const IMG_WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const IMG_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function waitFor(cond, timeoutMs, stepMs = 25) {
    const end = now() + timeoutMs;
    while (now() < end) {
        if (cond()) { return true; }
        await sleep(stepMs);
    }
    return cond();
}

function phpInt(v, dflt) {
    if (v === null || v === undefined) { return dflt; }
    const m = /^\s*[+-]?\d+/.exec(String(v));
    return m ? parseInt(m[0], 10) : 0;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The server's number check (rc_ki_zahlen_pruefen); self-tested against vectors.numbers. */
function numbersCheck(text, facts) {
    const digits = (s) => {
        s = s.replace(/(\d)[ .,\u00A0\u202F\u2009](?=\d\d\d\b)/gu, '$1');
        return s.match(/\d+/g) || [];
    };
    const allowed = new Set(digits(facts));
    for (const z of digits(text)) { if (!allowed.has(z)) { return z; } }
    return null;
}

/** The result string einbettenLesen() builds, from vectors in index order. */
function embedResultString(vectors, model) {
    const vek = vectors.map((v) => {
        const b = Buffer.alloc(4 * v.length);
        v.forEach((x, i) => b.writeFloatLE(x, 4 * i));
        return b.toString('base64');
    });
    return JSON.stringify({ vektoren: vek, dims: vectors[0].length, modell: model })
        .replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function selfTest() {
    const errs = [];
    for (const c of VECTORS.numbers) {
        const got = numbersCheck(c.text, c.facts);
        if (got !== c.expected) { errs.push(`numbers/${c.name}: ${got} != ${c.expected}`); }
    }
    for (const c of VECTORS.embed_result) {
        if (c.expected_result === null) { continue; }
        const data = JSON.parse(c.body).data.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
        const got = embedResultString(data.map((e) => e.embedding), c.embed_model);
        if (got !== c.expected_result) { errs.push(`embed_result/${c.name}: ${got} != ${c.expected_result}`); }
    }
    return errs;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeServer(server) {
    return new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') { server.closeAllConnections(); }
        server.close(() => resolve());
        setTimeout(resolve, 500);
    });
}

function sendJson(res, status, obj, headers = {}) {
    if (res.destroyed || res.writableEnded) { return; }
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    try {
        res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': body.length, 'Cache-Control': 'no-store' }, headers));
        res.end(body);
    } catch (e) { /* client went away */ }
}

async function readBody(req) {
    const chunks = [];
    for await (const c of req) { chunks.push(c); }
    return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// mock reactive.chat (/v1/ki)
// ---------------------------------------------------------------------------
class RcMock {
    constructor(opt = {}) {
        this.secret = opt.secret;                       // what the server accepts
        this.basePath = opt.basePath || '';
        this.queue = [];                                // offered jobs
        this.running = new Map();                       // id -> job (handed out)
        this.finished = new Map();                      // id -> {state, text, grund}
        this.requests = [];
        this.results = [];                              // every bring entry
        this.parts = [];                                // every accepted-or-not teil entry
        this.teilCalls = [];
        this.usedSigs = new Set();
        this.holFail = opt.holFail || 0;
        this.teilMode = opt.teilMode || 'ok';           // ok | 404 | stop
        this.teilDelayMs = opt.teilDelayMs || 0;
        this.ignoreKinds = !!opt.ignoreKinds;
        this.forceImages = !!opt.forceImages;
        this.addJobsOnFirstHol = opt.addJobsOnFirstHol || null;
        this.teilInFlight = 0;
        this.teilMaxInFlight = 0;
        this.teilLastN = new Map();
        for (const j of opt.jobs || []) { this.queue.push(j); }
        const handler = (req, res) => {
            this.handle(req, res).catch((e) => { sendJson(res, 500, { fehler: 'mock: ' + e.message }); });
        };
        this.tlsErrors = [];                            // failed TLS handshakes (tls mode)
        this.sni = [];                                  // servername of every completed handshake
        if (opt.tls) {
            this.server = https.createServer({ key: opt.tls.key, cert: opt.tls.cert }, handler);
            this.server.on('secureConnection', (sock) => { this.sni.push(sock.servername || ''); });
            this.server.on('tlsClientError', (e) => { this.tlsErrors.push(e.code || e.message); });
        } else {
            this.server = http.createServer(handler);
        }
        this.server.keepAliveTimeout = 5000;
    }

    async start() { this.port = await listen(this.server); return this; }
    stop() { return closeServer(this.server); }
    req(action) { return this.requests.filter((r) => r.action === action); }

    rowFor(job, wantImages) {
        const row = { id: job.id, art: job.art || 'chat', system: job.system || '', prompt: job.prompt || '',
                      fakten: job.fakten || '' };
        if (job.max_tokens !== undefined) { row.max_tokens = job.max_tokens; }
        if (row.art === 'chat' && job.strom) { row.strom = 1; }
        if (row.art === 'einbettung') { row.texte = job.texte || []; row.zweck = job.zweck || 'frage'; }
        if (job.bilder) {
            if (wantImages || this.forceImages) { row.bilder = job.bilder; } else { row.prompt += HINT_NO_IMAGE; }
        }
        return row;
    }

    take(n, kinds, wantImages) {
        const out = [];
        for (let i = 0; i < this.queue.length && out.length < n;) {
            const j = this.queue[i];
            if (this.ignoreKinds || kinds.includes(j.art || 'chat')) {
                this.queue.splice(i, 1);
                this.running.set(j.id, j);
                out.push(this.rowFor(j, wantImages));
            } else { i++; }
        }
        return out;
    }

    async handle(req, res) {
        const body = await readBody(req);
        const url = req.url;
        const qi = url.indexOf('?');
        const p = qi < 0 ? url : url.slice(0, qi);
        const q = qi < 0 ? '' : url.slice(qi + 1);
        const params = new URLSearchParams(q);
        const rec = { t: now(), method: req.method, path: p, query: q, params: {}, headers: req.headers,
                      body: body.toString('utf8'), action: params.get('action') || '', status: 0,
                      sigOk: false, sigFail: '', violations: [] };
        for (const [k, v] of params) { rec.params[k] = v; }
        rec.sni = req.socket && req.socket.servername;
        this.requests.push(rec);
        let closed = false;
        res.on('close', () => { closed = true; });
        const reply = (status, obj, headers) => { rec.status = status; rec.tEnd = now(); sendJson(res, status, obj, headers); };

        // contract checks (reported, not enforced by the real server)
        if (!/^[0-9a-f]{16}$/.test(params.get('nonce') || '')) { rec.violations.push('nonce is not 16 lowercase hex chars'); }
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { rec.violations.push('Content-Type is not application/json'); }
        if (rec.action === 'hol' && (req.method !== 'GET' || body.length > 0)) { rec.violations.push('hol must be GET without body'); }
        if ((rec.action === 'bring' || rec.action === 'teil') && req.method !== 'POST') { rec.violations.push(rec.action + ' must be POST'); }

        if (p !== this.basePath + '/v1/ki') { return reply(404, { fehler: 'not found' }); }

        // signature exactly like KiKnoten.php (customer node: v2 only, strict replay protection)
        const knoten = (params.get('knoten') || '').trim();
        const ts = String(req.headers['x-rc-ki-ts'] || '');
        const sig = String(req.headers['x-rc-ki-sig'] || '');
        const text = Buffer.concat([Buffer.from('RC-KI-v2\n' + ts + '\n' + String(req.method).toUpperCase() + '\n'
                                                + p + '\n' + q + '\n', 'utf8'), body]);
        const want = crypto.createHmac('sha256', this.secret).update(text).digest('hex');
        const ok = /^[A-Za-z0-9._-]{1,64}$/.test(knoten) && knoten.startsWith('kn-') && ts !== ''
            && /^[0-9a-f]{64}$/.test(sig) && Math.abs(Math.floor(now() / 1000) - phpInt(ts, 0)) <= 300
            && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
        if (!ok) { rec.sigFail = 'rejected'; return reply(401, { fehler: 'Signatur abgelehnt' }); }
        if (this.usedSigs.has(sig)) { rec.sigFail = 'replay'; return reply(401, { fehler: 'Signatur schon verbraucht' }); }
        this.usedSigs.add(sig);
        rec.sigOk = true;

        if (!['hol', 'bring', 'teil'].includes(rec.action)) { return reply(400, { fehler: 'unbekannte action' }); }

        if (rec.action === 'hol') {
            const n = clamp(phpInt(params.get('n'), 1), 0, 20);
            const warte = clamp(phpInt(params.get('warte'), 0), 0, 60);
            let kinds = [];
            for (const a of String(params.get('arten') === null ? 'chat' : params.get('arten')).split(',')) {
                const t = a.trim();
                if (KINDS.includes(t) && !kinds.includes(t)) { kinds.push(t); }
            }
            if (kinds.length === 0) { kinds = ['chat']; }
            const wantImages = params.get('bilder') === '1';
            if (this.holFail > 0 && n > 0) {
                this.holFail--;
                return reply(500, { fehler: 'mock: simulated failure' });
            }
            if (n === 0) {
                const offen = this.queue.filter((j) => kinds.includes(j.art || 'chat')).length;
                return reply(200, { auftraege: [], offen });
            }
            if (this.addJobsOnFirstHol) {
                const a = this.addJobsOnFirstHol;
                this.addJobsOnFirstHol = null;
                setTimeout(() => { for (const j of a.jobs) { this.queue.push(j); } }, a.delayMs);
            }
            const end = now() + warte * 1000;
            for (;;) {
                const got = this.take(n, kinds, wantImages);
                if (got.length) { rec.handedOut = got.map((g) => g.id); return reply(200, { auftraege: got }); }
                if (now() >= end || closed) { break; }
                await sleep(50);
            }
            return reply(200, { auftraege: [] });
        }

        let d = null;
        try { d = JSON.parse(rec.body); } catch (e) { d = null; }

        if (rec.action === 'bring') {
            if (!d || typeof d !== 'object' || !Array.isArray(d.ergebnisse)) { return reply(400, { fehler: 'ergebnisse fehlen' }); }
            if (d.ergebnisse.length > 100) { return reply(413, { fehler: 'zu viele Ergebnisse in einer Lieferung', deckel: 100 }); }
            const answer = [];
            for (const e of d.ergebnisse) {
                const id = phpInt(e && e.id, 0);
                const txt = String((e && e.text) ?? '').trim();
                const grund = String((e && e.grund) ?? '').trim();
                this.results.push({ t: now(), id, raw: e, text: txt, grund });
                const job = this.running.get(id);
                if (!job) {
                    const f = this.finished.get(id);
                    answer.push({ id, angenommen: false, grund: f ? 'nicht mehr offen (' + f.state + ')' : 'unbekannt' });
                    continue;
                }
                this.running.delete(id);
                if (txt === '') {
                    this.finished.set(id, { state: 'abgewiesen', text: '', grund: grund || 'Knoten ohne Ergebnis' });
                    answer.push({ id, angenommen: false, grund: 'als gescheitert vermerkt' });
                    continue;
                }
                if ((job.art || 'chat') !== 'einbettung' && !/KEINE_ANTWORT/i.test(txt)) {
                    const bad = numbersCheck(txt, job.fakten || '');
                    if (bad !== null) {
                        this.finished.set(id, { state: 'abgewiesen', text: '', grund: 'erfundene Zahl: ' + bad });
                        answer.push({ id, angenommen: false, grund: 'erfundene Zahl: ' + bad });
                        continue;
                    }
                }
                this.finished.set(id, { state: 'fertig', text: txt, grund: '' });
                answer.push({ id, angenommen: true, grund: '' });
            }
            return reply(200, { ergebnisse: answer });
        }

        // teil
        this.teilInFlight++;
        this.teilMaxInFlight = Math.max(this.teilMaxInFlight, this.teilInFlight);
        const call = { t: now(), entries: [], status: 0 };
        this.teilCalls.push(call);
        try {
            if (this.teilDelayMs) { await sleep(this.teilDelayMs); }
            if (this.teilMode === '404') { call.status = 404; return reply(404, { fehler: 'unbekannte action' }); }
            if (!d || typeof d !== 'object' || !Array.isArray(d.teile)) { call.status = 400; return reply(400, { fehler: 'teile fehlen' }); }
            if (d.teile.length > 8) { call.status = 413; return reply(413, { fehler: 'zu viele Teile in einer Lieferung', deckel: 8 }); }
            const answer = [];
            for (const e of d.teile) {
                const id = phpInt(e && e.id, 0);
                const n = e ? e.n : undefined;
                const txt = e ? e.text : undefined;
                call.entries.push({ id, n, text: txt });
                const part = { t: rec.t, id, n, text: txt, ok: false };
                this.parts.push(part);
                const no = (grund, weiter = false) => { part.grund = grund; answer.push({ id, angenommen: false, weiter, grund }); };
                if (!Number.isInteger(n) || n < 1 || typeof txt !== 'string') { no('n oder text unzulaessig'); continue; }
                if ([...txt].length > 16000) { no('text ueber 16000 Zeichen'); continue; }
                const job = this.running.get(id);
                if (!job) { no(this.finished.has(id) ? 'nicht mehr offen (fertig)' : 'unbekannt'); continue; }
                if ((job.art || 'chat') !== 'chat') { no('kein chat-Auftrag'); continue; }
                if (!/KEINE_ANTWORT/i.test(txt)) {
                    const bad = numbersCheck(txt, job.fakten || '');
                    if (bad !== null) { no('erfundene Zahl: ' + bad); continue; }
                }
                const last = this.teilLastN.get(id) || 0;
                if (n <= last) { no('n nicht groesser als ' + last, true); continue; }
                this.teilLastN.set(id, n);
                if (this.teilMode === 'stop') { part.ok = true; answer.push({ id, angenommen: true, weiter: false, grund: '' }); continue; }
                part.ok = true;
                answer.push({ id, angenommen: true, weiter: true, grund: '' });
            }
            call.status = 200;
            return reply(200, { teile: answer });
        } finally {
            this.teilInFlight--;
        }
    }
}

// ---------------------------------------------------------------------------
// mock OpenAI-compatible model server
// ---------------------------------------------------------------------------
class ModelMock {
    /**
     * opt.reply(call, index) -> { status, body, content, delayMs, pieces: [{text, delayMs}] }
     * opt.modelsStatus (200), opt.embedStatus(input) -> status (200)
     */
    constructor(opt = {}) {
        this.opt = opt;
        this.calls = [];
        this.modelsCalls = [];
        this.embedCalls = [];
        this.other = [];
        this.inFlight = 0;
        this.maxInFlight = 0;
        this.server = http.createServer((req, res) => {
            this.handle(req, res).catch((e) => { sendJson(res, 500, { error: { message: 'mock: ' + e.message } }); });
        });
    }

    async start() { this.port = await listen(this.server); this.base = `http://127.0.0.1:${this.port}/v1`; return this; }
    stop() { return closeServer(this.server); }

    static vectorFor(i, text) { return [0.5 * (i + 1), -0.25 * [...text].length, 0.1]; }

    async handle(req, res) {
        const body = await readBody(req);
        const url = req.url;
        const qi = url.indexOf('?');
        const p = qi < 0 ? url : url.slice(0, qi);
        const q = qi < 0 ? '' : url.slice(qi + 1);
        let json = null;
        try { json = body.length ? JSON.parse(body.toString('utf8')) : null; } catch (e) { json = null; }
        const rec = { t: now(), method: req.method, path: p, query: q, headers: req.headers, raw: body.toString('utf8'), body: json };
        let closed = false;
        res.on('close', () => { closed = true; });

        if (req.method === 'GET' && p === '/v1/models') {
            this.modelsCalls.push(rec);
            const st = this.opt.modelsStatus || 200;
            return sendJson(res, st, st === 200 ? { object: 'list', data: [{ id: 'test-model', object: 'model' }] }
                                                : { error: { message: 'mock: not ready' } });
        }
        if (req.method === 'POST' && p === '/v1/embeddings') {
            this.embedCalls.push(rec);
            const input = json && Array.isArray(json.input) ? json.input : [];
            const st = this.opt.embedStatus ? this.opt.embedStatus(input) : 200;
            if (st !== 200) { return sendJson(res, st, { error: { message: 'mock embed failure' } }); }
            const data = input.map((t, i) => ({ object: 'embedding', index: i, embedding: ModelMock.vectorFor(i, String(t)) }));
            data.reverse();   // servers may reorder; the node must sort by index
            return sendJson(res, 200, { object: 'list', data, model: json && json.model, usage: { prompt_tokens: 1, total_tokens: 1 } });
        }
        if (req.method === 'POST' && (p === '/v1/chat/completions' || /^\/openai\/deployments\/[^/]+\/chat\/completions$/.test(p))) {
            const idx = this.calls.length;
            this.calls.push(rec);
            this.inFlight++;
            this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
            try {
                const spec = (this.opt.reply ? this.opt.reply(rec, idx) : null) || { content: 'Bereit' };
                const pieces = spec.pieces || [{ text: spec.content !== undefined ? spec.content : '', delayMs: 0 }];
                rec.fullText = pieces.map((x) => x.text).join('');
                if (spec.delayMs) { await sleep(spec.delayMs); }
                if (closed) { return; }
                if (spec.status && spec.status !== 200) {
                    res.writeHead(spec.status, { 'Content-Type': 'application/json' });
                    return res.end(spec.body !== undefined ? spec.body : JSON.stringify({ error: { message: 'mock failure' } }));
                }
                const id = 'chatcmpl-' + idx;
                if (json && json.stream === true) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                    const ev = (obj) => Buffer.from('data: ' + JSON.stringify(obj) + '\n\n', 'utf8');
                    const chunk = (delta, fin) => ({ id, object: 'chat.completion.chunk', created: 1, model: 'test-model',
                                                     choices: [{ index: 0, delta, finish_reason: fin }] });
                    res.write(ev(chunk({ role: 'assistant', content: '' }, null)));
                    for (const piece of pieces) {
                        if (piece.delayMs) { await sleep(piece.delayMs); }
                        if (closed) { return; }
                        const b = ev(chunk({ content: piece.text }, null));
                        // split every event in two writes, deliberately inside the line (and
                        // possibly inside a UTF-8 sequence) - the node must buffer until "\n"
                        const cut = Math.max(1, Math.floor(b.length / 2) + 1);
                        res.write(b.subarray(0, cut));
                        await sleep(5);
                        if (closed) { return; }
                        res.write(b.subarray(cut));
                    }
                    res.write(ev(chunk({}, 'stop')));
                    res.end('data: [DONE]\n\n');
                    return;
                }
                const total = pieces.reduce((a, x) => a + (x.delayMs || 0), 0);
                if (total) { await sleep(total); }
                if (closed) { return; }
                return sendJson(res, 200, { id, object: 'chat.completion', created: 1, model: 'test-model',
                    choices: [{ index: 0, message: { role: 'assistant', content: rec.fullText }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
            } finally {
                this.inFlight--;
                rec.tEnd = now();
            }
        }
        this.other.push(rec);
        return sendJson(res, 404, { error: { message: 'mock: unknown path ' + p } });
    }
}

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------
const SECRET = 'rcn_conformance_' + crypto.randomBytes(12).toString('hex');
const NODE_ID = 'kn-' + crypto.randomBytes(8).toString('hex');
const API_KEY = 'sk-conformance-' + crypto.randomBytes(8).toString('hex');

function job(id, extra = {}) {
    return Object.assign({ id, art: 'chat', system: 'Du bist der Assistent von Muster GmbH. #' + id,
                           prompt: 'Wann oeffnet ihr? (Frage ' + id + ')', fakten: 'Wir oeffnen um 9 Uhr.' }, extra);
}

function base(ctx, extra = {}) {
    return Object.assign({ base_url: ctx.rcUrl, node_id: NODE_ID, secret: SECRET, model: 'test-model',
                           model_endpoint: ctx.model.base, poll_wait: 1, timeout: 20, log_file: '' }, extra);
}

const fixed = (arr) => (call, i) => arr[Math.min(i, arr.length - 1)];
const words = (s, delayMs) => s.split(/(?<= )/).map((w) => ({ text: w, delayMs }));
const userContent = (call) => call.body && call.body.messages && call.body.messages[1] && call.body.messages[1].content;
const decodeParam = (v) => (v === undefined ? undefined : v);

function onlyResult(x, ctx) {
    x(ctx.rc.results.length === 1, `expected exactly 1 bring result, got ${ctx.rc.results.length}`);
    return ctx.rc.results[0] || { raw: {} };
}

/** JSON with sorted object keys - structural comparison independent of key order. */
function canon(v) {
    if (Array.isArray(v)) { return '[' + v.map(canon).join(',') + ']'; }
    if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
}

/** Model calls made for job <id> (job() puts "#<id>" at the end of the system prompt). */
function callsFor(ctx, id) {
    return ctx.model.calls.filter((c) => {
        const m = c.body && c.body.messages;
        return Array.isArray(m) && m[0] && typeof m[0].content === 'string' && m[0].content.endsWith('#' + id);
    });
}

/** n consecutive, whitespace cut, grown text, prefix of the attempt's text, timing. */
function checkParts(x, ctx, id, streamMs) {
    const parts = ctx.rc.parts.filter((p) => p.id === id);
    parts.forEach((p, i) => x(p.n === i + 1, `teil #${id}: entry ${i + 1} has n=${p.n}`));
    const calls = callsFor(ctx, id);
    let lastAttempt = -1; let lastLen = -1; let lastT = 0;
    for (const p of parts) {
        const txt = typeof p.text === 'string' ? p.text : '';
        // the latest attempt of this job, started before the part arrived, whose text the part prefixes
        let k = -1;
        calls.forEach((c, i) => { if (c.t <= p.t && (c.fullText || '').startsWith(txt)) { k = i; } });
        x(/[ \n\r\t]$/.test(txt), `teil #${id} n=${p.n} not cut at whitespace: ${JSON.stringify(txt)}`);
        // Thousands-separator rule (stromSchnitt): never cut between digit, space, DIGIT. A cut after
        // "49 " is correct when a non-digit follows ("49 Euro"), so judge by the next char of the model text.
        if (/[0-9] $/.test(txt) && k >= 0) {
            const next = (calls[k].fullText || "").charAt(txt.length);
            x(!/[0-9]/.test(next), `teil #${id} n=${p.n} cut inside a number (digit+space+digit): ${JSON.stringify(txt)}`);
        }
        x(k >= 0, `teil #${id} n=${p.n} is not a prefix of the model text: ${JSON.stringify(txt)}`);
        if (k === lastAttempt) {
            x(txt.length > lastLen, `teil #${id} n=${p.n} did not grow`);
            if (streamMs) { x(p.t - lastT >= streamMs * 0.75, `teil #${id} n=${p.n} only ${p.t - lastT} ms after the previous part (stream_ms ${streamMs})`); }
        }
        lastAttempt = k; lastLen = txt.length; lastT = p.t;
    }
    return parts;
}

const CASES = [];
const add = (c) => CASES.push(c);

// ---- probe -----------------------------------------------------------------
add({
    name: 'probe_ok', mode: 'probe',
    rc: { jobs: [job(101)] },
    model: { reply: fixed([{ content: 'Bereit' }]) },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const hols = ctx.rc.req('hol');
        x(hols.length === 1, `want exactly 1 hol, got ${hols.length}`);
        const p = (hols[0] || {}).params || {};
        x(p.n === '0' && p.warte === '0', `probe hol must use n=0&warte=0, got n=${p.n} warte=${p.warte}`);
        x(p.arten === 'chat' && p.kann === 'chat', `probe hol arten/kann: ${p.arten} / ${p.kann}`);
        x(ctx.rc.queue.length === 1 && ctx.rc.running.size === 0, 'probe must not take a job');
        x(ctx.rc.req('bring').length === 0, 'probe must not bring');
        x(ctx.model.calls.length === 1, `want 1 test completion, got ${ctx.model.calls.length}`);
        const b = (ctx.model.calls[0] || {}).body || {};
        x(b.model === 'test-model', `model ${b.model}`);
        x(b.stream !== true, 'probe completion must not stream');
        x(b.max_tokens === 20, `probe max_tokens ${b.max_tokens}, want 20`);
        x(canon(b.messages) === canon([{ role: 'system', content: 'Antworte mit genau einem Wort.' },
                                                          { role: 'user', content: 'Sag: Bereit' }]), 'probe messages differ');
        x(ctx.model.embedCalls.length === 0, 'no embed_url -> no embedding call');
    },
});
add({
    name: 'probe_401', mode: 'probe', allowSigFail: true,
    rc: { secret: 'rcn_a_different_secret' },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(r.code === 1, `exit ${r.code}, want 1`);
        x(ctx.rc.req('hol').length === 1 && ctx.rc.req('hol')[0].status === 401, 'want one hol answered 401');
    },
});
add({
    name: 'probe_model_down', mode: 'probe',
    config: (ctx) => base(ctx, { model_endpoint: `http://127.0.0.1:${ctx.closedPort}/v1` }),
    check(ctx, r, x) {
        x(r.code === 1, `exit ${r.code}, want 1`);
        x(ctx.rc.req('hol').length === 1, 'probe must still ask reactive.chat');
    },
});
add({
    name: 'probe_embed', mode: 'probe',
    config: (ctx) => base(ctx, { embed_url: ctx.model.base + '/embeddings', embed_model: 'bge-m3' }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const e = ctx.model.embedCalls;
        x(e.length === 1, `want 1 test embedding, got ${e.length}`);
        const b = (e[0] || {}).body || {};
        x(JSON.stringify(b.input) === '["Bereit"]' && b.model === 'bge-m3', `test embedding body ${JSON.stringify(b)}`);
    },
});

// ---- once / basic job flow --------------------------------------------------
add({
    name: 'once_empty', mode: 'once',
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const hols = ctx.rc.req('hol');
        x(hols.length === 1, `want exactly 1 hol, got ${hols.length}`);
        const p = (hols[0] || {}).params || {};
        x(p.n === '1' && p.warte === '1', `hol n=${p.n} warte=${p.warte}, want n=1 warte=1`);
        x(ctx.model.modelsCalls.length >= 1 && hols[0] && ctx.model.modelsCalls[0].t <= hols[0].t,
          'model readiness (GET /models) must happen before hol');
        x(ctx.rc.req('bring').length === 0, 'nothing to bring');
    },
});
add({
    name: 'once_chat', mode: 'once',
    rc: { jobs: [job(201)] },
    model: { reply: fixed([{ content: 'Hier ist die Antwort: **Wir oeffnen um 9 Uhr.**' }]) },
    config: (ctx) => base(ctx, { temperature: 0.3, max_tokens: 77 }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const h = ctx.rc.req('hol')[0] || { params: {} };
        x(h.params.n === '1' && h.params.warte === '1' && h.params.arten === 'chat' && h.params.kann === 'chat',
          `hol params ${h.query}`);
        x(h.params.bilder === undefined, 'bilder=1 only with images');
        x(ctx.model.calls.length === 1, `want 1 model call, got ${ctx.model.calls.length}`);
        const b = (ctx.model.calls[0] || {}).body || {};
        const j = job(201);
        x(b.model === 'test-model', `model ${b.model}`);
        x(b.stream !== true, 'job without strom must not stream');
        x(b.temperature === 0.3, `temperature ${b.temperature}`);
        x(b.max_tokens === 77, `max_tokens ${b.max_tokens}, want config value 77 (job names none)`);
        x(canon(b.messages) === canon([{ role: 'system', content: j.system }, { role: 'user', content: j.prompt }]),
          `messages ${JSON.stringify(b.messages)}`);
        const res = onlyResult(x, ctx);
        const keys = Object.keys(res.raw || {}).sort().join(',');
        x(keys === 'grund,id,knoten,modell,ms,text', `bring entry keys ${keys}`);
        x(res.raw.id === 201, `id ${JSON.stringify(res.raw.id)} (want number 201)`);
        x(res.raw.text === 'Wir oeffnen um 9 Uhr.', `text ${JSON.stringify(res.raw.text)}`);
        x(res.raw.grund === '', `grund ${JSON.stringify(res.raw.grund)}`);
        x(res.raw.modell === 'test-model' && res.raw.knoten === NODE_ID, 'modell/knoten');
        x(Number.isInteger(res.raw.ms) && res.raw.ms >= 0, `ms ${res.raw.ms}`);
        x((ctx.rc.finished.get(201) || {}).state === 'fertig', 'server did not accept the result');
    },
});
add({
    name: 'one_mode', mode: 'one',
    rc: { jobs: [job(211, { system: 'SYSMARKER-7731', prompt: 'PROMPTMARKER-4410' }), job(212)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { concurrency: 3 }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const h = ctx.rc.req('hol');
        x(h.length === 1 && h[0].params.n === '1', `--one must fetch exactly one slot (n=1), got ${h.map((q) => q.params.n)}`);
        x(ctx.model.calls.length === 1, `want 1 model call, got ${ctx.model.calls.length}`);
        x(r.stdout.includes('SYSMARKER-7731') && r.stdout.includes('PROMPTMARKER-4410'), '--one must print SYSTEM and PROMPT to stdout');
    },
});
add({
    name: 'concurrency_3', mode: 'once',
    rc: { addJobsOnFirstHol: { delayMs: 300, jobs: [job(301, { max_tokens: 123 }), job(302, { max_tokens: 123 }), job(303, { max_tokens: 123 })] } },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.', delayMs: 1500 }]) },
    config: (ctx) => base(ctx, { concurrency: 3, poll_wait: 5 }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const h = ctx.rc.req('hol')[0] || { params: {} };
        x(h.params.n === '3', `hol n=${h.params.n}, want 3`);
        x(ctx.model.calls.length === 3, `want 3 model calls, got ${ctx.model.calls.length}`);
        x(ctx.model.maxInFlight === 3, `model calls did not overlap (max in flight ${ctx.model.maxInFlight})`);
        x(ctx.model.calls.every((c) => c.body && c.body.max_tokens === 123), 'max_tokens from the job must be used');
        x([301, 302, 303].every((id) => (ctx.rc.finished.get(id) || {}).state === 'fertig'), 'all three results accepted');
    },
});
add({
    name: 'retry_invented_number_then_ok', mode: 'once',
    rc: { jobs: [job(401, { prompt: 'Was kostet es?', fakten: 'Der Preis ist 49 Euro.' })] },
    model: { reply: fixed([{ content: 'Es kostet 59 Euro.' }, { content: 'Antwort:\n„Es kostet   49 Euro.“' }]) },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        x(ctx.model.calls.length === 2, `want 2 model calls, got ${ctx.model.calls.length}`);
        x(userContent(ctx.model.calls[0] || {}) === 'Was kostet es?', 'first attempt must use the plain prompt');
        x(userContent(ctx.model.calls[1] || {}) === 'Was kostet es?' + RETRY_SUFFIX,
          `retry prompt must be prompt + exact German suffix, got ${JSON.stringify(userContent(ctx.model.calls[1] || {}))}`);
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'Es kostet 49 Euro.' && res.raw.grund === '', `result ${JSON.stringify(res.raw)}`);
    },
});
add({
    name: 'retry_invented_number_fails', mode: 'once',
    rc: { jobs: [job(402, { prompt: 'Was kostet es?', fakten: 'Der Preis ist 49 Euro.' })] },
    model: { reply: fixed([{ content: 'Es kostet 59 Euro.' }, { content: 'Es kostet 69 Euro.' }]) },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        x(ctx.model.calls.length === 2, `exactly one retry, got ${ctx.model.calls.length} calls`);
        const res = onlyResult(x, ctx);
        x(res.raw.text === '' && res.raw.grund === 'erfundene Zahl: 69', `result ${JSON.stringify(res.raw)}`);
    },
});
add({
    name: 'keine_antwort_passthrough', mode: 'once',
    rc: { jobs: [job(403, { fakten: 'nichts' })] },
    model: { reply: fixed([{ content: 'Seit 2019: keine_antwort, tut mir leid.' }]) },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(ctx.model.calls.length === 1, `KEINE_ANTWORT needs no retry, got ${ctx.model.calls.length} calls`);
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'KEINE_ANTWORT' && res.raw.grund === '', `result ${JSON.stringify(res.raw)}`);
    },
});
add({
    name: 'empty_after_clean', mode: 'once',
    rc: { jobs: [job(404)] },
    model: { reply: fixed([{ content: '<think>nur gedacht</think>' }]) },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(ctx.model.calls.length === 2, `empty text is retried once, got ${ctx.model.calls.length} calls`);
        const res = onlyResult(x, ctx);
        x(res.raw.text === '' && res.raw.grund === 'leer nach dem Saeubern', `result ${JSON.stringify(res.raw)}`);
    },
});
add({
    name: 'model_http_error', mode: 'once',
    rc: { jobs: [job(405)] },
    model: { reply: fixed([{ status: 500, body: 'boom ' + 'x'.repeat(300) }]) },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        x(ctx.model.calls.length === 1, `no retry on a model error, got ${ctx.model.calls.length} calls`);
        const res = onlyResult(x, ctx);
        const want = 'Modell HTTP 500: ' + ('boom ' + 'x'.repeat(300)).slice(0, 160);
        x(res.raw.text === '' && res.raw.grund === want, `grund ${JSON.stringify(res.raw.grund)}`);
    },
});
add({
    name: 'model_timeout', mode: 'once',
    rc: { jobs: [job(406)] },
    model: { reply: fixed([{ content: 'zu spaet', delayMs: 8000 }]) },
    config: (ctx) => base(ctx, { timeout: 2 }),
    check(ctx, r, x) {
        const res = onlyResult(x, ctx);
        x(res.raw.text === '' && String(res.raw.grund).startsWith('Modell nicht erreichbar: '),
          `grund ${JSON.stringify(res.raw.grund)} (want prefix "Modell nicht erreichbar: ")`);
        x(res.t - ctx.model.calls[0].t < 5000, `timeout 2 s not respected (${res.t - ctx.model.calls[0].t} ms)`);
    },
});
add({
    name: 'job_without_prompt', mode: 'once',
    rc: { jobs: [job(407, { prompt: '' })] },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(ctx.model.calls.length === 0, 'no model call for an empty prompt');
        const res = onlyResult(x, ctx);
        x(res.raw.text === '' && res.raw.grund === 'Auftrag ohne Text', `result ${JSON.stringify(res.raw)}`);
    },
});

// ---- embeddings -------------------------------------------------------------
add({
    name: 'embedding_job', mode: 'once',
    rc: { jobs: [{ id: 501, art: 'einbettung', system: '', prompt: '', fakten: '', texte: ['Erster Text', 'Zweiter'], zweck: 'crawl' }] },
    config: (ctx) => base(ctx, { kinds: ['embedding'], embed_url: ctx.model.base + '/embeddings', embed_model: 'bge-m3',
                                 model_endpoint: `http://127.0.0.1:${ctx.closedPort}/v1` }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const h = ctx.rc.req('hol')[0] || { params: {}, t: 0 };
        x(h.params.arten === 'einbettung' && h.params.kann === 'einbettung', `hol arten=${h.params.arten} kann=${h.params.kann}`);
        const e = ctx.model.embedCalls;
        x(e.length === 2, `want readiness + job embedding (2 calls), got ${e.length}`);
        x(e[0] && JSON.stringify(e[0].body.input) === '["Bereit"]' && e[0].t <= h.t, 'embed readiness check must precede hol');
        x(e[1] && canon(e[1].body) === canon({ model: 'bge-m3', input: ['Erster Text', 'Zweiter'] }),
          `job embedding body ${e[1] && e[1].raw}`);
        x(ctx.model.calls.length === 0 && ctx.model.modelsCalls.length === 0, 'embedding-only process must not touch the chat model');
        const res = onlyResult(x, ctx);
        const want = embedResultString([ModelMock.vectorFor(0, 'Erster Text'), ModelMock.vectorFor(1, 'Zweiter')], 'bge-m3');
        x(res.raw.text === want, `result text ${JSON.stringify(res.raw.text)} want ${JSON.stringify(want)}`);
        x(res.raw.grund === '', `grund ${res.raw.grund}`);
    },
});
add({
    name: 'embedding_without_embed_url', mode: 'once',
    rc: { ignoreKinds: true, jobs: [{ id: 502, art: 'einbettung', texte: ['a'], zweck: 'frage' }] },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        const res = onlyResult(x, ctx);
        x(res.raw.text === '' && res.raw.grund === 'kein Einbettungsserver', `result ${JSON.stringify(res.raw)}`);
        x(ctx.model.embedCalls.length === 0 && ctx.model.calls.length === 0, 'no model call');
    },
});
add({
    name: 'embedding_without_texts', mode: 'once',
    rc: { jobs: [{ id: 503, art: 'einbettung', texte: [], zweck: 'frage' }] },
    config: (ctx) => base(ctx, { kinds: ['chat', 'embedding'], embed_url: ctx.model.base + '/embeddings', embed_model: 'bge-m3' }),
    check(ctx, r, x) {
        const h = ctx.rc.req('hol')[0] || { params: {} };
        x(h.params.arten === 'chat,einbettung', `hol arten=${h.params.arten}`);
        const res = onlyResult(x, ctx);
        x(res.raw.text === '' && res.raw.grund === 'Einbettung ohne Texte', `result ${JSON.stringify(res.raw)}`);
    },
});
add({
    name: 'embedding_http_error', mode: 'once',
    rc: { jobs: [{ id: 504, art: 'einbettung', texte: ['x', 'y'], zweck: 'crawl' }] },
    model: { embedStatus: (input) => (JSON.stringify(input) === '["Bereit"]' ? 200 : 500) },
    config: (ctx) => base(ctx, { kinds: ['embedding'], embed_url: ctx.model.base + '/embeddings', embed_model: 'bge-m3' }),
    check(ctx, r, x) {
        const res = onlyResult(x, ctx);
        x(res.raw.text === '' && res.raw.grund === 'Einbettung HTTP 500: {"error":{"message":"mock embed failure"}}',
          `grund ${JSON.stringify(res.raw.grund)}`);
    },
});

// ---- images -----------------------------------------------------------------
add({
    name: 'images_on', mode: 'once',
    rc: { jobs: [job(601, { bilder: [IMG_JPEG, IMG_PNG] })] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { images: true, images_max: 1 }),
    check(ctx, r, x) {
        const h = ctx.rc.req('hol')[0] || { params: {} };
        x(h.params.bilder === '1', 'images=true must send bilder=1');
        const c = userContent(ctx.model.calls[0] || {});
        x(canon(c) === canon([{ type: 'text', text: job(601).prompt }, { type: 'image_url', image_url: { url: IMG_JPEG } }]),
          `user content ${JSON.stringify(c).slice(0, 200)}`);
    },
});
add({
    name: 'images_filter', mode: 'once',
    rc: { jobs: [job(602, { bilder: [IMG_GIF, IMG_PNG, 'data:image/png;base64,AA AA', 42, IMG_WEBP, IMG_JPEG] })] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { images: true, images_max: 2 }),
    check(ctx, r, x) {
        const c = userContent(ctx.model.calls[0] || {});
        x(canon(c) === canon([{ type: 'text', text: job(602).prompt },
                                                { type: 'image_url', image_url: { url: IMG_PNG } },
                                                { type: 'image_url', image_url: { url: IMG_WEBP } }]),
          `user content ${JSON.stringify(c).slice(0, 300)}`);
    },
});
add({
    name: 'images_off', mode: 'once',
    rc: { forceImages: true, jobs: [job(603, { bilder: [IMG_JPEG] })] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        const h = ctx.rc.req('hol')[0] || { params: {} };
        x(h.params.bilder === undefined, 'no bilder param without images');
        const c = userContent(ctx.model.calls[0] || {});
        x(c === job(603).prompt, `images=false must send the plain prompt string, got ${JSON.stringify(c).slice(0, 120)}`);
    },
});

// ---- streaming --------------------------------------------------------------
const STREAM_FACTS = 'Wir haben 1000 Plaetze und oeffnen am 3. Juni um 9 Uhr.';
add({
    name: 'stream_parts', mode: 'once',
    rc: { teilDelayMs: 120, jobs: [job(701, { strom: true, fakten: STREAM_FACTS })] },
    model: { reply: fixed([{ pieces: [
        { text: 'Wir ', delayMs: 150 }, { text: 'haben ', delayMs: 150 }, { text: '1', delayMs: 150 }, { text: ' ', delayMs: 150 },
        { text: '000 ', delayMs: 900 }, { text: 'Pl\u00e4tze ', delayMs: 150 }, { text: 'und ', delayMs: 150 },
        { text: '\u00f6ffnen\nam 3. ', delayMs: 150 }, { text: 'Juni ', delayMs: 150 }, { text: 'um 9 Uhr.', delayMs: 150 }] }]) },
    config: (ctx) => base(ctx, { stream: true, stream_ms: 300 }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const b = (ctx.model.calls[0] || {}).body || {};
        x(b.stream === true, 'strom job + stream config must request stream:true');
        const parts = checkParts(x, ctx, 701, 300);
        x(parts.length >= 2, `want >= 2 parts, got ${parts.length}`);
        x(ctx.rc.teilMaxInFlight <= 1, `more than one teil in flight (${ctx.rc.teilMaxInFlight})`);
        x(ctx.rc.teilCalls.every((c) => c.entries.length <= 8), 'teil with more than 8 entries');
        x(ctx.rc.req('teil').every((q) => q.method === 'POST' && q.sigOk), 'teil must be a signed POST');
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'Wir haben 1 000 Pl\u00e4tze und \u00f6ffnen am 3. Juni um 9 Uhr.', `final text ${JSON.stringify(res.raw.text)}`);
        const lastTeil = ctx.rc.teilCalls.length ? ctx.rc.teilCalls[ctx.rc.teilCalls.length - 1].t : 0;
        x(res.t >= lastTeil, 'bring must come after the parts');
    },
});
add({
    name: 'stream_weiter_false', mode: 'once',
    rc: { teilMode: 'stop', jobs: [job(702, { strom: true })] },
    model: { reply: fixed([{ pieces: words('Wir oeffnen morgen frueh um 9 Uhr und freuen uns auf Sie.', 120) }]) },
    config: (ctx) => base(ctx, { stream_ms: 150 }),
    check(ctx, r, x) {
        const parts = ctx.rc.parts.filter((p) => p.id === 702);
        x(parts.length === 1, `weiter:false must stop parts for the job, got ${parts.length} parts`);
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'Wir oeffnen morgen frueh um 9 Uhr und freuen uns auf Sie.', `final text ${JSON.stringify(res.raw.text)}`);
    },
});
add({
    name: 'stream_teil_404', mode: 'once',
    rc: { teilMode: '404', jobs: [job(703, { strom: true, fakten: 'Preis 49' })] },
    model: { reply: fixed([{ pieces: words('Der Preis ist heute leider 59.', 150) }, { pieces: words('Der Preis ist 49.', 50) }]) },
    config: (ctx) => base(ctx, { stream_ms: 150 }),
    check(ctx, r, x) {
        x(ctx.rc.req('teil').length === 1, `after 404 no more teil calls, got ${ctx.rc.req('teil').length}`);
        x(ctx.model.calls.length === 2, `want 2 model calls, got ${ctx.model.calls.length}`);
        x(((ctx.model.calls[1] || {}).body || {}).stream !== true, 'after teil 404 streaming is off (retry must not stream)');
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'Der Preis ist 49.', `final text ${JSON.stringify(res.raw.text)}`);
    },
});
add({
    name: 'stream_retry_n_continues', mode: 'once',
    rc: { jobs: [job(704, { strom: true, prompt: 'Was kostet es?', fakten: 'Preis 49 Euro' })] },
    model: { reply: fixed([{ pieces: words('Der Preis steht fest: 59.', 250) },
                           { pieces: words('Der Preis betraegt 49 Euro.', 250) }]) },
    config: (ctx) => base(ctx, { stream_ms: 200 }),
    check(ctx, r, x) {
        x(ctx.model.calls.length === 2, `want 2 model calls, got ${ctx.model.calls.length}`);
        const c1 = (ctx.model.calls[1] || {}).body || {};
        x(c1.stream === true, 'the retry streams too');
        x(userContent(ctx.model.calls[1] || {}) === 'Was kostet es?' + RETRY_SUFFIX, 'retry prompt suffix');
        const parts = checkParts(x, ctx, 704, 200);
        const t1 = (ctx.model.calls[1] || {}).t || Infinity;
        x(parts.some((p) => p.t < t1) && parts.some((p) => p.t >= t1), 'want parts in both attempts');
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'Der Preis betraegt 49 Euro.', `final text ${JSON.stringify(res.raw.text)}`);
    },
});
add({
    name: 'stream_many_jobs', mode: 'once',
    rc: { teilDelayMs: 100, jobs: Array.from({ length: 10 }, (_, i) => job(710 + i, { strom: true })) },
    model: { reply: () => ({ pieces: words('Wir oeffnen morgen frueh um 9 Uhr und freuen uns sehr.', 100) }) },
    config: (ctx) => base(ctx, { concurrency: 10, stream_ms: 100 }),
    check(ctx, r, x) {
        x(ctx.model.maxInFlight === 10, `want 10 parallel model calls, got ${ctx.model.maxInFlight}`);
        x(ctx.rc.teilCalls.length > 0, 'want teil calls');
        x(ctx.rc.teilCalls.every((c) => c.entries.length >= 1 && c.entries.length <= 8),
          `teil entries per call: ${ctx.rc.teilCalls.map((c) => c.entries.length)}`);
        x(ctx.rc.teilMaxInFlight <= 1, `more than one teil in flight (${ctx.rc.teilMaxInFlight})`);
        for (let i = 0; i < 10; i++) { checkParts(x, ctx, 710 + i, 0); }
        x(ctx.rc.results.length === 10 && ctx.rc.results.every((q) => q.grund === ''), 'all 10 results delivered');
    },
});
add({
    name: 'stream_config_off', mode: 'once',
    rc: { jobs: [job(705, { strom: true })] },
    model: { reply: fixed([{ pieces: words('Wir oeffnen um 9 Uhr.', 100) }]) },
    config: (ctx) => base(ctx, { stream: false }),
    check(ctx, r, x) {
        x(((ctx.model.calls[0] || {}).body || {}).stream !== true, 'stream=false must never stream');
        x(ctx.rc.req('teil').length === 0, 'no teil with stream=false');
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'Wir oeffnen um 9 Uhr.', `final text ${JSON.stringify(res.raw.text)}`);
    },
});

// ---- heartbeat / backoff / readiness ---------------------------------------
add({
    name: 'heartbeat', mode: 'once', slow: true, timeoutMs: 90000,
    rc: { jobs: [job(801)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.', delayMs: 50000 }]) },
    config: (ctx) => base(ctx, { concurrency: 1, timeout: 120 }),
    check(ctx, r, x) {
        const hols = ctx.rc.req('hol');
        x(hols.length === 2, `want fetch + one heartbeat hol, got ${hols.length}`);
        const hb = hols[1] || { params: {}, t: 0 };
        x(hb.params.n === '0' && hb.params.warte === '0' && hb.params.kann === 'chat', `heartbeat params ${hb.query}`);
        const gap = hb.t - (hols[0] || { t: 0 }).t;
        x(gap >= 44000 && gap <= 50000, `heartbeat ${gap} ms after the fetch, want ~45 s`);
        x(ctx.rc.results.length === 1, 'result delivered');
    },
});
add({
    name: 'backoff_after_failed_hol', mode: 'daemon', timeoutMs: 30000,
    rc: { holFail: 1 },
    config: (ctx) => base(ctx),
    async during(ctx, kill) {
        await waitFor(() => ctx.rc.req('hol').length >= 2, 20000);
        await sleep(200);
        kill('SIGTERM');
    },
    check(ctx, r, x) {
        const hols = ctx.rc.req('hol');
        x(hols.length >= 2, `want >= 2 hols, got ${hols.length}`);
        if (hols.length >= 2) {
            const gap = hols[1].t - hols[0].tEnd;
            x(gap >= 3900 && gap <= 7500, `second hol ${gap} ms after the failed one, want ~5 s`);
        }
        x(r.code === 0, `exit ${r.code} after SIGTERM, want 0`);
    },
});
add({
    name: 'model_not_ready', mode: 'once',
    rc: { jobs: [job(802)] },
    model: { modelsStatus: 503 },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        x(r.code === 1, `exit ${r.code}, want 1`);
        x(ctx.model.modelsCalls.length >= 1, 'readiness check GET /models expected');
        x(ctx.rc.req('hol').length === 0, 'must not fetch while the model is not ready');
    },
});
add({
    name: 'rc_unreachable', mode: 'once',
    config: (ctx) => base(ctx, { base_url: `http://127.0.0.1:${ctx.closedPort}` }),
    check(ctx, r, x) { x(r.code === 1, `exit ${r.code}, want 1 (connection error, nothing done)`); },
});
add({
    name: 'daemon_sigterm_finishes_job', mode: 'daemon', timeoutMs: 30000,
    rc: { jobs: [job(803)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.', delayMs: 2500 }]) },
    config: (ctx) => base(ctx, { concurrency: 2 }),
    async during(ctx, kill) {
        await waitFor(() => ctx.model.calls.length >= 1, 15000);
        await sleep(300);
        ctx.sigtermAt = now();
        kill('SIGTERM');
    },
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code} (signal ${r.signal}), want 0`);
        const res = onlyResult(x, ctx);
        x(res.raw.text === 'Wir oeffnen um 9 Uhr.', 'running job finished and delivered after SIGTERM');
        const late = ctx.rc.req('hol').filter((h) => h.t > (ctx.sigtermAt || Infinity) + 150);
        x(late.length === 0, `no new hol after SIGTERM, got ${late.length}`);
    },
});

// ---- model auth / urls / transport -------------------------------------------
add({
    name: 'model_key_bearer', mode: 'once',
    rc: { jobs: [job(901)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { model_api_key: API_KEY }),
    check(ctx, r, x) {
        const all = ctx.model.modelsCalls.concat(ctx.model.calls);
        x(all.length >= 2, 'want /models and a completion');
        x(all.every((c) => c.headers.authorization === 'Bearer ' + API_KEY), 'Authorization: Bearer <key> on every model request');
    },
});
add({
    name: 'azure_chat_url_api_key', mode: 'once',
    rc: { jobs: [job(902)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { model_endpoint: '', model: 'dep-one', model_api_key: API_KEY, model_key_header: 'api-key',
        chat_url: `http://127.0.0.1:${ctx.model.port}/openai/deployments/dep-one/chat/completions?api-version=2024-10-21` }),
    check(ctx, r, x) {
        const c = ctx.model.calls[0] || { headers: {} };
        x(c.path === '/openai/deployments/dep-one/chat/completions' && c.query === 'api-version=2024-10-21', `chat_url used verbatim: ${c.path}?${c.query}`);
        x(c.headers['api-key'] === API_KEY && c.headers.authorization === undefined, 'api-key header, no Authorization');
        x(ctx.model.modelsCalls.length === 0, 'with chat_url there is no /models readiness call');
        const res = onlyResult(x, ctx);
        x(res.raw.modell === 'dep-one' && res.raw.text === 'Wir oeffnen um 9 Uhr.', `result ${JSON.stringify(res.raw)}`);
    },
});
add({
    name: 'basic_auth', mode: 'once',
    rc: { jobs: [job(903)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { basic_auth: 'stage:pa:ss' }),
    check(ctx, r, x) {
        const want = 'Basic ' + Buffer.from('stage:pa:ss').toString('base64');
        x(ctx.rc.requests.length >= 2 && ctx.rc.requests.every((q) => q.headers.authorization === want), 'Basic auth on every reactive.chat request');
        x(ctx.model.calls.concat(ctx.model.modelsCalls).every((c) => !String(c.headers.authorization || '').startsWith('Basic')),
          'basic_auth must not go to the model server');
    },
});
add({
    name: 'resolve_fixed_address', mode: 'probe',
    config: (ctx) => base(ctx, { base_url: `http://rc-mock.invalid:${ctx.rc.port}`, resolve: `rc-mock.invalid:${ctx.rc.port}:127.0.0.1` }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0`);
        const h = ctx.rc.req('hol')[0] || { headers: {} };
        x(h.headers.host === `rc-mock.invalid:${ctx.rc.port}`, `Host header ${h.headers.host}`);
    },
});

// ---- TLS (throwaway CA generated at runtime with the openssl CLI) ------------
let PKI = null;
function pki() {
    if (PKI) { return PKI; }
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-conf-pki-'));
    process.on('exit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
    const o = (...a) => execFileSync('openssl', a, { cwd: d, stdio: ['ignore', 'ignore', 'pipe'] });
    const ca = (name) => {
        o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.crt', '-days', '2',
          '-subj', '/CN=rc-conformance ' + name, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    };
    const leaf = (caName, host, name) => {
        o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + host);
        fs.writeFileSync(path.join(d, name + '.ext'), `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
        o('x509', '-req', '-in', name + '.csr', '-CA', caName + '.crt', '-CAkey', caName + '.key', '-CAcreateserial',
          '-out', name + '.crt', '-days', '2', '-extfile', name + '.ext');
        return { key: fs.readFileSync(path.join(d, name + '.key')), cert: fs.readFileSync(path.join(d, name + '.crt')) };
    };
    ca('ca'); ca('ca-untrusted');
    const sys = fs.existsSync('/etc/ssl/certs/ca-certificates.crt') ? fs.readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8') : '';
    const bundle = path.join(d, 'bundle.crt');
    fs.writeFileSync(bundle, sys + '\n' + fs.readFileSync(path.join(d, 'ca.crt'), 'utf8'));
    // PHP's libcurl ignores SSL_CERT_FILE/CURL_CA_BUNDLE (it passes its compiled-in CA file); set curl.cainfo via an extra ini dir
    fs.mkdirSync(path.join(d, 'php-ini'));
    fs.writeFileSync(path.join(d, 'php-ini', 'rc-conformance-ca.ini'), 'curl.cainfo=' + bundle + '\nopenssl.cafile=' + bundle + '\n');
    PKI = { dir: d, caFile: path.join(d, 'ca.crt'), bundle,
            ok: leaf('ca', 'rc-mock.test', 'ok'), wrongName: leaf('ca', 'other.test', 'other'),
            untrusted: leaf('ca-untrusted', 'rc-mock.test', 'untrusted') };
    return PKI;
}
// trust the test CA in every runtime: OpenSSL (php/python/ruby/go/.NET), curl, requests, Node
function tlsTrustEnv() {
    const p = pki();
    // PHP_INI_SCAN_DIR: the empty element before ':' keeps the default conf.d, then ours is added
    return { NODE_EXTRA_CA_CERTS: p.caFile, SSL_CERT_FILE: p.bundle, CURL_CA_BUNDLE: p.bundle, REQUESTS_CA_BUNDLE: p.bundle,
             PHP_INI_SCAN_DIR: (process.env.PHP_INI_SCAN_DIR || '') + ':' + path.join(p.dir, 'php-ini') };
}
const TLS_ENV_KEYS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'PHP_INI_SCAN_DIR'];
const tlsCfg = (ctx, extra = {}) => base(ctx, Object.assign({ base_url: `https://rc-mock.test:${ctx.rc.port}`,
    resolve: `rc-mock.test:${ctx.rc.port}:127.0.0.1`, tls_verify: true }, extra));
function tlsWorks(x, ctx, r, id) {
    x(r.code === 0, `exit ${r.code}, want 0`);
    const res = onlyResult(x, ctx);
    x(String(res.raw.id) === String(id), `bring for job ${id}: ${JSON.stringify(res.raw)}`);
    x(res.raw.text === 'Wir oeffnen um 9 Uhr.', `delivered text ${JSON.stringify(res.raw.text)}`);
    x(ctx.rc.requests.length >= 2 && ctx.rc.requests.every((q) => q.headers.host === `rc-mock.test:${ctx.rc.port}`),
      `Host header must be rc-mock.test:${ctx.rc.port}, got ${[...new Set(ctx.rc.requests.map((q) => q.headers.host))].join(',')}`);
    x(ctx.rc.sni.length >= 1 && ctx.rc.sni.every((n) => n === 'rc-mock.test'), `TLS SNI must be rc-mock.test, got ${JSON.stringify(ctx.rc.sni)}`);
}
function tlsRefused(x, ctx, r) {
    x(r.code === 1, `exit ${r.code}, want 1 (certificate must be rejected)`);
    x(ctx.rc.requests.length === 0, `no request may reach the server over an unverified connection, got ${ctx.rc.requests.map((q) => q.action).join(',')}`);
}
add({
    name: 'tls_ok', mode: 'once',
    rc: () => ({ jobs: [job(1201)], tls: pki().ok }),
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    envDelete: TLS_ENV_KEYS, env: () => tlsTrustEnv(),
    config: (ctx) => tlsCfg(ctx),
    check(ctx, r, x) { tlsWorks(x, ctx, r, 1201); },
});
add({
    name: 'tls_untrusted', mode: 'probe',
    rc: () => ({ jobs: [job(1202)], tls: pki().untrusted }),
    model: { reply: fixed([{ content: 'Bereit' }]) },
    envDelete: TLS_ENV_KEYS, env: () => tlsTrustEnv(),
    config: (ctx) => tlsCfg(ctx),
    check(ctx, r, x) { tlsRefused(x, ctx, r); },
});
add({
    name: 'tls_verify_off', mode: 'once',
    rc: () => ({ jobs: [job(1203)], tls: pki().untrusted }),
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    envDelete: TLS_ENV_KEYS, env: () => tlsTrustEnv(),
    config: (ctx) => tlsCfg(ctx, { tls_verify: false }),
    check(ctx, r, x) { tlsWorks(x, ctx, r, 1203); },
});
add({
    name: 'tls_wrong_name', mode: 'probe',
    rc: () => ({ jobs: [job(1204)], tls: pki().wrongName }),
    model: { reply: fixed([{ content: 'Bereit' }]) },
    envDelete: TLS_ENV_KEYS, env: () => tlsTrustEnv(),
    config: (ctx) => tlsCfg(ctx),
    check(ctx, r, x) { tlsRefused(x, ctx, r); },
});

// ---- config / CLI -------------------------------------------------------------
add({
    name: 'kinds_aliases_and_capabilities', mode: 'once',
    config: (ctx) => base(ctx, { kinds: ['chat', 'translation', 'summary'], capabilities: ['chat', 'translation', 'summary', 'embedding'] }),
    check(ctx, r, x) {
        const h = ctx.rc.req('hol')[0] || { params: {} };
        x(h.params.arten === 'chat,uebersetzung,zusammenfassung', `arten=${h.params.arten}`);
        x(h.params.kann === 'chat,uebersetzung,zusammenfassung,einbettung', `kann=${h.params.kann}`);
    },
});
add({
    name: 'poll_wait_clamp', mode: 'once',
    rc: { jobs: [job(1001)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { poll_wait: 99 }),
    check(ctx, r, x) {
        const h = ctx.rc.req('hol')[0] || { params: {} };
        x(h.params.warte === '60', `warte=${h.params.warte}, want 60`);
    },
});
const cfgErr = (name, mk) => add({
    name, mode: 'once', config: mk,
    check(ctx, r, x) {
        x(r.code === 2, `exit ${r.code}, want 2`);
        x(r.stderr.trim().length > 0, 'one-line message on stderr expected');
        x(ctx.rc.requests.length === 0 && ctx.model.calls.length === 0 && ctx.model.modelsCalls.length === 0, 'no network traffic on a config error');
    },
});
cfgErr('config_missing_node_id', (ctx) => { const c = base(ctx); delete c.node_id; return c; });
cfgErr('config_node_id_without_kn', (ctx) => base(ctx, { node_id: 'node-0123456789abcdef' }));
cfgErr('config_embedding_without_embed_url', (ctx) => base(ctx, { kinds: ['embedding'] }));
cfgErr('config_missing_model_endpoint', (ctx) => { const c = base(ctx); delete c.model_endpoint; return c; });
cfgErr('config_invalid_json', () => '{"base_url": "http://127.0.0.1:1", ');
add({
    name: 'env_override', mode: 'probe',
    env: { RC_NODE_SECRET: SECRET, RC_NODE_MODEL_API_KEY: API_KEY },
    config: (ctx) => base(ctx, { secret: 'rcn_wrong_secret_in_file', model_api_key: 'sk-wrong-in-file' }),
    check(ctx, r, x) {
        x(r.code === 0, `exit ${r.code}, want 0 (RC_NODE_SECRET must override the file)`);
        x(ctx.model.calls.length === 1 && ctx.model.calls[0].headers.authorization === 'Bearer ' + API_KEY,
          'RC_NODE_MODEL_API_KEY must override the file');
    },
});
add({
    name: 'unknown_keys_ignored', mode: 'probe',
    config: (ctx) => base(ctx, { future_option: 1, nested: { a: [1, 2, { b: null }] }, kinds_v3: 'x', 'x-note': 'hello' }),
    check(ctx, r, x) { x(r.code === 0, `exit ${r.code}, want 0`); },
});
add({
    name: 'secret_not_logged', mode: 'once',
    rc: { jobs: [job(1101)] },
    model: { reply: fixed([{ content: 'Wir oeffnen um 9 Uhr.' }]) },
    config: (ctx) => base(ctx, { model_api_key: API_KEY, log_file: path.join(ctx.tmp, 'node.log') }),
    check(ctx, r, x) {
        let log = '';
        try { log = fs.readFileSync(path.join(ctx.tmp, 'node.log'), 'utf8'); } catch (e) { log = ''; }
        x(log.trim().length > 0, 'log_file must receive the log lines');
        const bad = log.split('\n').filter((l) => l !== '' && !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}/.test(l));
        x(bad.length === 0, `log lines must start with "YYYY-MM-DD HH:MM:SS  ": ${JSON.stringify(bad[0])}`);
        x(!log.includes(SECRET) && !log.includes(API_KEY), 'secret or model key in log_file');
    },
});
add({
    name: 'user_agent', mode: 'probe', skipFor: { reference: 'the reference predates CONTRACT.md (sends rc-knoten/1.3)' },
    config: (ctx) => base(ctx),
    check(ctx, r, x) {
        const ua = (ctx.rc.requests[0] || { headers: {} }).headers['user-agent'];
        x(/^rc-node-(php|node|python|ruby|dotnet|go)\/2\.0\.0$/.test(String(ua)), `User-Agent ${JSON.stringify(ua)}`);
    },
});

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const o = { impl: '', only: null, slow: false, verbose: false, keep: false, list: false, cmd: [] };
    const i = argv.indexOf('--');
    const own = i < 0 ? argv : argv.slice(0, i);
    o.cmd = i < 0 ? [] : argv.slice(i + 1);
    for (const a of own) {
        if (a.startsWith('--impl=')) { o.impl = a.slice(7); }
        else if (a.startsWith('--only=')) { o.only = a.slice(7).split(',').filter(Boolean); }
        else if (a === '--slow') { o.slow = true; }
        else if (a === '--verbose' || a === '-v') { o.verbose = true; }
        else if (a === '--keep') { o.keep = true; }
        else if (a === '--list') { o.list = true; }
        else { throw new Error('unknown option ' + a); }
    }
    return o;
}

async function runCase(c, opts) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-conf-'));
    const rc = new RcMock(Object.assign({ secret: SECRET }, typeof c.rc === 'function' ? c.rc() : (c.rc || {})));
    const model = new ModelMock(c.model || {});
    await rc.start();
    await model.start();
    const ctx = { tmp, rc, model, rcUrl: `http://127.0.0.1:${rc.port}`, closedPort: await freePort() };
    const failures = [];
    const x = (cond, msg) => { if (!cond) { failures.push(msg); } };
    let r = null;
    try {
        const cfg = c.config(ctx);
        const cfgPath = path.join(tmp, 'case-config.json');
        fs.writeFileSync(cfgPath, typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2));
        const flag = { probe: '--probe', once: '--once', one: '--one', daemon: '--daemon' }[c.mode];
        const env = Object.assign({}, process.env);
        delete env.RC_NODE_CONFIG; delete env.RC_NODE_SECRET; delete env.RC_NODE_MODEL_API_KEY;
        for (const k of c.envDelete || []) { delete env[k]; }
        Object.assign(env, typeof c.env === 'function' ? c.env(ctx) : (c.env || {}));
        r = await new Promise((resolve) => {
            const t0 = now();
            let out = ''; let err = ''; let done = false; let timedOut = false;
            const child = spawn(opts.cmd[0], opts.cmd.slice(1).concat([`--config=${cfgPath}`, flag]),
                                { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { err += d; });
            const kill = (sig) => { try { child.kill(sig); } catch (e) { /* gone */ } };
            const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, c.timeoutMs || 25000);
            child.on('error', (e) => { err += '\n[runner] spawn failed: ' + e.message; });
            child.on('close', (code, signal) => {
                if (done) { return; }
                done = true; clearTimeout(timer);
                resolve({ code, signal, stdout: out, stderr: err, elapsed: now() - t0, timedOut });
            });
            if (c.during) { c.during(ctx, kill).catch((e) => { err += '\n[runner] during: ' + e.message; }); }
        });
        x(!r.timedOut, `timed out after ${c.timeoutMs || 25000} ms`);
        await sleep(50);
        c.check(ctx, r, x);
        // checks that hold for every case
        const viol = [...new Set(rc.requests.flatMap((q) => q.violations))];
        x(viol.length === 0, 'protocol: ' + viol.join('; '));
        if (!c.allowSigFail) {
            const bad = rc.requests.filter((q) => !q.sigOk && q.status === 401);
            x(bad.length === 0, `signature rejected by the mock server (${bad.map((q) => q.action + ':' + q.sigFail).join(',')})`);
        }
        const all = r.stdout + r.stderr;
        x(!all.includes(SECRET), 'the secret appears in stdout/stderr');
        x(!all.includes(API_KEY), 'the model API key appears in stdout/stderr');
    } catch (e) {
        failures.push('runner error: ' + (e && e.stack || e));
    } finally {
        await rc.stop();
        await model.stop();
        if (!opts.keep) { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    return { failures, r, tmp };
}

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
    if (opts.list) { for (const c of CASES) { console.log(c.name + (c.slow ? ' (slow)' : '')); } return; }
    if (!opts.impl || opts.cmd.length === 0) {
        console.error('usage: node conformance/run.js --impl=<name> [--only=a,b] [--slow] [--verbose] [--keep] [--list] -- <cmd> [args...]');
        process.exit(2);
    }
    const st = selfTest();
    if (st.length) { console.error('runner self-test against vectors.json failed:\n' + st.join('\n')); process.exit(2); }
    if (opts.only) {
        const unknown = opts.only.filter((n) => !CASES.some((c) => c.name === n));
        if (unknown.length) { console.error('unknown case(s): ' + unknown.join(', ')); process.exit(2); }
    }
    let pass = 0; let fail = 0; let skip = 0;
    for (const c of CASES) {
        if (opts.only && !opts.only.includes(c.name)) { continue; }
        if (c.skipFor && c.skipFor[opts.impl]) { skip++; console.log(`SKIP ${c.name} ${c.skipFor[opts.impl]}`); continue; }
        if (c.slow && !opts.slow && !(opts.only && opts.only.includes(c.name))) { skip++; console.log(`SKIP ${c.name} slow (use --slow)`); continue; }
        const t0 = now();
        const { failures, r, tmp } = await runCase(c, opts);
        const secs = ((now() - t0) / 1000).toFixed(1) + 's';
        if (failures.length === 0) { pass++; console.log(`PASS ${c.name} ${secs}`); }
        else {
            fail++;
            console.log(`FAIL ${c.name} ${failures.join(' | ')}`);
            if (opts.verbose && r) {
                const ind = (s) => s.trimEnd().split('\n').map((l) => '    | ' + l).join('\n');
                console.log(`    exit=${r.code} signal=${r.signal} elapsed=${r.elapsed}ms` + (opts.keep ? ` tmp=${tmp}` : ''));
                if (r.stdout.trim()) { console.log('    stdout:\n' + ind(r.stdout)); }
                if (r.stderr.trim()) { console.log('    stderr:\n' + ind(r.stderr)); }
            }
        }
    }
    console.log(`impl=${opts.impl} pass=${pass} fail=${fail} skip=${skip}`);
    process.exit(fail ? 1 : 0);
}

main();
