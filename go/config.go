package main

// Configuration: rc-node.json (flat JSON object, English keys, see
// ../CONTRACT.md), environment overrides and validation.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	BaseURL        string
	NodeID         string
	Secret         string
	Model          string
	ModelEndpoint  string
	ChatURL        string
	ModelAPIKey    string
	ModelKeyHeader string
	Kinds          []string
	Capabilities   []string
	EmbedURL       string
	EmbedModel     string
	EmbedTimeout   int64
	Images         bool
	ImagesMax      int64
	Stream         bool
	StreamMs       int64
	Concurrency    int64
	PollWait       int64
	Timeout        int64
	Temperature    float64
	MaxTokens      int64
	BasicAuth      string
	Resolve        string
	TLSVerify      bool
	LogFile        string
	Timezone       string

	resolveMap map[string][]string
	location   *time.Location
}

// configError is a configuration problem: exit code 2.
type configError struct{ msg string }

func (e configError) Error() string { return e.msg }

func cfgErr(format string, a ...any) error { return configError{fmt.Sprintf(format, a...)} }

// kindAliases maps the English kind names to the wire names.
var kindAliases = map[string]string{
	"translation": "uebersetzung",
	"summary":     "zusammenfassung",
	"embedding":   "einbettung",
}

func configPath(flag string) string {
	if flag != "" {
		return flag
	}
	if p := os.Getenv("RC_NODE_CONFIG"); p != "" {
		return p
	}
	return "rc-node.json"
}

func loadConfig(path string) (*config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, cfgErr("cannot read config file %s (%v) - copy rc-node.example.json, fill it in and chmod 600 it", path, errText(err))
	}
	return parseConfig(data)
}

func errText(err error) string {
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err.Error()
	}
	return err.Error()
}

func parseConfig(data []byte) (*config, error) {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil || raw == nil {
		if err == nil {
			err = fmt.Errorf("not an object")
		}
		return nil, cfgErr("config file is not a valid JSON object: %v", err)
	}
	c := &config{
		ModelKeyHeader: "Authorization",
		Kinds:          []string{"chat"},
		EmbedTimeout:   120,
		ImagesMax:      1,
		Stream:         true,
		StreamMs:       400,
		Concurrency:    1,
		PollWait:       20,
		Timeout:        120,
		Temperature:    0.2,
		MaxTokens:      300,
		TLSVerify:      true,
	}
	p := &parser{raw: raw}
	p.str("base_url", &c.BaseURL)
	p.str("node_id", &c.NodeID)
	p.str("secret", &c.Secret)
	p.str("model", &c.Model)
	p.str("model_endpoint", &c.ModelEndpoint)
	p.str("chat_url", &c.ChatURL)
	p.str("model_api_key", &c.ModelAPIKey)
	p.str("model_key_header", &c.ModelKeyHeader)
	p.list("kinds", &c.Kinds)
	p.list("capabilities", &c.Capabilities)
	p.str("embed_url", &c.EmbedURL)
	p.str("embed_model", &c.EmbedModel)
	p.int("embed_timeout", &c.EmbedTimeout)
	p.bool("images", &c.Images)
	p.int("images_max", &c.ImagesMax)
	p.bool("stream", &c.Stream)
	p.int("stream_ms", &c.StreamMs)
	p.int("concurrency", &c.Concurrency)
	p.int("poll_wait", &c.PollWait)
	p.int("timeout", &c.Timeout)
	p.float("temperature", &c.Temperature)
	p.int("max_tokens", &c.MaxTokens)
	p.str("basic_auth", &c.BasicAuth)
	p.str("resolve", &c.Resolve)
	p.bool("tls_verify", &c.TLSVerify)
	p.str("log_file", &c.LogFile)
	p.str("timezone", &c.Timezone)
	if p.err != nil {
		return nil, p.err
	}

	if v := os.Getenv("RC_NODE_SECRET"); v != "" {
		c.Secret = v
	}
	if v := os.Getenv("RC_NODE_MODEL_API_KEY"); v != "" {
		c.ModelAPIKey = v
	}

	for _, k := range [][2]string{{"base_url", c.BaseURL}, {"node_id", c.NodeID}, {"secret", c.Secret}, {"model", c.Model}} {
		if k[1] == "" {
			return nil, cfgErr("the configuration lacks '%s'", k[0])
		}
	}
	if c.ModelEndpoint == "" && c.ChatURL == "" {
		return nil, cfgErr("the configuration lacks 'model_endpoint' (or 'chat_url' for Azure)")
	}
	if !strings.HasPrefix(c.NodeID, "kn-") {
		return nil, cfgErr("'node_id' must start with kn- - exactly as the customer area shows it")
	}
	c.Kinds = mapKinds(c.Kinds)
	c.Capabilities = mapKinds(c.Capabilities)
	if len(c.Capabilities) == 0 {
		c.Capabilities = c.Kinds
	}
	if contains(c.Kinds, "einbettung") && (c.EmbedURL == "" || c.EmbedModel == "") {
		return nil, cfgErr("'kinds' contains 'einbettung' - that needs 'embed_url' and 'embed_model'")
	}
	if c.Resolve != "" {
		m, err := parseResolve(c.Resolve)
		if err != nil {
			return nil, cfgErr("%v", err)
		}
		c.resolveMap = m
	}
	c.location = time.Local
	if c.Timezone != "" {
		// Like the reference: an unknown zone silently keeps the system zone.
		if loc, err := time.LoadLocation(c.Timezone); err == nil {
			c.location = loc
		}
	}
	return c, nil
}

