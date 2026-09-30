package main

// The model side: request bodies, SSE parsing (strom*), reading a chat
// answer (modellLesen) and an embedding answer (einbettenLesen).

import (
	"encoding/base64"
	"encoding/binary"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// reason is a failure: wire is the German `grund` sent to reactive.chat
// (byte-identical to the reference), en is the English text for humans.
type reason struct{ wire, en string }

func reasonf(wireBase, enBase, detail string) reason {
	return reason{wireBase + detail, enBase + detail}
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

// chatBody builds the /chat/completions body exactly as json_encode() does
// in modellHandle(): with images the user content becomes a list.
func chatBody(model string, stream bool, temperature float64, maxTokens int64,
	system, prompt string, images []string) []byte {
	w := &jsonWriter{escapeSlash: true}
	w.raw(`{`)
	w.key("model")
	w.str(model)
	w.raw(`,`)
	w.key("stream")
	w.bool(stream)
	w.raw(`,`)
	w.key("temperature")
	w.float(temperature)
	w.raw(`,`)
	w.key("max_tokens")
	w.int(maxTokens)
	w.raw(`,`)
	w.key("messages")
	w.raw(`[{`)
	w.key("role")
	w.str("system")
	w.raw(`,`)
	w.key("content")
	w.str(system)
	w.raw(`},{`)
	w.key("role")
	w.str("user")
	w.raw(`,`)
	w.key("content")
	if len(images) == 0 {
		w.str(prompt)
	} else {
		w.raw(`[{`)
		w.key("type")
		w.str("text")
		w.raw(`,`)
		w.key("text")
		w.str(prompt)
		w.raw(`}`)
		for _, u := range images {
			w.raw(`,{`)
			w.key("type")
			w.str("image_url")
			w.raw(`,`)
			w.key("image_url")
			w.raw(`{`)
			w.key("url")
			w.str(u)
			w.raw(`}}`)
		}
		w.raw(`]`)
	}
	w.raw(`}]}`)
	return w.bytes()
}

// embedBody is {"model":...,"input":[...]} (einbettenHandle).
func embedBody(model string, texts []string) []byte {
	w := &jsonWriter{escapeSlash: true}
	w.raw(`{`)
	w.key("model")
	w.str(model)
	w.raw(`,`)
	w.key("input")
	w.raw(`[`)
	first := true
	for _, t := range texts {
		w.comma(&first)
		w.str(t)
	}
	w.raw(`]}`)
	return w.bytes()
}

// ---------------------------------------------------------------------------
// Streaming (SSE)
// ---------------------------------------------------------------------------

const rawCap = 4 * 1024 * 1024

// streamState is the state of one streamed model call (stromNeu). It is fed
// by the HTTP goroutine and read by the main loop, hence the mutex.
type streamState struct {
	mu      sync.Mutex
	raw     []byte // copy of the body (capped), for non-SSE answers
	buf     []byte // unfinished line
	text    []byte
	sse     bool
	content bool
	done    bool
	errMsg  string
}

// feed takes bytes from the model (stromFuettern).
func (s *streamState) feed(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.raw) < rawCap {
		s.raw = append(s.raw, data...)
	}
	s.buf = append(s.buf, data...)
	for {
		p := indexByte(s.buf, '\n')
		if p < 0 {
			break
		}
		s.line(strings.TrimRight(string(s.buf[:p]), "\r"))
		s.buf = append(s.buf[:0], s.buf[p+1:]...)
	}
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

// finish handles what is left after the last newline (stromSchluss).
func (s *streamState) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.buf) > 0 {
		s.line(strings.TrimRight(string(s.buf), "\r"))
		s.buf = s.buf[:0]
	}
}

// line handles one SSE line (stromZeile); only "data: {...}" and
// "data: [DONE]" count. Caller holds the lock.
func (s *streamState) line(l string) {
	if !strings.HasPrefix(l, "data:") {
		return
	}
	s.sse = true
	payload := phpTrim(l[5:])
	if payload == "[DONE]" {
		s.done = true
		return
	}
	j, ok := decodeJSON([]byte(payload))
	if !ok || !isArray(j) {
		return
	}
	// vLLM reports an error in the middle of a stream as its own event.
	if obj, _ := get(j, "object"); isset(j, "error") || obj == "error" {
		f := j
		if isset(j, "error") {
			f, _ = get(j, "error")
		}
		if isArray(f) {
			if isset(f, "message") {
				m, _ := get(f, "message")
				s.errMsg = toString(m)
			} else {
				s.errMsg = "Fehler ohne Text"
			}
		} else {
			s.errMsg = toString(f)
		}
		return
	}
	c := path(j, "choices", "0")
	if !isArray(c) {
		return
	}
	if d, ok := path(c, "delta", "content").(string); ok {
		s.text = append(s.text, d...)
		s.content = true
	}
	if fr, _ := get(c, "finish_reason"); truthy(fr) {
		s.done = true
	}
}

