package main

// JSON helpers that reproduce what the PHP reference does on the wire:
//
//   - decoding keeps object key order (PHP arrays are ordered) and numbers
//     as json.Number, so casts like (int)$x and (string)$x can be emulated;
//   - encoding writes exactly what json_encode() writes, including "\/" for
//     slashes and the JSON_UNESCAPED_UNICODE behaviour.

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// object is a decoded JSON object with its key order preserved.
type object struct {
	keys []string
	m    map[string]any
}

func (o *object) set(k string, v any) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v // duplicate key: last value wins, first position stays (as PHP)
}

// decodeJSON decodes like json_decode($s, true). ok is false where PHP
// would return null because of a syntax error.
func decodeJSON(data []byte) (v any, ok bool) {
	if !utf8.Valid(data) {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, false // trailing garbage
	}
	return v, true
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := &object{m: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				o.set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			list := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return list, nil
		}
		return nil, io.ErrUnexpectedEOF
	default:
		return t, nil // nil, bool, json.Number, string
	}
}

// isArray reports whether v is what PHP calls an array (list or object).
func isArray(v any) bool {
	switch v.(type) {
	case []any, *object:
		return true
	}
	return false
}

// get is $v[$key] with isset semantics for the "exists" part: it returns
// (nil, false) when v is not an array or has no such key.
func get(v any, key string) (any, bool) {
	switch a := v.(type) {
	case *object:
		x, ok := a.m[key]
		return x, ok
	case []any:
		i, err := strconv.Atoi(key)
		if err != nil || i < 0 || i >= len(a) || strconv.Itoa(i) != key {
			return nil, false
		}
		return a[i], true
	}
	return nil, false
}

// isset is isset($v[$key]).
func isset(v any, key string) bool {
	x, ok := get(v, key)
	return ok && x != nil
}

// path walks $v[k1][k2]... and returns nil if any step is missing.
func path(v any, keys ...string) any {
	for _, k := range keys {
		x, ok := get(v, k)
		if !ok {
			return nil
		}
		v = x
	}
	return v
}

// values is array_values((array)$v).
func values(v any) []any {
	switch a := v.(type) {
	case nil:
		return nil
	case []any:
		return a
	case *object:
		out := make([]any, 0, len(a.keys))
		for _, k := range a.keys {
			out = append(out, a.m[k])
		}
		return out
	}
	return []any{v}
}

// truthy is !empty($v).
func truthy(v any) bool {
	switch a := v.(type) {
	case nil:
		return false
	case bool:
		return a
	case json.Number:
		f, err := strconv.ParseFloat(string(a), 64)
		return err != nil || f != 0
	case string:
		return a != "" && a != "0"
	case []any:
		return len(a) > 0
	case *object:
		return len(a.keys) > 0
	}
	return true
}

// numericPrefix parses the leading numeric part of s the way PHP casts a
// string to a number ("12abc" -> 12, " 1e3" -> 1000, "abc" -> 0).
func numericPrefix(s string) float64 {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	end := 0
	seenDigit, seenDot, seenExp := false, false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
			end = i + 1
		case (c == '+' || c == '-') && i == 0:
		case c == '.' && !seenDot && !seenExp:
			seenDot = true
			if seenDigit {
				end = i + 1
			}
		case (c == 'e' || c == 'E') && seenDigit && !seenExp:
			// only valid if digits follow (optionally signed)
			j := i + 1
			if j < len(s) && (s[j] == '+' || s[j] == '-') {
				j++
			}
			if j < len(s) && s[j] >= '0' && s[j] <= '9' {
				seenExp = true
				i = j - 1
				continue
			}
			i = len(s)
		default:
			i = len(s)
		}
	}
	if end == 0 {
		return 0
	}
	f, _ := strconv.ParseFloat(strings.TrimSuffix(s[:end], "."), 64)
	return f
}

func floatToInt(f float64) int64 {
	if math.IsNaN(f) || math.IsInf(f, 0) || f >= 9.2e18 || f <= -9.2e18 {
		return 0
	}
	return int64(f)
}

// toInt is (int)$v.
func toInt(v any) int64 {
	switch a := v.(type) {
	case nil:
		return 0
	case bool:
		if a {
			return 1
		}
		return 0
	case json.Number:
		if i, err := strconv.ParseInt(string(a), 10, 64); err == nil {
			return i
		}
		f, _ := strconv.ParseFloat(string(a), 64)
		return floatToInt(f)
	case string:
		s := strings.TrimLeft(a, " \t\n\r\v\f")
		// plain integer strings keep full int64 precision
		j := 0
		if j < len(s) && (s[j] == '+' || s[j] == '-') {
			j++
		}
		k := j
		for k < len(s) && s[k] >= '0' && s[k] <= '9' {
			k++
		}
		if k > j && (k == len(s) || (s[k] != '.' && s[k] != 'e' && s[k] != 'E')) {
			if i, err := strconv.ParseInt(s[:k], 10, 64); err == nil {
				return i
			}
		}
		return floatToInt(numericPrefix(a))
	case []any:
		if len(a) > 0 {
			return 1
		}
		return 0
	case *object:
		if len(a.keys) > 0 {
			return 1
		}
		return 0
	}
	return 0
}

