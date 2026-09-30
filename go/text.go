package main

// Text rules that must match the reference byte for byte: clean-up of a
// model answer (saeubern), the number check (zahlenPruefen), the stream cut
// (stromSchnitt) and the image filter (bilderAusAuftrag).
//
// The reference uses PCRE. Where a pattern carries the /u modifier PHP also
// switches on Unicode properties (PCRE2_UCP), so \s, \d and \b are Unicode
// aware there; without /u they are ASCII only. The helpers below reproduce
// exactly that split.

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// retrySuffix is appended to the prompt for the second attempt. German, as
// in the reference - the model sees it, the wire must not change.
const retrySuffix = "\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, " +
	"die nicht in den Quellen steht. Uebernimm Zahlen genau so, " +
	"wie sie dort stehen, oder lass sie weg."

// phpTrim is PHP's trim() with its default character set.
func phpTrim(s string) string { return strings.Trim(s, " \t\n\r\x00\x0b") }

// ucpSpace is \s under /u (PCRE2_UCP): \p{Z} plus \h and \v.
func ucpSpace(r rune) bool {
	switch r {
	case '\t', '\n', 0x0b, '\f', '\r', ' ', 0x85, 0xa0, 0x1680, 0x180e,
		0x2028, 0x2029, 0x202f, 0x205f, 0x3000:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// isNewline is \R.
func isNewline(r rune) bool {
	switch r {
	case '\n', 0x0b, '\f', '\r', 0x85, 0x2028, 0x2029:
		return true
	}
	return false
}

// ucpWord is \w under /u.
func ucpWord(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r) ||
		unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Pc, r)
}

var (
	reThink = regexp.MustCompile(`(?s)<think>.*?</think>`)
	reTag   = regexp.MustCompile(`<[^>]*>`)
	// /i without /u is ASCII-only case folding, hence the explicit classes.
	reLeadIn = regexp.MustCompile(`^[\t\n\v\f\r ]*(?:` +
		`[hH][iI][eE][rR] (?:[iI][sS][tT]|[sS][iI][nN][dD])[^:\n]*:|` +
		`[hH][eE][rR][eE] (?:[iI][sS]|[aA][rR][eE])[^:\n]*:|` +
		`[aA][nN][tT][wW][oO][rR][tT]:|` +
		`[aA][nN][sS][wW][eE][rR]:)[\t\n\v\f\r ]*`)
	reQuoted = regexp.MustCompile(`(?s)^["\x{201C}\x{201E}\x{00AB}](.*)["\x{201D}\x{201C}\x{00BB}]$`)
	reImage  = regexp.MustCompile(`^data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*\n?$`)
)

// cleanAnswer removes think blocks, markup and lead-ins (saeubern).
func cleanAnswer(text string) string {
	// PHP: a /u pattern on invalid UTF-8 returns null, and everything after
	// it works on "" - the answer ends up empty.
	if !utf8.ValidString(text) {
		return ""
	}
	t := reThink.ReplaceAllLiteralString(text, " ")
	t = reTag.ReplaceAllLiteralString(t, " ")
	// str_replace with an array works search by search, in this order.
	for _, s := range []string{"**", "__", "`", "#"} {
		t = strings.ReplaceAll(t, s, "")
	}
	t = phpTrim(t)
	t = reLeadIn.ReplaceAllLiteralString(t, "")
	t = phpTrim(t)
	if m := reQuoted.FindStringSubmatch(t); m != nil {
		t = phpTrim(m[1])
	}
	t = collapseSpace(t)
	return phpTrim(t)
}