// snapshot returns the text streamed so far and whether the model has
// signalled the end ([DONE] or finish_reason).
func (s *streamState) snapshot() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.text), s.done
}

// ---------------------------------------------------------------------------
// Reading answers
// ---------------------------------------------------------------------------

// modelResult is what modellLesen returns: text (ok) or a failure reason.
type modelResult struct {
	text string
	ok   bool
	ms   int64
	fail reason
}

// readModel evaluates a chat completion answer (modellLesen). errText is
// the transport error ("" when the request completed).
func readModel(code int, raw []byte, errText string, ms int64, s *streamState) modelResult {
	if errText != "" {
		return modelResult{ms: ms, fail: reasonf("Modell nicht erreichbar: ", "model server not reachable: ", errText)}
	}
	if code != 200 {
		d := strconv.Itoa(code) + ": " + firstRunes(string(raw), 160)
		return modelResult{ms: ms, fail: reasonf("Modell HTTP ", "model server answered HTTP ", d)}
	}
	if s != nil {
		s.mu.Lock()
		sse, errMsg, content, done, text := s.sse, s.errMsg, s.content, s.done, string(s.text)
		s.mu.Unlock()
		if sse {
			if errMsg != "" {
				return modelResult{ms: ms, fail: reasonf("Modell-Strom: ", "error inside the model stream: ", firstRunes(errMsg, 160))}
			}
			if !content {
				return modelResult{ms: ms, fail: reason{"Antwort ohne Text", "the answer contains no text"}}
			}
			if !done {
				return modelResult{ms: ms, fail: reason{"Strom ohne Abschluss", "the stream ended without a finish marker"}}
			}
			return modelResult{text: text, ok: true, ms: ms}
		}
	}
	v, _ := decodeJSON(raw)
	for _, step := range []string{"choices", "0", "message", "content"} {
		if !isArray(v) || !isset(v, step) {
			return modelResult{ms: ms, fail: reason{"Antwort ohne Text", "the answer contains no text"}}
		}
		v, _ = get(v, step)
	}
	return modelResult{text: toString(v), ok: true, ms: ms}
}

// readEmbedding turns an /v1/embeddings answer into the payload
// reactive.chat expects (einbettenLesen):
// {"vektoren":["<base64 float32 LE>",...],"dims":N,"modell":"..."}.
func readEmbedding(code int, raw []byte, errText string, count int, label string) (string, bool, reason) {
	if errText != "" {
		return "", false, reasonf("Einbettungsserver nicht erreichbar: ", "embedding server not reachable: ", errText)
	}
	if code != 200 {
		d := strconv.Itoa(code) + ": " + firstRunes(string(raw), 160)
		return "", false, reasonf("Einbettung HTTP ", "embedding server answered HTTP ", d)
	}
	j, _ := decodeJSON(raw)
	data, _ := get(j, "data")
	if !isArray(j) || !isset(j, "data") || !isArray(data) {
		return "", false, reason{"Einbettung unlesbar", "the embedding answer is unreadable"}
	}
	items := append([]any(nil), values(data)...)
	idx := func(x any) int64 { v, _ := get(x, "index"); return toInt(v) }
	sort.SliceStable(items, func(a, b int) bool { return idx(items[a]) < idx(items[b]) })
	var vecs []string
	dims := 0
	for _, e := range items {
		var nums []any
		if isset(e, "embedding") {
			v, _ := get(e, "embedding")
			nums = values(v)
		}
		if len(nums) == 0 || (dims > 0 && len(nums) != dims) {
			return "", false, reason{"Vektor leer oder ungleich lang", "a vector is empty or of unequal length"}
		}
		dims = len(nums)
		buf := make([]byte, 4*len(nums))
		for i, n := range nums {
			binary.LittleEndian.PutUint32(buf[4*i:], math.Float32bits(float32(toFloat(n))))
		}
		vecs = append(vecs, base64.StdEncoding.EncodeToString(buf))
	}
	if len(vecs) != count {
		d := strconv.Itoa(len(vecs)) + " Vektoren fuer " + strconv.Itoa(count) + " Texte"
		return "", false, reason{d, strconv.Itoa(len(vecs)) + " vectors for " + strconv.Itoa(count) + " texts"}
	}
	// json_encode(..., JSON_UNESCAPED_SLASHES): unicode escaped, slashes not.
	w := &jsonWriter{escapeUnicode: true}
	w.raw(`{`)
	w.key("vektoren")
	w.raw(`[`)
	first := true
	for _, v := range vecs {
		w.comma(&first)
		w.str(v)
	}
	w.raw(`],`)
	w.key("dims")
	w.int(int64(dims))
	w.raw(`,`)
	w.key("modell")
	w.str(label)
	w.raw(`}`)
	return string(w.bytes()), true, reason{}
}