func mapKinds(in []string) []string {
	out := make([]string, 0, len(in))
	for _, k := range in {
		if w, ok := kindAliases[k]; ok {
			k = w
		}
		out = append(out, k)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// parser reads typed values out of the raw JSON object; the first type
// error wins. null means "use the default".
type parser struct {
	raw map[string]json.RawMessage
	err error
}

func (p *parser) value(key string) (any, bool) {
	r, ok := p.raw[key]
	if !ok || p.err != nil {
		return nil, false
	}
	v, ok := decodeJSON(r)
	if !ok || v == nil {
		return nil, false
	}
	return v, true
}

func (p *parser) fail(key, want string) {
	if p.err == nil {
		p.err = cfgErr("config key '%s' must be %s", key, want)
	}
}

func (p *parser) str(key string, dst *string) {
	v, ok := p.value(key)
	if !ok {
		return
	}
	switch a := v.(type) {
	case string:
		*dst = a
	case json.Number:
		*dst = string(a)
	default:
		p.fail(key, "a string")
	}
}

func (p *parser) list(key string, dst *[]string) {
	v, ok := p.value(key)
	if !ok {
		return
	}
	if s, isStr := v.(string); isStr {
		*dst = []string{s}
		return
	}
	l, isList := v.([]any)
	if !isList {
		p.fail(key, "a list of strings")
		return
	}
	out := []string{}
	for _, x := range l {
		s, ok := x.(string)
		if !ok {
			p.fail(key, "a list of strings")
			return
		}
		out = append(out, s)
	}
	*dst = out
}

func (p *parser) bool(key string, dst *bool) {
	v, ok := p.value(key)
	if !ok {
		return
	}
	switch a := v.(type) {
	case bool:
		*dst = a
	case json.Number:
		*dst = truthy(a)
	default:
		p.fail(key, "true or false")
	}
}

func (p *parser) int(key string, dst *int64) {
	v, ok := p.value(key)
	if !ok {
		return
	}
	switch a := v.(type) {
	case json.Number:
		*dst = toInt(a)
	case string:
		if _, err := strconv.ParseFloat(strings.TrimSpace(a), 64); err != nil {
			p.fail(key, "a number")
			return
		}
		*dst = toInt(a)
	default:
		p.fail(key, "a number")
	}
}

func (p *parser) float(key string, dst *float64) {
	v, ok := p.value(key)
	if !ok {
		return
	}
	var f float64
	switch a := v.(type) {
	case json.Number:
		f = toFloat(a)
	case string:
		x, err := strconv.ParseFloat(strings.TrimSpace(a), 64)
		if err != nil {
			p.fail(key, "a number")
			return
		}
		f = x
	default:
		p.fail(key, "a number")
		return
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		p.fail(key, "a finite number")
		return
	}
	*dst = f
}
