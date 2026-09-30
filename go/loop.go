package main

// The main loop: fetch (hol), let the model work, deliver (bring), stream
// parts (teil) - several jobs at a time (schleife in the reference).
//
// Every HTTP call runs in its own goroutine and reports back through
// n.events; all state lives in this one goroutine, so there is no locking
// apart from the stream buffers. At most one hol/heartbeat, one bring and
// one teil are in flight at any time, plus up to `concurrency` model calls.

import (
	"fmt"
	"strings"
	"time"
)

const heartbeatS = 45 // report even when all slots are busy, or the server thinks the node is dead

type event struct {
	what string // hol, puls, bring, teil, modell, einbettung
	id   int64
	resp response
	t0   time.Time
	zs   *streamState
}

type job struct {
	id        int64
	kind      string
	system    string
	prompt    string
	facts     string
	maxTokens int64
	texts     []string
	images    []string
	attempt   int
	ms        int64
	stream    bool // the job asked for streaming
	zs        *streamState
	partN     int64
	partT     time.Time
	partText  string
	partMore  bool
}

type result struct {
	id     int64
	text   string
	reason string
	ms     int64
}

// start runs one HTTP call in the background and reports it as an event.
func (n *node) start(h *nodeHTTP, what string, id int64, r request, zs *streamState) {
	t0 := time.Now()
	go func() {
		resp := h.do(r)
		if zs != nil {
			// the bytes are in the stream state, not in the response
			zs.finish()
			zs.mu.Lock()
			resp.body = append([]byte(nil), zs.raw...)
			zs.mu.Unlock()
		}
		n.events <- event{what: what, id: id, resp: resp, t0: t0, zs: zs}
		n.poke()
	}()
}

func resultsBody(list []result, model, nodeID string) []byte {
	w := &jsonWriter{escapeSlash: true}
	w.raw(`{"ergebnisse":[`)
	first := true
	for _, r := range list {
		w.comma(&first)
		w.raw(`{`)
		w.key("id")
		w.int(r.id)
		w.raw(`,`)
		w.key("text")
		w.str(r.text)
		w.raw(`,`)
		w.key("grund")
		w.str(r.reason)
		w.raw(`,`)
		w.key("modell")
		w.str(model)
		w.raw(`,`)
		w.key("ms")
		w.int(r.ms)
		w.raw(`,`)
		w.key("knoten")
		w.str(nodeID)
		w.raw(`}`)
	}
	w.raw(`]}`)
	return w.bytes()
}

type part struct {
	id, n int64
	text  string
}

func partsBody(list []part) []byte {
	w := &jsonWriter{escapeSlash: true}
	w.raw(`{"teile":[`)
	first := true
	for _, p := range list {
		w.comma(&first)
		w.raw(`{`)
		w.key("id")
		w.int(p.id)
		w.raw(`,`)
		w.key("n")
		w.int(p.n)
		w.raw(`,`)
		w.key("text")
		w.str(p.text)
		w.raw(`}`)
	}
	w.raw(`]}`)
	return w.bytes()
}

