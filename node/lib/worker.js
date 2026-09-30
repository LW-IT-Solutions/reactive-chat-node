'use strict';
/**
 * The node: fetch jobs from reactive.chat (long-poll), let the own model
 * answer them (several at once), deliver the results - plus --probe.
 *
 * Mirrors schleife() of reference/rc-knoten.php v1.3. The reference drives
 * curl_multi; here every transfer is a promise that pushes its completion
 * onto a queue and wakes the loop. Invariants kept from the reference:
 * at most one hol (or heartbeat), one bring and one teil in flight; up to
 * `concurrency` model calls at the same time.
 */
const php = require('./php');
const logic = require('./logic');
const transport = require('./transport');

const VERSION = '2.0.0';
const USER_AGENT = 'rc-node-node/' + VERSION;
const HEARTBEAT_S = 45;
const TEIL_MAX_ENTRIES = 8;
const TEIL_MAX_BYTES = 16000;

const nowS = () => Math.floor(Date.now() / 1000);
const nowF = () => Date.now() / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Node {
  constructor(cfg, logger, opts = {}) {
    this.cfg = cfg;
    this.log = logger;
    this.one = !!opts.one;
    this.out = opts.out || ((s) => process.stdout.write(s));
    this.keepGoing = true;
    this.streamOff = false;
    this.resolve = cfg.resolve ? require('./config').parseResolve(cfg.resolve) : null;
    this.wakeFn = null;
  }

  // -------------------------------------------------------------------------
  // The line to reactive.chat
  // -------------------------------------------------------------------------
  /** Builds and sends one signed request. extra = '&n=..' etc. body = string or null. */
  callRc(action, body, extra, timeoutS) {
    const c = this.cfg;
    const ts = String(nowS());
    const url = php.rtrim(c.base_url, '/') + '/v1/ki?action=' + action
      + '&knoten=' + php.rawurlencode(c.node_id) + (extra || '')
      + '&nonce=' + logic.nonce();
    const parts = transport.splitUrl(url);
    const method = body !== null && body !== undefined ? 'POST' : 'GET';
    const sig = logic.sign(c.secret, ts, method, parts ? parts.path : '/', parts ? parts.query : '', body);
    const headers = {
      Accept: '*/*',
      'X-RC-KI-TS': ts,
      'X-RC-KI-SIG': sig,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (c.basic_auth !== '') headers.Authorization = 'Basic ' + Buffer.from(c.basic_auth, 'utf8').toString('base64');
    return transport.request({
      url, method, headers, body: method === 'POST' ? body : null,
      timeoutMs: (timeoutS || 60) * 1000, connectTimeoutMs: 15000,
      resolve: this.resolve, tlsVerify: c.tls_verify,
    });
  }

  /** piLesen: {code, fehler, daten, roh}. */
  static readRc(r) {
    if (r.error !== '') return { code: 0, fehler: r.error, daten: null, roh: '' };
    const daten = php.jsonDecode(r.body);
    return { code: r.code, fehler: '', daten: php.isArr(daten) ? daten : null, roh: r.body.toString('utf8') };
  }

  // -------------------------------------------------------------------------
  // The line to the model (OpenAI style)
  // -------------------------------------------------------------------------
  modelUrl() {
    const c = this.cfg;
    if (c.chat_url !== '') return c.chat_url;
    return php.rtrim(c.model_endpoint, '/') + '/chat/completions';
  }

  modelHeaders() {
    const c = this.cfg;
    const h = { Accept: '*/*', 'Content-Type': 'application/json' };
    if (c.model_api_key !== '') {
      if (c.model_key_header.toLowerCase() === 'authorization') h.Authorization = 'Bearer ' + c.model_api_key;
      else h[c.model_key_header] = c.model_api_key;
    }
    return h;
  }

  callModel(system, prompt, maxTokens, images, stream) {
    return transport.request({
      url: this.modelUrl(), method: 'POST', headers: this.modelHeaders(),
      body: logic.modelBody(this.cfg, system, prompt, maxTokens, images, !!stream),
      timeoutMs: this.cfg.timeout * 1000, connectTimeoutMs: 10000,
      onData: stream ? (chunk) => { stream.feed(chunk); this.wake(); } : null,
    });
  }

  callEmbed(texts, timeoutS) {
    return transport.request({
      url: this.cfg.embed_url, method: 'POST', headers: { Accept: '*/*', 'Content-Type': 'application/json' },
      body: logic.embedBody(this.cfg.embed_model, texts),
      timeoutMs: (timeoutS || this.cfg.embed_timeout) * 1000, connectTimeoutMs: 5000,
    });
  }

  async embedReady() {
    const r = await this.callEmbed(['Bereit'], 30);
    return r.error === '' && r.code === 200;
  }

  /** Is the model there? With chat_url (Azure) there is no /models - it counts as there. */
  async modelReady() {
    const c = this.cfg;
    // Who only embeds does not need the language model - and vice versa.
    if (c.kinds.includes('einbettung') && !(await this.embedReady())) return false;
    if (c.kinds.every((k) => k === 'einbettung')) return true;
    if (c.chat_url !== '') return true;
    const r = await transport.request({
      url: php.rtrim(c.model_endpoint, '/') + '/models', method: 'GET', headers: this.modelHeaders(),
      body: null, timeoutMs: 5000, connectTimeoutMs: 3000,
    });
    return r.error === '' && r.code === 200;
  }

  // -------------------------------------------------------------------------
  // --probe: look at both sides, take nothing (n=0)
  // -------------------------------------------------------------------------
  async probe() {
    const c = this.cfg;
    const say = (s) => this.log.say(s);
    say('Probe, rc-node-node ' + VERSION + '.');
    say('  reactive.chat: ' + c.base_url);
    const a = Node.readRc(await this.callRc('hol', null, '&n=0&warte=0&arten='
      + php.rawurlencode(c.kinds.join(',')) + '&kann=' + php.rawurlencode(c.can.join(',')), 20));
    if (a.code === 200 && a.daten !== null) {
      say('    HTTP 200 - signed in, ' + php.toInt(php.pick(a.daten, 'offen', 0)) + ' job(s) waiting.');
    } else if (a.code === 401) {
      say('    HTTP 401 - rejected. Are node_id and secret right? Is the clock right (NTP)?'
        + ' Has the node been revoked in the customer area?');
    } else if (a.code === 200) {
      say('    HTTP 200, but the answer is not JSON: ' + php.mbSubstr(a.roh, 200));
    } else {
      say('    No connection: ' + (a.fehler !== '' ? a.fehler : 'HTTP ' + a.code + ' ' + php.mbSubstr(a.roh, 200)));
    }

    say('  Model: ' + this.modelUrl() + ' (' + c.model + ')');
    const t0 = nowF();
    const r = await this.callModel('Antworte mit genau einem Wort.', 'Sag: Bereit', 20, [], null);
    const m = logic.readModel(r.error ? 0 : r.code, r.body, r.error, Math.round((nowF() - t0) * 1000), null);
    say(m.text === null ? '    ' + englishReason(m.fehler)
      : '    Answer in ' + m.ms + ' ms: ' + logic.clean(m.text));

    if (c.embed_url !== '') {
      say('  Embeddings: ' + c.embed_url + ' (' + c.embed_model + ')');
      const e0 = nowF();
      const er = await this.callEmbed(['Bereit']);
      const [payload, err] = logic.readEmbedding(er.error ? 0 : er.code, er.body, er.error, 1, c.embed_model);
      say(payload === null ? '    ' + englishReason(err)
        : '    ' + php.toInt(php.pick(JSON.parse(payload), 'dims', 0)) + ' dimensions in '
          + Math.round((nowF() - e0) * 1000) + ' ms');
    }
    say('  Node: ' + c.node_id + ', fetches: ' + c.kinds.join(', ') + ', can: ' + c.can.join(', ')
      + ', images: ' + (c.images ? 'yes (at most ' + c.images_max + ')' : 'no'));
    const ok = a.code === 200 && m.text !== null;
    say(ok ? 'Probe OK.' : 'Probe FAILED.');
    return ok ? 0 : 1;
  }

  // -------------------------------------------------------------------------
  // The loop: fetch, let the model work, deliver - several at once
  // -------------------------------------------------------------------------
  wake() {
    const f = this.wakeFn;
    if (f) { this.wakeFn = null; f(); }
  }

  waitWake(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wakeFn = null; resolve(); }, ms);
      this.wakeFn = () => { clearTimeout(t); resolve(); };
    });
  }

  stop(reason) {
    if (this.keepGoing) this.log.say(reason + ' - stopping after the running jobs.');
    this.keepGoing = false;
    this.wake();
  }

  /** once=true: one fetch cycle. Returns the number of finished jobs, -1 = connection error and nothing done. */
  async loop(once) {
    const c = this.cfg;
    const say = (s) => this.log.say(s);
    const slots = this.one ? 1 : Math.max(1, c.concurrency);
    const waitS = Math.max(0, Math.min(60, c.poll_wait));
    const holTimeout = waitS + 20;
    const kindsQ = php.rawurlencode(c.kinds.join(',')) + '&kann=' + php.rawurlencode(c.can.join(','))
      // Only who can do images says so to reactive.chat.
      + (c.images ? '&bilder=1' : '');
    const canQ = php.rawurlencode(c.can.join(','));
    const streamMs = Math.max(100, c.stream_ms);

    const running = new Map(); // id -> job (insertion order like the PHP array)
    let done = [];             // finished results waiting for bring
    let inBring = [];
    const events = [];
    let active = 0;
    let holOpen = false;
    let bringOpen = false;
    let teilOpen = false;
    let fetchedOnce = false;
    let finishedCount = 0;
    let lineError = false;
    let failures = 0;
    let quietUntil = 0;
    let lastCall = nowS();
    let modelWaits = 0;

    const launch = (z, promise) => {
      active++;
      promise.then((r) => {
        active--;
        events.push({ z, r });
        this.wake();
      });
    };

    const startModel = (id) => {
      const j = running.get(id);
      const prompt = j.attempt === 1 ? j.prompt : j.prompt + logic.RETRY_SUFFIX;
      // Stream only with 'strom' in the job AND in the config, and not after
      // reactive.chat refused 'teil'. Every attempt starts with empty text.
      const zs = (j.stream && c.stream && !this.streamOff) ? new logic.StreamState() : null;
      j.zs = zs;
      j.teilText = '';
      launch({ what: 'model', id, t0: nowF(), stream: zs },
        this.callModel(j.system, prompt, j.max_tokens, j.images, zs));
    };

    const finishJob = (id, sentence, reason) => {
      const j = running.get(id);
      running.delete(id);
      finishedCount++;
      say('  #' + id + (sentence === '' ? ' discarded: ' + reason
        : ' ' + j.ms + ' ms: ' + (j.art === 'einbettung'
          ? j.texts.length + ' text(s) embedded'
          : php.mbSubstr(sentence, 100)))
        + (j.stream ? '  parts ' + j.teilN + (j.teilGo ? '' : ' (stopped)') : '')
        + '  [' + running.size + '/' + slots + ']');
      // Failures are delivered too: someone is waiting in the chat.
      done.push({ id, text: sentence, grund: sentence === '' ? reason : '', modell: c.model, ms: j.ms, knoten: c.node_id });
    };

    for (;;) {
      const free = slots - running.size;
      const idle = !holOpen && !bringOpen && running.size === 0 && !teilOpen;
      const fetchAllowed = this.keepGoing && !(once && fetchedOnce) && nowS() >= quietUntil;

      if (idle && done.length === 0 && (!this.keepGoing || (once && fetchedOnce))) break;

      // First check that the model answers - otherwise the node would fetch
      // jobs it cannot do.
      if (idle && done.length === 0 && fetchAllowed) {
        if (!(await this.modelReady())) {
          if (modelWaits % 6 === 0) say('Model server not reachable, waiting.');
          modelWaits++;
          if (once) return -1;
          for (let i = 0; i < 10 && this.keepGoing; i++) await sleep(1000);
          continue;
        }
        if (modelWaits > 0) { say('Model server is back.'); modelWaits = 0; }
      }

      if (fetchAllowed && !holOpen && free > 0) {
        launch({ what: 'hol', id: 0, t0: nowF() }, this.callRc('hol', null, '&n=' + Math.min(free, slots)
          + '&warte=' + waitS + '&arten=' + kindsQ, holTimeout));
        holOpen = true; fetchedOnce = true; lastCall = nowS();
      } else if (this.keepGoing && !holOpen && free <= 0 && (nowS() - lastCall) >= HEARTBEAT_S) {
        // Heartbeat while all slots are busy; 'kann' too, or a pure embedder
        // would lose its kind with every heartbeat.
        launch({ what: 'heartbeat', id: 0, t0: nowF() }, this.callRc('hol', null, '&n=0&warte=0&kann=' + canQ, 20));
        holOpen = true; lastCall = nowS();
      }

      if (!bringOpen && done.length) {
        const body = php.jsonEncode({ ergebnisse: done }, { unescapedUnicode: true });
        launch({ what: 'bring', id: 0, t0: nowF() }, this.callRc('bring', body));
        inBring = done; done = []; bringOpen = true;
      }

      // Parts while the model writes. One teil call at a time for all jobs,
      // at most 8 entries, per job at most every stream_ms, only grown text
      // cut at the last whitespace. n keeps counting across a retry.
      if (!teilOpen && !this.streamOff) {
        const now = nowF();
        const entries = [];
        for (const [tid, tj] of running) {
          if (entries.length >= TEIL_MAX_ENTRIES) break;
          if (tj.zs === null || !tj.teilGo || (now - tj.teilT) * 1000 < streamMs) continue;
          // The model has already finished this attempt (finish_reason / [DONE]
          // seen): the result follows via bring right away. The reference reaches
          // the same point by collecting the finished transfer in the same
          // curl_multi round, before its next part check.
          if (tj.zs.ended) continue;
          const ttext = logic.streamCut(tj.zs.text);
          if (php.strlen(ttext) <= php.strlen(tj.teilText)) continue;
          // reactive.chat takes no more than this - then no more parts.
          if (php.strlen(ttext) > TEIL_MAX_BYTES) { tj.teilGo = false; continue; }
          tj.teilN++;
          tj.teilT = now;
          tj.teilText = ttext;
          entries.push({ id: tid, n: tj.teilN, text: ttext });
        }
        if (entries.length) {
          launch({ what: 'teil', id: 0, t0: nowF() },
            this.callRc('teil', php.jsonEncode({ teile: entries }, { unescapedUnicode: true }), '', 10));
          teilOpen = true;
        }
      }

      let something = false;
      while (events.length) {
        something = true;
        const { z, r } = events.shift();
        let body = r.body;
        if (z.stream) { z.stream.finish(); body = z.stream.raw; }
        const code = r.error ? 0 : r.code;

        if (z.what === 'heartbeat') { holOpen = false; continue; }

        if (z.what === 'hol') {
          holOpen = false;
          const a = Node.readRc({ code, body, error: r.error });
          if (a.code !== 200 || !php.isset(a.daten, 'auftraege')) {
            say('Fetching jobs failed: HTTP ' + a.code + ' ' + (a.fehler !== '' ? a.fehler : php.mbSubstr(a.roh, 160)));
            lineError = true;
            failures++;
            quietUntil = nowS() + Math.min(300, 5 * failures);
            continue;
          }
          failures = 0;
          let fresh = 0;
          for (const job of php.toList(a.daten.auftraege)) {
            const id = php.toInt(php.pick(job, 'id', 0));
            if (id <= 0 || running.has(id)) continue;
            const j = {
              id,
              art: php.toStr(php.pick(job, 'art', 'chat')),
              system: php.toStr(php.pick(job, 'system', '')),
              prompt: php.toStr(php.pick(job, 'prompt', '')),
              facts: php.toStr(php.pick(job, 'fakten', '')),
              max_tokens: php.toInt(php.pick(job, 'max_tokens', 0)),
              texts: php.toList(php.pick(job, 'texte', [])).map(php.toStr),
              images: logic.imagesFromJob(php.pick(job, 'bilder', null), c.images, c.images_max),
              attempt: 1,
              ms: 0,
              stream: !php.empty(php.get(job, 'strom')),
              zs: null,
              teilN: 0,
              teilT: 0,
              teilText: '',
              teilGo: true,
            };
            running.set(id, j);
            if (j.art === 'einbettung') {
              if (c.embed_url === '' || j.texts.length === 0) {
                finishJob(id, '', c.embed_url === '' ? 'kein Einbettungsserver' : 'Einbettung ohne Texte');
                continue;
              }
              launch({ what: 'embed', id, t0: nowF() }, this.callEmbed(j.texts));
              fresh++;
              continue;
            }
            if (j.prompt === '') {
              finishJob(id, '', 'Auftrag ohne Text');
              continue;
            }
            if (this.one) {
              this.out('\n--- Job #' + id + ' (' + j.art + ') ---\nSYSTEM:\n' + j.system
                + '\n\nPROMPT:\n' + j.prompt + (j.images.length ? '\n\nIMAGES: ' + j.images.length : '') + '\n\n');
            }
            startModel(id);
            fresh++;
          }
          if (fresh) say(fresh + ' job(s) fetched [' + running.size + '/' + slots + '].');
          continue;
        }

        if (z.what === 'teil') {
          teilOpen = false;
          const t = Node.readRc({ code, body, error: r.error });
          // 400/404: this server does not know 'teil' - streaming off until restart.
          if (t.code === 400 || t.code === 404) {
            this.streamOff = true;
            say('Streaming off until restart: teil answered HTTP ' + t.code + ' ' + php.mbSubstr(t.roh, 120));
            continue;
          }
          if (t.code === 200 && php.isset(t.daten, 'teile') && php.isArr(t.daten.teile)) {
            for (const e of php.toList(t.daten.teile)) {
              // weiter:false - no more parts for this job.
              if (!php.isArr(e)) continue;
              const tj = running.get(php.toInt(php.pick(e, 'id', 0)));
              if (tj && Object.prototype.hasOwnProperty.call(e, 'weiter') && php.empty(e.weiter)) tj.teilGo = false;
            }
          }
          continue;
        }

        if (z.what === 'bring') {
          bringOpen = false;
          const b = Node.readRc({ code, body, error: r.error });
          if (b.code !== 200 || !php.isset(b.daten, 'ergebnisse')) {
            say('Delivery failed: HTTP ' + b.code + ' ' + (b.fehler !== '' ? b.fehler : php.mbSubstr(b.roh, 160)));
            lineError = true;
            inBring = [];
            continue;
          }
          let accepted = 0;
          for (const e of php.toList(b.daten.ergebnisse)) {
            if (!php.empty(php.get(e, 'angenommen'))) accepted++;
            else if (!php.empty(php.get(e, 'grund'))) {
              say('  #' + php.toInt(php.pick(e, 'id', 0)) + ' rejected: ' + php.toStr(e.grund));
            }
          }
          say(accepted + ' of ' + inBring.length + ' accepted.');
          inBring = [];
          continue;
        }

        const id = z.id;
        const j = running.get(id);
        if (!j) continue;
        if (z.what === 'embed') {
          j.ms += Math.round((nowF() - z.t0) * 1000);
          const [payload, err] = logic.readEmbedding(code, body, r.error, j.texts.length, c.embed_model);
          finishJob(id, payload === null ? '' : payload, err);
          continue;
        }
        const m = logic.readModel(code, body, r.error, Math.round((nowF() - z.t0) * 1000), z.stream || null);
        j.ms += m.ms;
        if (m.text === null) { finishJob(id, '', m.fehler); continue; }

        const candidate = logic.clean(m.text);
        // KEINE_ANTWORT is the agreed word for "not in the sources" - passed on
        // unchanged, it leads to a hand-over.
        if (logic.isNoAnswer(candidate)) { finishJob(id, 'KEINE_ANTWORT', ''); continue; }
        const bad = logic.checkNumbers(candidate, j.facts);
        if (bad === null && candidate !== '') { finishJob(id, candidate, ''); continue; }
        if (j.attempt < 2) { j.attempt++; startModel(id); continue; }
        finishJob(id, '', candidate === '' ? 'leer nach dem Saeubern' : 'erfundene Zahl: ' + bad);
      }

      if (!something) {
        if (active > 0) {
          // With a running stream 0.1 s: a due part should not wait.
          let sel = 1000;
          for (const sj of running.values()) {
            if (sj.zs !== null && sj.teilGo && !this.streamOff) { sel = 100; break; }
          }
          await this.waitWake(sel);
        } else {
          await this.waitWake(200);
        }
      }
    }
    return (once && lineError && finishedCount === 0) ? -1 : finishedCount;
  }

  async daemon() {
    const c = this.cfg;
    this.log.say('Daemon mode. Node ' + c.node_id + ', model ' + c.model + ' at ' + this.modelUrl()
      + ', long-poll ' + c.poll_wait + ' s, up to ' + Math.max(1, c.concurrency)
      + ' at a time, fetches: ' + c.kinds.join(', ') + '.');
    await this.loop(false);
    this.log.say('Stopped.');
    return 0;
  }
}

/** English rendering of the German reasons, for the --probe report only. */
function englishReason(r) {
  const map = [
    [/^Modell nicht erreichbar: /, 'model not reachable: '],
    [/^Modell HTTP /, 'model answered HTTP '],
    [/^Modell-Strom: /, 'model stream error: '],
    [/^Antwort ohne Text$/, 'answer without text'],
    [/^Strom ohne Abschluss$/, 'stream without end'],
    [/^Einbettungsserver nicht erreichbar: /, 'embedding server not reachable: '],
    [/^Einbettung HTTP /, 'embedding server answered HTTP '],
    [/^Einbettung unlesbar$/, 'embedding answer unreadable'],
    [/^Vektor leer oder ungleich lang$/, 'vector empty or of unequal length'],
    [/^(\d+) Vektoren fuer (\d+) Texte$/, '$1 vectors for $2 texts'],
  ];
  for (const [re, en] of map) if (re.test(r)) return r.replace(re, en);
  return r;
}

module.exports = { Node, VERSION, USER_AGENT, englishReason };