// toFloat is (float)$v.
func toFloat(v any) float64 {
	switch a := v.(type) {
	case json.Number:
		f, _ := strconv.ParseFloat(string(a), 64) // out of range gives +-Inf like PHP
		return f
	case string:
		return numericPrefix(a)
	case bool, nil, []any, *object:
		return float64(toInt(a))
	}
	return 0
}

// toString is (string)$v.
func toString(v any) string {
	switch a := v.(type) {
	case nil:
		return ""
	case bool:
		if a {
			return "1"
		}
		return ""
	case string:
		return a
	case json.Number:
		s := string(a)
		if _, err := strconv.ParseInt(s, 10, 64); err == nil {
			return s
		}
		f, _ := strconv.ParseFloat(s, 64)
		return phpFloatString(f)
	case []any, *object:
		return "Array"
	}
	return ""
}

// phpFloatString is (string)$float in PHP 8 (serialize_precision -1).
func phpFloatString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NAN"
	case math.IsInf(f, 1):
		return "INF"
	case math.IsInf(f, -1):
		return "-INF"
	}
	return phpFloatFormat(f, false)
}

// phpFloatFormat formats like zend_gcvt with precision 17 / mode 0: plain
// decimal for exponents -5 < e < 15, else scientific ("1.0E+25").
// json=true gives the json_encode flavour ("1.0" for integral values,
// lower-case "e").
func phpFloatFormat(f float64, jsonStyle bool) string {
	if f == 0 {
		if jsonStyle {
			if math.Signbit(f) {
				return "-0.0"
			}
			return "0.0"
		}
		if math.Signbit(f) {
			return "-0"
		}
		return "0"
	}
	exp := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde+XX
	mant, ex, _ := strings.Cut(exp, "e")
	e, _ := strconv.Atoi(ex)
	if e < -4 || e >= 15 {
		if !strings.Contains(mant, ".") {
			mant += ".0"
		}
		sign := "+"
		if e < 0 {
			sign = "-"
			e = -e
		}
		E := "E"
		if jsonStyle {
			E = "e"
		}
		return mant + E + sign + strconv.Itoa(e)
	}
	s := strconv.FormatFloat(f, 'f', -1, 64)
	if jsonStyle && !strings.Contains(s, ".") {
		s += ".0"
	}
	return s
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

// jsonWriter builds JSON text byte-identical to PHP's json_encode().
type jsonWriter struct {
	b bytes.Buffer
	// escapeSlash: "/" -> "\/" (json_encode default, off with JSON_UNESCAPED_SLASHES)
	escapeSlash bool
	// escapeUnicode: non-ASCII -> \uXXXX (default, off with JSON_UNESCAPED_UNICODE)
	escapeUnicode bool
}

const hexDigits = "0123456789abcdef"

func (w *jsonWriter) u4(r rune) {
	w.b.WriteString(`\u`)
	w.b.WriteByte(hexDigits[r>>12&0xf])
	w.b.WriteByte(hexDigits[r>>8&0xf])
	w.b.WriteByte(hexDigits[r>>4&0xf])
	w.b.WriteByte(hexDigits[r&0xf])
}

func (w *jsonWriter) str(s string) {
	w.b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size <= 1 {
			// invalid UTF-8: substitute U+FFFD (JSON_INVALID_UTF8_SUBSTITUTE)
			if w.escapeUnicode {
				w.u4(0xfffd)
			} else {
				w.b.WriteRune(0xfffd)
			}
			i++
			continue
		}
		switch {
		case r == '"':
			w.b.WriteString(`\"`)
		case r == '\\':
			w.b.WriteString(`\\`)
		case r == '/':
			if w.escapeSlash {
				w.b.WriteString(`\/`)
			} else {
				w.b.WriteByte('/')
			}
		case r == '\b':
			w.b.WriteString(`\b`)
		case r == '\f':
			w.b.WriteString(`\f`)
		case r == '\n':
			w.b.WriteString(`\n`)
		case r == '\r':
			w.b.WriteString(`\r`)
		case r == '\t':
			w.b.WriteString(`\t`)
		case r < 0x20:
			w.u4(r)
		case r < 0x80:
			w.b.WriteByte(byte(r))
		case w.escapeUnicode || r == 0x2028 || r == 0x2029:
			if r >= 0x10000 {
				r -= 0x10000
				w.u4(0xd800 + (r >> 10))
				w.u4(0xdc00 + (r & 0x3ff))
			} else {
				w.u4(r)
			}
		default:
			w.b.WriteString(s[i : i+size])
		}
		i += size
	}
	w.b.WriteByte('"')
}

func (w *jsonWriter) raw(s string)    { w.b.WriteString(s) }
func (w *jsonWriter) int(i int64)     { w.b.WriteString(strconv.FormatInt(i, 10)) }
func (w *jsonWriter) float(f float64) { w.b.WriteString(phpFloatFormat(f, true)) }
func (w *jsonWriter) key(k string)    { w.str(k); w.b.WriteByte(':') }
func (w *jsonWriter) comma(first *bool) {
	if !*first {
		w.b.WriteByte(',')
	}
	*first = false
}
func (w *jsonWriter) bool(v bool) {
	if v {
		w.b.WriteString("true")
	} else {
		w.b.WriteString("false")
	}
}
func (w *jsonWriter) bytes() []byte { return w.b.Bytes() }