// collapseSpace does preg_replace('/\s*\R\s*/u', ' ') followed by
// preg_replace('/\s{2,}/u', ' '): a whitespace run that contains a line
// break becomes one space, then any run of two or more becomes one space.
func collapseSpace(t string) string {
	var b strings.Builder
	rs := []rune(t)
	for i := 0; i < len(rs); {
		if !ucpSpace(rs[i]) {
			b.WriteRune(rs[i])
			i++
			continue
		}
		j, nl := i, false
		for j < len(rs) && ucpSpace(rs[j]) {
			nl = nl || isNewline(rs[j])
			j++
		}
		if nl || j-i >= 2 {
			b.WriteByte(' ')
		} else {
			b.WriteRune(rs[i])
		}
		i = j
	}
	return b.String()
}

func thousandsSep(r rune) bool {
	switch r {
	case ' ', '.', ',', 0xa0, 0x202f, 0x2009:
		return true
	}
	return false
}

// numberTokens reproduces $ziffern from zahlenPruefen: drop thousands
// separators between a digit and a group of exactly three digits, then
// collect the ASCII digit runs.
func numberTokens(s string) []string {
	if !utf8.ValidString(s) {
		return nil // preg_replace /u returns null -> no digits at all
	}
	rs := []rune(s)
	var b strings.Builder
	for i := 0; i < len(rs); {
		if i+4 < len(rs) && unicode.IsDigit(rs[i]) && thousandsSep(rs[i+1]) &&
			unicode.IsDigit(rs[i+2]) && unicode.IsDigit(rs[i+3]) && unicode.IsDigit(rs[i+4]) &&
			(i+5 == len(rs) || !ucpWord(rs[i+5])) {
			b.WriteRune(rs[i])
			i += 2
			continue
		}
		b.WriteRune(rs[i])
		i++
	}
	n := b.String()
	var out []string
	for i := 0; i < len(n); {
		if n[i] < '0' || n[i] > '9' {
			i++
			continue
		}
		j := i
		for j < len(n) && n[j] >= '0' && n[j] <= '9' {
			j++
		}
		out = append(out, n[i:j])
		i = j
	}
	return out
}

// checkNumbers returns the first digit sequence of text that does not
// occur in facts, or "" and false if all are covered (zahlenPruefen).
func checkNumbers(text, facts string) (string, bool) {
	allowed := map[string]bool{}
	for _, z := range numberTokens(facts) {
		allowed[z] = true
	}
	for _, z := range numberTokens(text) {
		if !allowed[z] {
			return z, true
		}
	}
	return "", false
}

// streamCut returns text up to and including its last whitespace, but never
// cuts at a space between digits ("1 000") (stromSchnitt). Byte based.
func streamCut(text string) string {
	isDigit := func(c byte) bool { return c >= '0' && c <= '9' }
	for i := len(text) - 1; i >= 0; i-- {
		c := text[i]
		if c != ' ' && c != '\n' && c != '\r' && c != '\t' {
			continue
		}
		if c == ' ' && i > 0 && isDigit(text[i-1]) && (i+1 == len(text) || isDigit(text[i+1])) {
			continue
		}
		return text[:i+1]
	}
	return ""
}

// imagesFromJob filters the images of a job (bilderAusAuftrag).
func imagesFromJob(raw any, enabled bool, max int64) []string {
	if !enabled || !isArray(raw) {
		return nil
	}
	if max < 0 {
		max = 0
	}
	var out []string
	for _, v := range values(raw) {
		if int64(len(out)) >= max {
			break
		}
		s, ok := v.(string)
		if !ok || len(s) > 4*1024*1024 || !reImage.MatchString(s) {
			continue
		}
		out = append(out, s)
	}
	return out
}

// containsFoldASCII is stripos($s, $sub) !== false.
func containsFoldASCII(s, sub string) bool {
	lower := func(x string) string {
		b := []byte(x)
		for i, c := range b {
			if c >= 'A' && c <= 'Z' {
				b[i] = c + 32
			}
		}
		return string(b)
	}
	return strings.Contains(lower(s), lower(sub))
}

// firstRunes is mb_substr($s, 0, n).
func firstRunes(s string, n int) string {
	i := 0
	for k := range s {
		if i == n {
			return s[:k]
		}
		i++
	}
	return s
}
