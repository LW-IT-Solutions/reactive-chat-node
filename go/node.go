package main

// The node: logging, the calls to reactive.chat and to the model, the
// readiness check and --probe.

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type node struct {
	cfg    *config
	pi     *nodeHTTP // reactive.chat
	model  *nodeHTTP // model and embedding server
	logMu  sync.Mutex
	out    io.Writer
	one    bool        // --one: one slot, print each job
	stop   atomic.Bool // set by SIGTERM/SIGINT in --daemon
	wake   chan struct{}
	events chan event
}

func newNode(cfg *config, one bool) *node {
	return &node{
		cfg:    cfg,
		pi:     &nodeHTTP{client: newClient(cfg.resolveMap, cfg.TLSVerify)},
		model:  &nodeHTTP{client: newClient(nil, true)},
		out:    os.Stdout,
		one:    one,
		wake:   make(chan struct{}, 1),
		events: make(chan event, 256),
	}
}

// say writes one log line: "YYYY-MM-DD HH:MM:SS  text" to stdout and, if
// configured, appended to log_file.
func (n *node) say(text string) {
	line := time.Now().In(n.cfg.location).Format("2006-01-02 15:04:05") + "  " + text + "\n"
	n.logMu.Lock()
	defer n.logMu.Unlock()
	io.WriteString(n.out, line)
	if n.cfg.LogFile != "" {
		if f, err := os.OpenFile(n.cfg.LogFile, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600); err == nil {
			f.WriteString(line)
			f.Close()
		}
	}
}

// print writes raw text to stdout (--one), serialised with the log.
func (n *node) print(text string) {
	n.logMu.Lock()
	defer n.logMu.Unlock()
	io.WriteString(n.out, text)
}

// poke wakes the main loop (non-blocking).
func (n *node) poke() {
	select {
	case n.wake <- struct{}{}:
	default:
	}
}

// ---------------------------------------------------------------------------
// reactive.chat
// ---------------------------------------------------------------------------

// piRequest builds a signed call (piHandle). body nil = GET.
func (n *node) piRequest(action string, body []byte, extra string, timeoutS int64) request {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	u := strings.TrimRight(n.cfg.BaseURL, "/") + "/v1/ki?action=" + action +
		"&knoten=" + rawURLEncode(n.cfg.NodeID) + extra + "&nonce=" + newNonce()
	p, q := splitURL(u)
	method := "GET"
	if body != nil {
		method = "POST"
	}
	sig := sign(n.cfg.Secret, ts, method, p, q, string(body))
	return request{
		method: method,
		url:    u,
		headers: [][2]string{
			{"X-RC-KI-TS", ts},
			{"X-RC-KI-SIG", sig},
			{"Content-Type", "application/json"},
			{"User-Agent", userAgent},
		},
		body:    body,
		basic:   n.cfg.BasicAuth,
		timeout: time.Duration(timeoutS) * time.Second,
		connect: 15 * time.Second,
	}
}

// piAnswer is piLesen: code, error, decoded JSON (array or nil), raw body.
type piAnswer struct {
	code int
	err  string
	data any
	raw  string
}

