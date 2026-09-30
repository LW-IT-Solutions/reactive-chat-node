package main

// HTTP plumbing: the signed line to reactive.chat and the plain line to the
// model server.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// maxBody caps a non-streamed response body held in memory.
const maxBody = 64 * 1024 * 1024

// rawURLEncode is PHP's rawurlencode (RFC 3986: only A-Z a-z 0-9 - _ . ~
// stay as they are).
func rawURLEncode(s string) string {
	const hexU = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexU[c>>4])
		b.WriteByte(hexU[c&15])
	}
	return b.String()
}

// sign computes X-RC-KI-SIG: HMAC-SHA256 (hex) over
// "RC-KI-v2\n" + ts + "\n" + method + "\n" + path + "\n" + query + "\n" + body.
func sign(secret, ts, method, path, query, body string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("RC-KI-v2\n" + ts + "\n" + method + "\n" + path + "\n" + query + "\n" + body))
	return hex.EncodeToString(m.Sum(nil))
}

// splitURL returns path and query of u as PHP's parse_url() sees them,
// without any decoding, so the signed bytes are the sent bytes.
func splitURL(u string) (path, query string) {
	rest := u
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
		j := strings.IndexAny(rest, "/?#")
		if j < 0 {
			return "/", ""
		}
		rest = rest[j:]
	}
	if i := strings.IndexByte(rest, '#'); i >= 0 {
		rest = rest[:i]
	}
	path, query, _ = strings.Cut(rest, "?")
	if path == "" {
		path = "/"
	}
	return path, query
}

func newNonce() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("no randomness: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

type ctxKey int

const connectTimeoutKey ctxKey = 1

// dialer honours a per-request connect timeout and the optional fixed
// resolution host:port:ip (curl --resolve).
type dialer struct {
	fixed map[string][]string // "host:port" (lower case) -> addresses
}

func (d *dialer) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	timeout := 15 * time.Second
	if t, ok := ctx.Value(connectTimeoutKey).(time.Duration); ok {
		timeout = t
	}
	nd := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	targets := d.fixed[strings.ToLower(addr)]
	if len(targets) == 0 {
		return nd.DialContext(ctx, network, addr)
	}
	_, port, _ := net.SplitHostPort(addr)
	var lastErr error
	for _, ip := range targets {
		c, err := nd.DialContext(ctx, network, net.JoinHostPort(ip, port))
		if err == nil {
			return c, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// parseResolve reads "host:port:addr[,addr...]" like curl's CURLOPT_RESOLVE.
func parseResolve(s string) (map[string][]string, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "+")
	host, rest, ok1 := strings.Cut(s, ":")
	port, addrs, ok2 := strings.Cut(rest, ":")
	if !ok1 || !ok2 || host == "" || addrs == "" {
		return nil, errors.New("'resolve' must look like host:port:ip")
	}
	if _, err := strconv.Atoi(port); err != nil {
		return nil, errors.New("'resolve': port must be a number")
	}
	var list []string
	for _, a := range strings.Split(addrs, ",") {
		a = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(a), "["), "]")
		if net.ParseIP(a) == nil {
			return nil, fmt.Errorf("'resolve': %q is not an IP address", a)
		}
		list = append(list, a)
	}
	return map[string][]string{strings.ToLower(net.JoinHostPort(host, port)): list}, nil
}

func newClient(fixed map[string][]string, verifyTLS bool) *http.Client {
	d := &dialer{fixed: fixed}
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           d.dial,
		ForceAttemptHTTP2:     true,
		DisableCompression:    true, // curl sends no Accept-Encoding either
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	if !verifyTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // explicit opt-out (tls_verify=false)
	}
	return &http.Client{
		Transport: tr,
		// curl does not follow redirects unless told to; neither do we.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// response is the outcome of one HTTP call. err is "" when the call
// completed (whatever the status code); code is 0 on a transport error.
type response struct {
	code int
	body []byte
	err  string
}

type request struct {
	method  string
	url     string
	headers [][2]string // written with exactly this spelling
	body    []byte      // nil = no body
	basic   string      // "user:password" or ""
	timeout time.Duration
	connect time.Duration
	sink    func([]byte) // streaming: receives the body instead of response.body
}

func (c *nodeHTTP) do(r request) response {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), r.timeout)
	defer cancel()
	ctx = context.WithValue(ctx, connectTimeoutKey, r.connect)
	var body io.Reader
	if r.body != nil {
		body = bytes.NewReader(r.body)
	}
	req, err := http.NewRequestWithContext(ctx, r.method, r.url, body)
	if err != nil {
		return response{err: errorText(err, ctx, start)}
	}
	req.Header = http.Header{}
	req.Header["User-Agent"] = []string{""} // curl sends none unless told to
	req.Header["Accept"] = []string{"*/*"}
	for _, h := range r.headers {
		req.Header[h[0]] = []string{h[1]}
	}
	if r.basic != "" {
		user, pass, _ := strings.Cut(r.basic, ":")
		req.SetBasicAuth(user, pass)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return response{err: errorText(err, ctx, start)}
	}
	defer resp.Body.Close()
	out := response{code: resp.StatusCode}
	if r.sink != nil {
		buf := make([]byte, 32*1024)
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				r.sink(buf[:n])
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				out.err = errorText(rerr, ctx, start)
				break
			}
		}
		return out
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		out.err = errorText(err, ctx, start)
		return out
	}
	if len(data) > maxBody {
		out.err = "response larger than 64 MB"
		return out
	}
	out.body = data
	return out
}

// errorText turns a Go error into a short message without the URL (the
// URL of an Azure deployment or a staging site stays out of logs and of
// the reasons sent to reactive.chat).
func errorText(err error, ctx context.Context, start time.Time) string {
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Sprintf("Operation timed out after %d milliseconds", time.Since(start).Milliseconds())
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	msg := err.Error()
	if msg == "" {
		msg = "request failed"
	}
	return msg
}

// nodeHTTP holds the two clients: one for reactive.chat (resolve,
// tls_verify, basic auth apply there, as in the reference) and one for the
// model server.
type nodeHTTP struct {
	client *http.Client
}