// run is one fetch cycle (once) or the daemon loop. It returns the number
// of jobs done, or -1 for "connection error and nothing done" in once mode.
func (n *node) run(once bool) int {
	c := n.cfg
	slots := c.Concurrency
	if n.one {
		slots = 1
	}
	if slots < 1 {
		slots = 1
	}
	waitS := c.PollWait
	if waitS < 0 {
		waitS = 0
	}
	if waitS > 60 {
		waitS = 60
	}
	holTimeout := waitS + 20
	kann := rawURLEncode(strings.Join(c.Capabilities, ","))
	kinds := rawURLEncode(strings.Join(c.Kinds, ",")) + "&kann=" + kann
	if c.Images {
		kinds += "&bilder=1" // only a node that can see images says so
	}
	streamMs := c.StreamMs
	if streamMs < 100 {
		streamMs = 100
	}

	running := map[int64]*job{}
	var order []int64 // insertion order of running (PHP arrays are ordered)
	var finished []result
	inBring := 0
	holOpen, bringOpen, partOpen, fetched := false, false, false, false
	inflight := 0
	done := 0
	lineError := false
	failures := int64(0)
	var quietUntil int64
	lastCall := time.Now().Unix()
	modelWaiting := 0
	streamOff := false

	remove := func(id int64) {
		delete(running, id)
		for i, x := range order {
			if x == id {
				order = append(order[:i], order[i+1:]...)
				break
			}
		}
	}

	finish := func(id int64, text, why string) {
		j := running[id]
		remove(id)
		done++
		line := fmt.Sprintf("  #%d", id)
		if text == "" {
			line += " discarded: " + why
		} else if j.kind == "einbettung" {
			line += fmt.Sprintf(" %d ms: %d text(s) embedded", j.ms, len(j.texts))
		} else {
			line += fmt.Sprintf(" %d ms: %s", j.ms, firstRunes(text, 100))
		}
		if j.stream {
			line += fmt.Sprintf("  parts %d", j.partN)
			if !j.partMore {
				line += " (stopped)"
			}
		}
		line += fmt.Sprintf("  [%d/%d]", len(running), slots)
		n.say(line)
		// Failures are delivered too: someone is waiting in the chat, and
		// the server can hand over at once instead of waiting for the lease.
		r := result{id: id, text: text, ms: j.ms}
		if text == "" {
			r.reason = why
		}
		finished = append(finished, r)
	}

	launch := func(id int64) {
		j := running[id]
		p := j.prompt
		if j.attempt != 1 {
			p += retrySuffix
		}
		// Streaming only if the job AND the config ask for it and
		// reactive.chat has not refused teil. Every attempt starts empty.
		var zs *streamState
		if j.stream && c.Stream && !streamOff {
			zs = &streamState{}
		}
		j.zs = zs
		j.partText = ""
		n.start(n.model, "modell", id, n.modelRequest(j.system, p, j.maxTokens, j.images, zs), zs)
		inflight++
	}

	for {
		free := slots - int64(len(running))
		idle := !holOpen && !bringOpen && len(running) == 0 && !partOpen
		goOn := !n.stop.Load()
		now := time.Now().Unix()
		mayFetch := goOn && !(once && fetched) && now >= quietUntil

		if idle && len(finished) == 0 && (!goOn || (once && fetched)) {
			break
		}

		// First check that the model answers - otherwise the node would take
		// jobs it cannot do.
		if idle && len(finished) == 0 && mayFetch {
			if !n.modelReady() {
				if modelWaiting%6 == 0 {
					n.say("Model server not reachable, waiting.")
				}
				modelWaiting++
				if once {
					return -1
				}
				n.sleep(10 * time.Second)
				continue
			}
			if modelWaiting > 0 {
				n.say("Model server is back.")
				modelWaiting = 0
			}
		}

		if mayFetch && !holOpen && free > 0 {
			nFetch := free
			if nFetch > slots {
				nFetch = slots
			}
			extra := fmt.Sprintf("&n=%d&warte=%d&arten=%s", nFetch, waitS, kinds)
			n.start(n.pi, "hol", 0, n.piRequest("hol", nil, extra, holTimeout), nil)
			inflight++
			holOpen, fetched = true, true
			lastCall = time.Now().Unix()
		} else if goOn && !holOpen && free <= 0 && time.Now().Unix()-lastCall >= heartbeatS {
			// 'kann' in the heartbeat too: without it the server assumes
			// 'chat', and a pure embedder would lose its kind.
			n.start(n.pi, "puls", 0, n.piRequest("hol", nil, "&n=0&warte=0&kann="+kann, 20), nil)
			inflight++
			holOpen = true
			lastCall = time.Now().Unix()
		}

		if !bringOpen && len(finished) > 0 {
			n.start(n.pi, "bring", 0, n.piRequest("bring", resultsBody(finished, c.Model, c.NodeID), "", 60), nil)
			inflight++
			inBring = len(finished)
			finished = nil
			bringOpen = true
		}

		// Parts while the model is writing. Never blocking, one teil call
		// at a time for all jobs, at most 8 entries, per job at most every
		// stream_ms, only grown text cut at the last whitespace.
		if !partOpen && !streamOff {
			t := time.Now()
			var parts []part
			for _, id := range order {
				if len(parts) >= 8 {
					break
				}
				j := running[id]
				if j.zs == nil || !j.partMore || t.Sub(j.partT) < time.Duration(streamMs)*time.Millisecond {
					continue
				}
				text, ended := j.zs.snapshot()
				if ended {
					// The model has finished: the answer is complete and goes
					// out via bring within moments. The reference never shows
					// such a text as a part either, because it handles the end
					// of a transfer before it looks at parts again.
					continue
				}
				text = streamCut(text)
				if len(text) <= len(j.partText) {
					continue
				}
				if len(text) > 16000 { // reactive.chat takes no more - no more parts then
					j.partMore = false
					continue
				}
				j.partN++
				j.partT = t
				j.partText = text
				parts = append(parts, part{id: id, n: j.partN, text: text})
			}
			if len(parts) > 0 {
				n.start(n.pi, "teil", 0, n.piRequest("teil", partsBody(parts), "", 10), nil)
				inflight++
				partOpen = true
			}
		}

		got := false
	drain:
		for {
			select {
			case ev := <-n.events:
				got = true
				inflight--
				switch ev.what {
				case "puls":
					holOpen = false

				case "hol":
					holOpen = false
					a := readPi(ev.resp)
					jobs, _ := get(a.data, "auftraege")
					if a.code != 200 || !isset(a.data, "auftraege") {
						detail := a.err
						if detail == "" {
							detail = firstRunes(a.raw, 160)
						}
						lineError = true
						failures++
						back := 5 * failures
						if back > 300 {
							back = 300
						}
						quietUntil = time.Now().Unix() + back
						n.say(fmt.Sprintf("Fetching jobs failed: HTTP %d %s", a.code, detail))
						continue
					}
					failures = 0
					added := 0
					for _, auf := range values(jobs) {
						idv, _ := get(auf, "id")
						id := toInt(idv)
						if _, dup := running[id]; id <= 0 || dup {
							continue
						}
						field := func(k string) any { v, _ := get(auf, k); return v }
						j := &job{
							id:        id,
							kind:      "chat",
							system:    toString(field("system")),
							prompt:    toString(field("prompt")),
							facts:     toString(field("fakten")),
							maxTokens: toInt(field("max_tokens")),
							images:    imagesFromJob(field("bilder"), c.Images, c.ImagesMax),
							attempt:   1,
							stream:    truthy(field("strom")),
							partMore:  true,
						}
						if isset(auf, "art") {
							j.kind = toString(field("art"))
						}
						for _, t := range values(field("texte")) {
							j.texts = append(j.texts, toString(t))
						}
						running[id] = j
						order = append(order, id)
						if j.kind == "einbettung" {
							if c.EmbedURL == "" || len(j.texts) == 0 {
								why := "Einbettung ohne Texte"
								if c.EmbedURL == "" {
									why = "kein Einbettungsserver"
								}
								finish(id, "", why)
								continue
							}
							n.start(n.model, "einbettung", id, n.embedRequest(j.texts), nil)
							inflight++
							added++
							continue
						}
						if j.prompt == "" {
							finish(id, "", "Auftrag ohne Text")
							continue
						}
						if n.one {
							s := fmt.Sprintf("\n--- Job #%d (%s) ---\nSYSTEM:\n%s\n\nPROMPT:\n%s", id, j.kind, j.system, j.prompt)
							if len(j.images) > 0 {
								s += fmt.Sprintf("\n\nIMAGES: %d", len(j.images))
							}
							n.print(s + "\n\n")
						}
						launch(id)
						added++
					}
					if added > 0 {
						n.say(fmt.Sprintf("%d job(s) fetched [%d/%d].", added, len(running), slots))
					}

				case "teil":
					partOpen = false
					t := readPi(ev.resp)
					// 400/404: this server does not know teil - streaming off
					// until restart. Anything else: never mind, the next part
					// comes anyway.
					if t.code == 400 || t.code == 404 {
						streamOff = true
						n.say(fmt.Sprintf("Streaming off until restart: teil answered HTTP %d %s", t.code, firstRunes(t.raw, 120)))
						continue
					}
					list, _ := get(t.data, "teile")
					if t.code == 200 && isset(t.data, "teile") && isArray(list) {
						for _, e := range values(list) {
							if !isArray(e) {
								continue
							}
							idv, _ := get(e, "id")
							j, ok := running[toInt(idv)]
							more, has := get(e, "weiter")
							if ok && has && !truthy(more) {
								j.partMore = false // weiter:false - no more parts for this job
							}
						}
					}

				case "bring":
					bringOpen = false
					b := readPi(ev.resp)
					if b.code != 200 || !isset(b.data, "ergebnisse") {
						detail := b.err
						if detail == "" {
							detail = firstRunes(b.raw, 160)
						}
						n.say(fmt.Sprintf("Delivery failed: HTTP %d %s", b.code, detail))
						lineError = true
						inBring = 0
						continue
					}
					accepted := 0
					list, _ := get(b.data, "ergebnisse")
					for _, e := range values(list) {
						if v, _ := get(e, "angenommen"); truthy(v) {
							accepted++
						} else if g, _ := get(e, "grund"); truthy(g) {
							idv, _ := get(e, "id")
							n.say(fmt.Sprintf("  #%d rejected: %s", toInt(idv), toString(g)))
						}
					}
					n.say(fmt.Sprintf("%d of %d accepted.", accepted, inBring))
					inBring = 0

				case "einbettung":
					j, ok := running[ev.id]
					if !ok {
						continue
					}
					j.ms += time.Since(ev.t0).Round(time.Millisecond).Milliseconds()
					payload, okE, why := readEmbedding(ev.resp.code, ev.resp.body, ev.resp.err, len(j.texts), c.EmbedModel)
					if okE {
						finish(ev.id, payload, "")
					} else {
						finish(ev.id, "", why.wire)
					}

				case "modell":
					j, ok := running[ev.id]
					if !ok {
						continue
					}
					m := readModel(ev.resp.code, ev.resp.body, ev.resp.err,
						time.Since(ev.t0).Round(time.Millisecond).Milliseconds(), ev.zs)
					j.ms += m.ms
					if !m.ok {
						finish(ev.id, "", m.fail.wire)
						continue
					}
					cand := cleanAnswer(m.text)
					// KEINE_ANTWORT is the agreed word for "not in the
					// sources" - passed on unchanged, it leads to a handover.
					if containsFoldASCII(cand, "KEINE_ANTWORT") {
						finish(ev.id, "KEINE_ANTWORT", "")
						continue
					}
					bad, hasBad := checkNumbers(cand, j.facts)
					if !hasBad && cand != "" {
						finish(ev.id, cand, "")
						continue
					}
					if j.attempt < 2 {
						j.attempt++
						launch(ev.id)
						continue
					}
					if cand == "" {
						finish(ev.id, "", "leer nach dem Saeubern")
					} else {
						finish(ev.id, "", "erfundene Zahl: "+bad)
					}
				}
			default:
				break drain
			}
		}

		if !got {
			if inflight > 0 {
				wait := time.Second
				if !streamOff {
					for _, j := range running {
						if j.zs != nil && j.partMore {
							wait = 100 * time.Millisecond // a due part should not wait
							break
						}
					}
				}
				n.waitFor(wait)
			} else {
				n.waitFor(200 * time.Millisecond)
			}
		}
	}
	if once && lineError && done == 0 {
		return -1
	}
	return done
}

// waitFor sleeps until an event, a signal or the timeout.
func (n *node) waitFor(d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-n.wake:
	case <-t.C:
	}
}

// sleep waits d, but returns early once stop is set.
func (n *node) sleep(d time.Duration) {
	end := time.Now().Add(d)
	for !n.stop.Load() {
		left := time.Until(end)
		if left <= 0 {
			return
		}
		n.waitFor(left)
	}
}
