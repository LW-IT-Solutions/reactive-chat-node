package main

import (
	"strings"
	"testing"
)

func TestRawURLEncode(t *testing.T) {
	cases := map[string]string{
		"kn-0123abc":      "kn-0123abc",
		"chat,einbettung": "chat%2Ceinbettung",
		"a b~c_d.e":       "a%20b~c_d.e",
	}
	for in, want := range cases {
		if got := rawURLEncode(in); got != want {
			t.Errorf("rawURLEncode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSplitURL(t *testing.T) {
	cases := []struct{ in, path, query string }{
		{"https://reactive.chat/v1/ki?action=hol&n=1", "/v1/ki", "action=hol&n=1"},
		{"http://127.0.0.1:8080/sub/v1/ki?action=bring&knoten=kn-1", "/sub/v1/ki", "action=bring&knoten=kn-1"},
		{"https://x.test", "/", ""},
	}
	for _, c := range cases {
		p, q := splitURL(c.in)
		if p != c.path || q != c.query {
			t.Errorf("splitURL(%q) = %q %q, want %q %q", c.in, p, q, c.path, c.query)
		}
	}
}

func TestPHPJSON(t *testing.T) {
	bs := `\`
	ae := string(rune(0xe4))
	// json_encode("x/<ae><U+2028><0x01>\"\\", JSON_UNESCAPED_UNICODE)
	w := &jsonWriter{escapeSlash: true}
	w.str("x/" + ae + string(rune(0x2028)) + "\x01\"\\")
	if got, want := string(w.bytes()), `"x\/`+ae+bs+`u2028`+bs+`u0001\"\\"`; got != want {
		t.Errorf("unescaped unicode: got %s want %s", got, want)
	}
	if got := rawURLEncode(ae + "/"); got != "%C3%A4%2F" {
		t.Errorf("rawURLEncode: %s", got)
	}
	w = &jsonWriter{escapeUnicode: true}
	w.str("a/" + ae + string(rune(0x1F600)))
	if got, want := string(w.bytes()), `"a/`+bs+`u00e4`+bs+`ud83d`+bs+`ude00"`; got != want {
		t.Errorf("escaped unicode: got %s want %s", got, want)
	}
	for f, want := range map[float64]string{0.2: "0.2", 1: "1.0", 0: "0.0", 1e-7: "1.0e-7", 0.75: "0.75"} {
		if got := phpFloatFormat(f, true); got != want {
			t.Errorf("float %v: got %s want %s", f, got, want)
		}
	}
}

func TestBodies(t *testing.T) {
	got := string(resultsBody([]result{{id: 7, text: "", reason: "Modell HTTP 500: x", ms: 12}}, "m/1", "kn-1"))
	want := `{"ergebnisse":[{"id":7,"text":"","grund":"Modell HTTP 500: x","modell":"m\/1","ms":12,"knoten":"kn-1"}]}`
	if got != want {
		t.Errorf("bring body:\n got %s\nwant %s", got, want)
	}
	got = string(chatBody("m", true, 0.2, 300, "S", "P", []string{"data:image/png;base64,AA=="}))
	want = `{"model":"m","stream":true,"temperature":0.2,"max_tokens":300,"messages":[{"role":"system","content":"S"},` +
		`{"role":"user","content":[{"type":"text","text":"P"},{"type":"image_url","image_url":{"url":"data:image\/png;base64,AA=="}}]}]}`
	if got != want {
		t.Errorf("chat body:\n got %s\nwant %s", got, want)
	}
	got = string(partsBody([]part{{id: 3, n: 2, text: "Hallo "}}))
	if want = `{"teile":[{"id":3,"n":2,"text":"Hallo "}]}`; got != want {
		t.Errorf("teil body: got %s want %s", got, want)
	}
}

func TestConfig(t *testing.T) {
	base := `"base_url":"http://127.0.0.1:1","node_id":"kn-1","secret":"rcn_x","model":"m","model_endpoint":"http://127.0.0.1:2/v1"`
	c, err := parseConfig([]byte(`{` + base + `,"kinds":["chat","translation"],"future_key":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(c.Kinds, ",") != "chat,uebersetzung" || strings.Join(c.Capabilities, ",") != "chat,uebersetzung" {
		t.Errorf("kinds %v capabilities %v", c.Kinds, c.Capabilities)
	}
	if c.PollWait != 20 || c.StreamMs != 400 || !c.Stream || !c.TLSVerify || c.Temperature != 0.2 {
		t.Errorf("defaults wrong: %+v", c)
	}
	for _, bad := range []string{
		`{"node_id":"kn-1","secret":"s","model":"m","model_endpoint":"x"}`,
		`{` + strings.Replace(base, `"kn-1"`, `"node-1"`, 1) + `}`,
		`{` + base + `,"kinds":["embedding"]}`,
		`{` + base + `,"concurrency":"many"}`,
		`[1]`,
	} {
		if _, err := parseConfig([]byte(bad)); err == nil {
			t.Errorf("accepted bad config %s", bad)
		}
	}
	m, err := parseResolve("reactive.chat:443:192.0.2.7")
	if err != nil || m["reactive.chat:443"][0] != "192.0.2.7" {
		t.Errorf("resolve: %v %v", m, err)
	}
}