func readPi(r response) piAnswer {
	if r.err != "" {
		return piAnswer{err: r.err}
	}
	a := piAnswer{code: r.code, raw: string(r.body)}
	if v, ok := decodeJSON(r.body); ok && isArray(v) {
		a.data = v
	}
	return a
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

func (n *node) modelURL() string {
	if n.cfg.ChatURL != "" {
		return n.cfg.ChatURL
	}
	return strings.TrimRight(n.cfg.ModelEndpoint, "/") + "/chat/completions"
}

func (n *node) modelHeaders() [][2]string {
	h := [][2]string{{"Content-Type", "application/json"}}
	if n.cfg.ModelAPIKey != "" {
		if strings.EqualFold(n.cfg.ModelKeyHeader, "Authorization") {
			h = append(h, [2]string{"Authorization", "Bearer " + n.cfg.ModelAPIKey})
		} else {
			h = append(h, [2]string{n.cfg.ModelKeyHeader, n.cfg.ModelAPIKey})
		}
	}
	return h
}

// modelRequest is modellHandle: stream != nil asks for SSE.
func (n *node) modelRequest(system, prompt string, maxTokens int64, images []string, stream *streamState) request {
	if maxTokens <= 0 {
		maxTokens = n.cfg.MaxTokens
	}
	r := request{
		method:  "POST",
		url:     n.modelURL(),
		headers: n.modelHeaders(),
		body:    chatBody(n.cfg.Model, stream != nil, n.cfg.Temperature, maxTokens, system, prompt, images),
		timeout: time.Duration(n.cfg.Timeout) * time.Second,
		connect: 10 * time.Second,
	}
	if stream != nil {
		// No wake-up per chunk: the loop looks at streaming jobs every
		// 100 ms anyway (see run), which keeps parts at stream_ms pace and
		// lets the end of a stream arrive before the last text is shown.
		r.sink = stream.feed
	}
	return r
}

func (n *node) embedRequest(texts []string) request {
	return request{
		method:  "POST",
		url:     n.cfg.EmbedURL,
		headers: [][2]string{{"Content-Type", "application/json"}},
		body:    embedBody(n.cfg.EmbedModel, texts),
		timeout: time.Duration(n.cfg.EmbedTimeout) * time.Second,
		connect: 5 * time.Second,
	}
}

// askModel is ansModell: one blocking, non-streamed completion.
func (n *node) askModel(system, prompt string) modelResult {
	t0 := time.Now()
	r := n.model.do(n.modelRequest(system, prompt, 20, nil, nil))
	return readModel(r.code, r.body, r.err, time.Since(t0).Milliseconds(), nil)
}

// embedReady is einbettenBereit.
func (n *node) embedReady() bool {
	r := n.embedRequest([]string{"Bereit"})
	r.timeout = 30 * time.Second
	a := n.model.do(r)
	return a.err == "" && a.code == 200
}

// modelReady is modellBereit: does the model (or embedding) server answer?
func (n *node) modelReady() bool {
	if contains(n.cfg.Kinds, "einbettung") && !n.embedReady() {
		return false
	}
	onlyEmbed := true
	for _, k := range n.cfg.Kinds {
		if k != "einbettung" {
			onlyEmbed = false
		}
	}
	if onlyEmbed || n.cfg.ChatURL != "" {
		return true // Azure (chat_url) has no /models
	}
	a := n.model.do(request{
		method:  "GET",
		url:     strings.TrimRight(n.cfg.ModelEndpoint, "/") + "/models",
		headers: n.modelHeaders(),
		timeout: 5 * time.Second,
		connect: 3 * time.Second,
	})
	return a.err == "" && a.code == 200
}

// ---------------------------------------------------------------------------
// --probe
// ---------------------------------------------------------------------------

func yesNo(images bool, max int64) string {
	if images {
		return fmt.Sprintf("yes (at most %d)", max)
	}
	return "no"
}

// probe checks both sides and takes nothing (n=0). Exit 0 if reactive.chat
// answered 200 and the model answered.
func (n *node) probe() int {
	c := n.cfg
	n.say("Probe, rc-node-go " + version + ".")
	n.say("  reactive.chat: " + c.BaseURL)
	a := readPi(n.pi.do(n.piRequest("hol", nil, "&n=0&warte=0&arten="+rawURLEncode(strings.Join(c.Kinds, ","))+
		"&kann="+rawURLEncode(strings.Join(c.Capabilities, ",")), 20)))
	piOK := a.code == 200
	switch {
	case a.code == 200 && a.data != nil:
		open, _ := get(a.data, "offen")
		n.say(fmt.Sprintf("    HTTP 200 - signed in, %d job(s) waiting.", toInt(open)))
	case a.code == 401:
		n.say("    HTTP 401 - rejected. Are node_id and secret right? Is this computer's clock right (NTP)?" +
			" Has the node been revoked in the customer area?")
	case a.err != "":
		n.say("    No connection: " + a.err)
	default:
		n.say(fmt.Sprintf("    No connection: HTTP %d %s", a.code, firstRunes(a.raw, 200)))
	}

	n.say("  Model: " + n.modelURL() + " (" + c.Model + ")")
	m := n.askModel("Antworte mit genau einem Wort.", "Sag: Bereit")
	if m.ok {
		n.say(fmt.Sprintf("    Answer in %d ms: %s", m.ms, cleanAnswer(m.text)))
	} else {
		n.say("    Failed: " + m.fail.en)
	}

	if c.EmbedURL != "" {
		n.say("  Embedding: " + c.EmbedURL + " (" + c.EmbedModel + ")")
		t0 := time.Now()
		r := n.model.do(n.embedRequest([]string{"Bereit"}))
		payload, ok, why := readEmbedding(r.code, r.body, r.err, 1, c.EmbedModel)
		if ok {
			v, _ := decodeJSON([]byte(payload))
			dims, _ := get(v, "dims")
			n.say(fmt.Sprintf("    %d dimensions in %d ms", toInt(dims), time.Since(t0).Milliseconds()))
		} else {
			n.say("    Failed: " + why.en)
		}
	}
	n.say("  Node: " + c.NodeID + ", takes: " + strings.Join(c.Kinds, ", ") +
		", can: " + strings.Join(c.Capabilities, ", ") + ", images: " + yesNo(c.Images, c.ImagesMax))
	if piOK && m.ok {
		n.say("Result: ready - reactive.chat accepted the node and the model answered.")
		return 0
	}
	var bad []string
	if !piOK {
		bad = append(bad, "reactive.chat did not accept the node")
	}
	if !m.ok {
		bad = append(bad, "the model did not answer")
	}
	n.say("Result: NOT ready - " + strings.Join(bad, " and ") + ".")
	return 1
}
