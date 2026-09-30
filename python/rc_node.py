#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
rc-node (Python) - the reactive.chat "bring your own model" AI node.

This program runs on YOUR machine. It fetches the AI jobs of your workspace
from reactive.chat, lets YOUR language model (any OpenAI-compatible server:
vLLM, Ollama /v1, LM Studio, llama.cpp, Azure OpenAI) answer them and
delivers the answers back. reactive.chat never connects to your machine -
the node calls out, never the other way round. It needs no public address,
no open port and no fixed IP.

    rc-node [--config=PATH] [--probe | --once | --one | --daemon]

Standard library only, Python 3.9 or newer. Runs as a single file
(`python3 rc_node.py`) or installed (`rc-node`). Configuration: rc-node.json,
see ../CONTRACT.md and ../rc-node.example.json. Behavioural reference:
reference/rc-knoten.php v1.3 - the wire format (German JSON field names and
German reason strings) is byte-compatible with it.

Signature: every request carries an HMAC-SHA256 with your node secret over
"RC-KI-v2\\n" + ts + "\\n" + method + "\\n" + path + "\\n" + query + "\\n" +
body, plus a random nonce in the query. A signature is valid for five minutes
and exactly once, so this machine's clock must be right (NTP).
"""

from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import http.client
import json
import os
import queue
import re
import secrets
import signal
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.parse
from datetime import datetime

VERSION = "2.0.0"
USER_AGENT = "rc-node-python/" + VERSION

# The exact German retry suffix of the reference (wire relevant: it is part of
# the prompt the model sees on the second attempt).
RETRY_SUFFIX = ("\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, "
                "die nicht in den Quellen steht. Uebernimm Zahlen genau so, "
                "wie sie dort stehen, oder lass sie weg.")

HEARTBEAT_S = 45          # report even when all slots are busy
PART_MAX_ENTRIES = 8      # at most 8 entries per `teil` call
PART_MAX_BYTES = 16000    # longer text -> no more parts for that job
IMAGE_MAX_BYTES = 4 * 1024 * 1024
RAW_CAPTURE_MAX = 4 * 1024 * 1024

PROBE_SYSTEM = "Antworte mit genau einem Wort."
PROBE_PROMPT = "Sag: Bereit"
PROBE_MAX_TOKENS = 20

KIND_ALIASES = {"translation": "uebersetzung", "summary": "zusammenfassung",
                "embedding": "einbettung"}

USAGE = """usage: rc-node [--config=PATH] [--probe | --once | --one | --daemon]

  --probe    check reactive.chat and the model server, take no job
  --once     one fetch cycle, then exit (default)
  --one      like --once with a single slot; prints SYSTEM/PROMPT of each job
  --daemon   run until SIGTERM/SIGINT, then finish running jobs and exit

Config: --config=PATH, else $RC_NODE_CONFIG, else ./rc-node.json
"""

# ---------------------------------------------------------------------------
# PHP compatibility helpers (the reference is PHP; these reproduce its casts)
# ---------------------------------------------------------------------------
_BS = "\\"
_LS = "\N{LINE SEPARATOR}"
_PS = "\N{PARAGRAPH SEPARATOR}"
_SURROGATE_RE = re.compile("[" + chr(0xD800) + "-" + chr(0xDFFF) + "]")
_PHP_TRIM = " \t\n\r\0\x0b"
_PHP_NUM_RE = re.compile(r"[ \t\n\r\x0b\f]*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
INT_MAX = 2 ** 63 - 1


def php_trim(s):
    """PHP trim(): strips only space, \\t, \\n, \\r, \\0 and \\x0B."""
    return s.strip(_PHP_TRIM)


def php_truthy(v):
    """PHP !empty()."""
    if v is None or v is False:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v not in ("", "0")
    if isinstance(v, (list, dict)):
        return len(v) > 0
    return True


def php_int(v):
    """PHP (int) cast."""
    if v is None or v is False:
        return 0
    if v is True:
        return 1
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return 0
        return max(-INT_MAX - 1, min(INT_MAX, int(v)))
    if isinstance(v, str):
        m = _PHP_NUM_RE.match(v)
        if not m:
            return 0
        num = m.group(1)
        if re.fullmatch(r"[+-]?[0-9]+", num):
            return max(-INT_MAX - 1, min(INT_MAX, int(num)))
        return php_int(float(num))
    if isinstance(v, (list, dict)):
        return 1 if v else 0
    return 0


def php_float(v):
    """PHP (float) cast."""
    if v is None or v is False:
        return 0.0
    if v is True:
        return 1.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = _PHP_NUM_RE.match(v)
        return float(m.group(1)) if m else 0.0
    if isinstance(v, (list, dict)):
        return 1.0 if v else 0.0
    return 0.0


def php_str(v):
    """PHP (string) cast / strval()."""
    if v is None or v is False:
        return ""
    if v is True:
        return "1"
    if isinstance(v, str):
        return v
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return "NAN"
        if v in (float("inf"), float("-inf")):
            return "INF" if v > 0 else "-INF"
        if v == 0:
            return "-0" if str(v).startswith("-") else "0"
        s = "%.14G" % v
        if "E" in s:
            mant, exp = s.split("E")
            if "." not in mant:
                mant += ".0"
            e = int(exp)
            s = mant + "E" + ("+" if e >= 0 else "-") + str(abs(e))
        return s
    if isinstance(v, (list, dict)):
        return "Array"
    return str(v)


def php_array(v):
    """PHP (array) cast, as a list of values."""
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return list(v.values())
    return [v]


def php_get(container, key):
    """$container[$key] ?? null for a decoded JSON value (PHP array semantics)."""
    if isinstance(container, dict):
        return container.get(str(key))
    if isinstance(container, list):
        if isinstance(key, int):
            idx = key
        elif isinstance(key, str) and re.fullmatch(r"-?[1-9][0-9]*|0", key):
            idx = int(key)
        else:
            return None
        if 0 <= idx < len(container):
            return container[idx]
    return None


def _reject_constant(name):
    raise ValueError("invalid JSON constant " + name)


def php_json_decode(data):
    """json_decode($data, true): None for anything PHP would reject."""
    if isinstance(data, (bytes, bytearray)):
        try:
            data = bytes(data).decode("utf-8")
        except UnicodeDecodeError:
            return None
    if data.strip(" \t\n\r") == "":
        return None
    try:
        value = json.loads(data, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return None
    if "\\u" in data and _has_lone_surrogate(value):
        return None
    return value


def _has_lone_surrogate(v):
    if isinstance(v, str):
        return _SURROGATE_RE.search(v) is not None
    if isinstance(v, list):
        return any(_has_lone_surrogate(x) for x in v)
    if isinstance(v, dict):
        return any(_has_lone_surrogate(k) or _has_lone_surrogate(x) for k, x in v.items())
    return False


def php_json_encode(value, unescaped_unicode=True, unescaped_slashes=False):
    """json_encode() with JSON_UNESCAPED_UNICODE / JSON_UNESCAPED_SLASHES."""
    s = json.dumps(value, ensure_ascii=not unescaped_unicode, separators=(",", ":"),
                   allow_nan=False)
    if not unescaped_slashes:
        s = s.replace("/", _BS + "/")
    if unescaped_unicode:
        # PHP escapes U+2028/U+2029 unless JSON_UNESCAPED_LINE_TERMINATORS.
        s = s.replace(_LS, _BS + "u2028").replace(_PS, _BS + "u2029")
    return s


def rawurlencode(s):
    """PHP rawurlencode() (RFC 3986)."""
    return urllib.parse.quote(s, safe="-_.~")


def ms_since(t0, t1=None):
    d = ((time.monotonic() if t1 is None else t1) - t0) * 1000.0
    return int(d + 0.5)


# ---------------------------------------------------------------------------
# Pure functions of the reference (tested against conformance/vectors.json)
# ---------------------------------------------------------------------------
def signature(secret, ts, method, path, query, body):
    """HMAC-SHA256 hex over RC-KI-v2\\n ts \\n method \\n path \\n query \\n body."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    msg = ("RC-KI-v2\n" + ts + "\n" + method + "\n" + path + "\n" + query + "\n").encode("utf-8") + (body or b"")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


# /u patterns are Unicode aware in PCRE (UCP): \s includes NBSP etc.
_U_SPACE = ("\t\n\x0b\f\r \x85\xa0\N{OGHAM SPACE MARK}\N{MONGOLIAN VOWEL SEPARATOR}"
            "\N{EN QUAD}-\N{HAIR SPACE}\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}"
            "\N{NARROW NO-BREAK SPACE}\N{MEDIUM MATHEMATICAL SPACE}\N{IDEOGRAPHIC SPACE}")
_U_S = "[" + _U_SPACE + "]"
_U_R = "(?:\r\n|[\n\x0b\f\r\x85\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}])"

_NUM_GROUP_RE = re.compile(r"(\d)[ .,\N{NO-BREAK SPACE}\N{NARROW NO-BREAK SPACE}\N{THIN SPACE}](?=\d\d\d\b)")
_ASCII_DIGITS_RE = re.compile(r"[0-9]+")

_THINK_RE = re.compile(r"<think>.*?</think>", re.S)
_TAG_RE = re.compile(r"<[^>]*>")
_LEAD_IN_RE = re.compile(r"^[ \t\n\x0b\f\r]*(hier (ist|sind)[^:\n]*:|here (is|are)[^:\n]*:|antwort:|answer:)[ \t\n\x0b\f\r]*",
                         re.I | re.ASCII)
_QUOTED_RE = re.compile("^[\"\N{LEFT DOUBLE QUOTATION MARK}\N{DOUBLE LOW-9 QUOTATION MARK}"
                        "\N{LEFT-POINTING DOUBLE ANGLE QUOTATION MARK}](.*)[\"\N{RIGHT DOUBLE QUOTATION MARK}"
                        "\N{LEFT DOUBLE QUOTATION MARK}\N{RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK}]$", re.S)
_LINEBREAK_RE = re.compile(_U_S + "*" + _U_R + _U_S + "*")
_MULTISPACE_RE = re.compile(_U_S + "{2,}")
_NO_ANSWER_RE = re.compile("KEINE_ANTWORT", re.I | re.ASCII)


def check_numbers(text, facts):
    """zahlenPruefen: first digit sequence of `text` not found in `facts`, else None."""
    def digits(s):
        s = _NUM_GROUP_RE.sub(r"\1", s)
        return _ASCII_DIGITS_RE.findall(s)
    allowed = set(digits(facts))
    for d in digits(text):
        if d not in allowed:
            return d
    return None


def clean(text):
    """saeubern: remove think blocks, tags, markdown, lead-ins, outer quotes, line breaks."""
    t = text if isinstance(text, str) else php_str(text)
    t = _THINK_RE.sub(" ", t)
    t = _TAG_RE.sub(" ", t)
    for mark in ("**", "__", "`", "#"):
        t = t.replace(mark, "")
    t = php_trim(t)
    t = _LEAD_IN_RE.sub("", t, count=1)
    t = php_trim(t)
    m = _QUOTED_RE.match(t)
    if m:
        t = php_trim(m.group(1))
    t = _LINEBREAK_RE.sub(" ", t)
    return php_trim(_MULTISPACE_RE.sub(" ", t))


def stream_cut(text):
    """stromSchnitt: text up to and including the last whitespace, never inside '1 000'."""
    digits = "0123456789"
    n = len(text)
    for i in range(n - 1, -1, -1):
        c = text[i]
        if c not in " \n\r\t":
            continue
        if c == " " and i > 0 and text[i - 1] in digits and (i + 1 == n or text[i + 1] in digits):
            continue
        return text[:i + 1]
    return ""


_IMAGE_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$")


def images_from_job(raw, enabled, max_images):
    """bilderAusAuftrag: the checked and capped data: URLs of a job."""
    if not enabled or not isinstance(raw, (list, dict)):
        return []
    out = []
    limit = max(0, php_int(max_images))
    for url in php_array(raw):
        if len(out) >= limit:
            break
        if not isinstance(url, str) or len(url.encode("utf-8")) > IMAGE_MAX_BYTES:
            continue
        if not _IMAGE_RE.match(url):
            continue
        out.append(url)
    return out


class StreamState:
    """State of one streamed (SSE) model call; new for every attempt (stromNeu)."""

    def __init__(self):
        self.raw = bytearray()    # captured body (capped) for non-SSE answers
        self.buf = b""
        self.text = ""
        self.sse = False
        self.has_content = False
        self.ended = False
        self.error = ""

    def feed(self, data):
        """stromFuettern: bytes from the model; lines are parsed when complete."""
        if len(self.raw) < RAW_CAPTURE_MAX:
            self.raw += data
        self.buf += data
        while True:
            p = self.buf.find(b"\n")
            if p < 0:
                break
            self._line(self.buf[:p].rstrip(b"\r"))
            self.buf = self.buf[p + 1:]

    def finish(self):
        """stromSchluss: whatever is left after the last line break."""
        if self.buf:
            self._line(self.buf.rstrip(b"\r"))
            self.buf = b""

    def _line(self, line):
        """stromZeile: only "data: {...}" and "data: [DONE]" count."""
        if not line.startswith(b"data:"):
            return
        self.sse = True
        payload = line[5:].strip(b" \t\n\r\0\x0b")
        if payload == b"[DONE]":
            self.ended = True
            return
        j = php_json_decode(payload)
        if not isinstance(j, (list, dict)):
            return
        # vLLM reports an error in the middle of a stream as its own event.
        if php_get(j, "error") is not None or php_get(j, "object") == "error":
            f = php_get(j, "error")
            if f is None:
                f = j
            if isinstance(f, (list, dict)):
                msg = php_get(f, "message")
                self.error = php_str(msg if msg is not None else "Fehler ohne Text")
            else:
                self.error = php_str(f)
            return
        c = php_get(php_get(j, "choices"), 0)
        if not isinstance(c, (list, dict)):
            return
        content = php_get(php_get(c, "delta"), "content")
        if isinstance(content, str):
            self.text += content
            self.has_content = True
        if php_truthy(php_get(c, "finish_reason")):
            self.ended = True


def _body_excerpt(raw, n):
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8", "replace")
    return raw[:n]


def read_model(code, raw, error, ms, stream=None):
    """modellLesen -> (text or None, ms, reason_de, reason_en)."""
    if error:
        return None, ms, "Modell nicht erreichbar: " + error, "model server not reachable: " + error
    if code != 200:
        ex = _body_excerpt(raw, 160)
        return None, ms, "Modell HTTP %d: %s" % (code, ex), "model server answered HTTP %d: %s" % (code, ex)
    if stream is not None and stream.sse:
        if stream.error:
            ex = stream.error[:160]
            return None, ms, "Modell-Strom: " + ex, "model stream reported an error: " + ex
        if not stream.has_content:
            return None, ms, "Antwort ohne Text", "the answer contained no text"
        if not stream.ended:
            return None, ms, "Strom ohne Abschluss", "the stream ended without completion"
        return stream.text, ms, "", ""
    value = php_json_decode(raw)
    for step in ("choices", 0, "message", "content"):
        if not isinstance(value, (list, dict)) or php_get(value, step) is None:
            return None, ms, "Antwort ohne Text", "the answer contained no text"
        value = php_get(value, step)
    return php_str(value), ms, "", ""


def _float32(v):
    try:
        return struct.pack("<f", v)
    except OverflowError:
        return struct.pack("<f", float("inf") if v > 0 else float("-inf"))


def read_embeddings(code, raw, error, count, embed_model):
    """einbettenLesen -> (payload JSON string or None, reason_de, reason_en)."""
    if error:
        return None, "Einbettungsserver nicht erreichbar: " + error, "embedding server not reachable: " + error
    if code != 200:
        ex = _body_excerpt(raw, 160)
        return None, "Einbettung HTTP %d: %s" % (code, ex), "embedding server answered HTTP %d: %s" % (code, ex)
    j = php_json_decode(raw)
    data = php_get(j, "data") if isinstance(j, (list, dict)) else None
    if not isinstance(data, (list, dict)):
        return None, "Einbettung unlesbar", "unreadable embedding answer"
    items = sorted(php_array(data), key=lambda e: php_int(php_get(e, "index")))
    vectors = []
    dims = 0
    for e in items:
        emb = php_get(e, "embedding")
        values = php_array(emb)
        if not values or (dims > 0 and len(values) != dims):
            return None, "Vektor leer oder ungleich lang", "empty vector or vectors of different length"
        dims = len(values)
        packed = b"".join(_float32(php_float(w)) for w in values)
        vectors.append(base64.b64encode(packed).decode("ascii"))
    if len(vectors) != count:
        return (None, "%d Vektoren fuer %d Texte" % (len(vectors), count),
                "%d vectors for %d texts" % (len(vectors), count))
    payload = php_json_encode({"vektoren": vectors, "dims": dims, "modell": embed_model},
                              unescaped_unicode=False, unescaped_slashes=True)
    return payload, "", ""


# ---------------------------------------------------------------------------
# HTTP (http.client with a total deadline, curl-like error texts)
# ---------------------------------------------------------------------------
class HttpResult:
    __slots__ = ("code", "body", "error", "error_detail")

    def __init__(self, code, body=b"", error="", error_detail=""):
        self.code = code
        self.body = body
        self.error = error                # short, like curl_strerror()
        self.error_detail = error_detail  # detailed, like curl_error()


class _HTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, timeout, connect_ip):
        super().__init__(host, port, timeout=timeout)
        self._connect_ip = connect_ip

    def connect(self):
        self.sock = socket.create_connection((self._connect_ip or self.host, self.port), self.timeout)
        try:
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass


class _HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, timeout, connect_ip, context):
        super().__init__(host, port, timeout=timeout, context=context)
        self._connect_ip = connect_ip
        self._tls_context = context

    def connect(self):
        sock = socket.create_connection((self._connect_ip or self.host, self.port), self.timeout)
        # SNI and certificate name stay the host name even with `resolve`.
        self.sock = self._tls_context.wrap_socket(sock, server_hostname=self.host)


def _resolve_lookup(resolve, host, port):
    """curl --resolve host:port:addr[,addr] -> addr for this host/port, else None."""
    if not resolve:
        return None
    parts = resolve.split(":", 2)
    if len(parts) != 3:
        return None
    r_host, r_port, addrs = parts
    if r_host.lstrip("+").lower() != (host or "").lower():
        return None
    try:
        if int(r_port) != port:
            return None
    except ValueError:
        return None
    addr = addrs.split(",")[0].strip()
    if addr.startswith("[") and addr.endswith("]"):
        addr = addr[1:-1]
    return addr or None


def http_request(method, url, headers, body=None, timeout=60, connect_timeout=15, sink=None,
                 resolve="", tls_verify=True):
    """One HTTP request. The body goes to `sink(bytes)` if given, else into the result."""
    start = time.monotonic()
    deadline = start + max(0.001, float(timeout))
    received = 0
    host = ""
    port = 0
    stage = "connect"
    conn = None
    try:
        parts = urllib.parse.urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in ("http", "https"):
            return HttpResult(0, b"", "Unsupported protocol",
                              'Protocol "%s" not supported' % scheme)
        host = parts.hostname or ""
        if not host:
            return HttpResult(0, b"", "URL using bad/illegal format or missing URL",
                              "No host part in the URL")
        try:
            port = parts.port or (443 if scheme == "https" else 80)
        except ValueError:
            return HttpResult(0, b"", "URL using bad/illegal format or missing URL", "Port number was not valid")
        target = (parts.path or "/") + ("?" + parts.query if parts.query else "")
        ip = _resolve_lookup(resolve, host, port)
        ct = max(0.001, min(float(connect_timeout), deadline - time.monotonic()))
        if scheme == "https":
            ctx = ssl.create_default_context()
            if not tls_verify:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            conn = _HTTPSConnection(host, port, ct, ip, ctx)
        else:
            conn = _HTTPConnection(host, port, ct, ip)
        conn.connect()
        stage = "transfer"
        sock = conn.sock

        def arm():
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise socket.timeout("deadline")
            try:
                sock.settimeout(rem)
            except OSError:
                pass

        arm()
        conn.putrequest(method, target, skip_accept_encoding=True)
        conn.putheader("Accept", "*/*")
        for k, v in headers:
            conn.putheader(k, v)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        arm()
        stage = "response"
        resp = conn.getresponse()
        stage = "body"
        chunks = []
        while True:
            arm()
            data = resp.read1(65536)
            if not data:
                break
            received += len(data)
            if sink is not None:
                sink(data)
            else:
                chunks.append(data)
        return HttpResult(resp.status, b"".join(chunks))
    except socket.timeout:
        ms = ms_since(start)
        if stage == "connect":
            return HttpResult(0, b"", "Timeout was reached",
                              "Connection timed out after %d milliseconds" % ms)
        return HttpResult(0, b"", "Timeout was reached",
                          "Operation timed out after %d milliseconds with %d bytes received" % (ms, received))
    except socket.gaierror:
        return HttpResult(0, b"", "Couldn't resolve host name", "Could not resolve host: %s" % host)
    except ssl.SSLCertVerificationError as e:
        return HttpResult(0, b"", "SSL peer certificate or SSH remote key was not OK",
                          "SSL certificate problem: %s" % (getattr(e, "verify_message", "") or e))
    except ssl.SSLError as e:
        return HttpResult(0, b"", "SSL connect error", "SSL connect error: %s" % e)
    except http.client.RemoteDisconnected:
        return HttpResult(0, b"", "Server returned nothing (no headers, no data)", "Empty reply from server")
    except (http.client.HTTPException, OSError) as e:
        if stage == "connect":
            why = getattr(e, "strerror", None) or str(e) or e.__class__.__name__
            return HttpResult(0, b"", "Couldn't connect to server",
                              "Failed to connect to %s port %d after %d ms: %s" % (host, port, ms_since(start), why))
        return HttpResult(0, b"", "Failure when receiving data from the peer",
                          "Recv failure: %s" % (str(e) or e.__class__.__name__))
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
class ConfigError(Exception):
    pass


class Config:
    pass


def _cfg_str(raw, key, default=""):
    v = raw.get(key)
    if v is None:
        return default
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return php_str(v)
    raise ConfigError("'%s' must be a string." % key)


def _cfg_int(raw, key, default):
    v = raw.get(key)
    if v is None:
        return default
    if isinstance(v, bool):
        raise ConfigError("'%s' must be a whole number." % key)
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str) and re.fullmatch(r"\s*[+-]?[0-9]+\s*", v):
        return int(v)
    raise ConfigError("'%s' must be a whole number." % key)


def _cfg_float(raw, key, default):
    v = raw.get(key)
    if v is None:
        return default
    if isinstance(v, bool):
        raise ConfigError("'%s' must be a number." % key)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            pass
    raise ConfigError("'%s' must be a number." % key)


def _cfg_bool(raw, key, default):
    v = raw.get(key)
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str) and v.strip().lower() in ("true", "1", "yes", "on"):
        return True
    if isinstance(v, str) and v.strip().lower() in ("false", "0", "no", "off", ""):
        return False
    raise ConfigError("'%s' must be true or false." % key)


def _cfg_list(raw, key, default):
    v = raw.get(key)
    if v is None:
        return list(default)
    if isinstance(v, str):
        v = [x.strip() for x in v.split(",") if x.strip()]
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise ConfigError("'%s' must be a list of strings." % key)
    return [KIND_ALIASES.get(x, x) for x in v]


def load_config(path):
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        raise ConfigError("Configuration file %s not found or not readable (copy rc-node.example.json, "
                          "fill it in, chmod 600)." % path)
    raw = php_json_decode(data)
    if raw is None and data.strip():
        try:
            json.loads(data.decode("utf-8", "replace"))
            reason = "unsupported content"
        except ValueError as e:
            reason = str(e)
        raise ConfigError("Configuration file %s is not valid JSON: %s" % (path, reason))
    if not isinstance(raw, dict):
        raise ConfigError("Configuration file %s must contain a JSON object." % path)
    raw = dict(raw)
    for env, key in (("RC_NODE_SECRET", "secret"), ("RC_NODE_MODEL_API_KEY", "model_api_key")):
        if os.environ.get(env):
            raw[key] = os.environ[env]

    for key in ("base_url", "node_id", "secret", "model"):
        if not php_truthy(raw.get(key)):
            raise ConfigError("Missing '%s' in the configuration." % key)
    if not php_truthy(raw.get("model_endpoint")) and not php_truthy(raw.get("chat_url")):
        raise ConfigError("Missing 'model_endpoint' (or 'chat_url' for Azure) in the configuration.")

    c = Config()
    c.base_url = _cfg_str(raw, "base_url")
    c.node_id = _cfg_str(raw, "node_id")
    c.secret = _cfg_str(raw, "secret")
    c.model = _cfg_str(raw, "model")
    if not c.node_id.startswith("kn-"):
        raise ConfigError("'node_id' must start with kn- (exactly as the customer area shows it).")
    c.model_endpoint = _cfg_str(raw, "model_endpoint")
    c.chat_url = _cfg_str(raw, "chat_url")
    c.model_api_key = _cfg_str(raw, "model_api_key")
    c.model_key_header = _cfg_str(raw, "model_key_header", "Authorization") or "Authorization"
    c.kinds = _cfg_list(raw, "kinds", ["chat"])
    c.capabilities = _cfg_list(raw, "capabilities", [])
    c.embed_url = _cfg_str(raw, "embed_url")
    c.embed_model = _cfg_str(raw, "embed_model")
    c.embed_timeout = _cfg_int(raw, "embed_timeout", 120)
    c.images = _cfg_bool(raw, "images", False)
    c.images_max = _cfg_int(raw, "images_max", 1)
    c.stream = _cfg_bool(raw, "stream", True)
    c.stream_ms = _cfg_int(raw, "stream_ms", 400)
    c.concurrency = _cfg_int(raw, "concurrency", 1)
    c.poll_wait = _cfg_int(raw, "poll_wait", 20)
    c.timeout = _cfg_int(raw, "timeout", 120)
    c.temperature = _cfg_float(raw, "temperature", 0.2)
    c.max_tokens = _cfg_int(raw, "max_tokens", 300)
    c.basic_auth = _cfg_str(raw, "basic_auth")
    c.resolve = _cfg_str(raw, "resolve")
    c.tls_verify = _cfg_bool(raw, "tls_verify", True)
    c.log_file = _cfg_str(raw, "log_file")
    c.timezone = _cfg_str(raw, "timezone")
    if "einbettung" in c.kinds and (c.embed_url == "" or c.embed_model == ""):
        raise ConfigError("'kinds' contains 'einbettung' (embedding) - then 'embed_url' and 'embed_model' "
                          "are required.")
    c.can = c.capabilities or c.kinds
    return c


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------
class Job:
    __slots__ = ("id", "kind", "system", "prompt", "facts", "max_tokens", "texts", "images",
                 "attempt", "ms", "stream", "zs", "part_n", "part_t", "part_text", "part_more")


class Node:
    def __init__(self, cfg, one=False):
        self.cfg = cfg
        self.one = one
        self.keep_running = True
        self.stream_off = False   # `teil` answered 400/404: no streaming until restart
        self.events = queue.Queue()
        self._tz = None
        if cfg.timezone:
            try:
                from zoneinfo import ZoneInfo
                self._tz = ZoneInfo(cfg.timezone)
            except Exception:
                sys.stderr.write("warning: unknown timezone '%s', using system time\n" % cfg.timezone)

    # -- logging -----------------------------------------------------------
    def log(self, text):
        now = datetime.now(self._tz) if self._tz is not None else datetime.now()
        line = now.strftime("%Y-%m-%d %H:%M:%S") + "  " + text + "\n"
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
        except Exception:
            pass
        if self.cfg.log_file:
            try:
                with open(self.cfg.log_file, "a", encoding="utf-8") as fh:
                    fh.write(line)
            except OSError:
                pass

    # -- reactive.chat -----------------------------------------------------
    def pi_request(self, action, body=None, extra="", timeout=60):
        """One signed request to reactive.chat (GET without body, POST with body)."""
        cfg = self.cfg
        ts = str(int(time.time()))
        # The nonce: two identical fetches in the same second would otherwise
        # carry the same signature and the server would reject the second.
        url = (cfg.base_url.rstrip("/") + "/v1/ki?action=" + action + "&knoten=" + rawurlencode(cfg.node_id)
               + extra + "&nonce=" + secrets.token_hex(8))
        parts = urllib.parse.urlsplit(url)
        path = parts.path or "/"
        query = parts.query
        method = "POST" if body is not None else "GET"
        body_b = body.encode("utf-8") if body is not None else None
        sig = signature(cfg.secret, ts, method, path, query, body_b or b"")
        headers = [("X-RC-KI-TS", ts), ("X-RC-KI-SIG", sig), ("Content-Type", "application/json"),
                   ("User-Agent", USER_AGENT)]
        if cfg.basic_auth:
            headers.insert(0, ("Authorization", "Basic " + base64.b64encode(cfg.basic_auth.encode("utf-8")).decode("ascii")))
        return http_request(method, url, headers, body_b, timeout=timeout, connect_timeout=15,
                            resolve=cfg.resolve, tls_verify=cfg.tls_verify)

    @staticmethod
    def pi_read(res, detailed=False):
        """piLesen -> (code, error, data, raw_text)."""
        err = res.error_detail if detailed else res.error
        if err:
            return 0, err, None, ""
        data = php_json_decode(res.body)
        raw = res.body.decode("utf-8", "replace")
        return res.code, "", (data if isinstance(data, (list, dict)) else None), raw

    # -- the model -----------------------------------------------------------
    def model_url(self):
        cfg = self.cfg
        if cfg.chat_url:
            return cfg.chat_url
        return cfg.model_endpoint.rstrip("/") + "/chat/completions"

    def model_headers(self):
        cfg = self.cfg
        h = [("Content-Type", "application/json")]
        if cfg.model_api_key:
            if cfg.model_key_header.lower() == "authorization":
                h.append(("Authorization", "Bearer " + cfg.model_api_key))
            else:
                h.append((cfg.model_key_header, cfg.model_api_key))
        return h

    def model_body(self, system, prompt, max_tokens, images=None, stream=False):
        # With an image, content becomes a list (text first, then one
        # image_url per image); without, it stays the plain string.
        content = prompt
        if images:
            content = [{"type": "text", "text": prompt}]
            for url in images:
                content.append({"type": "image_url", "image_url": {"url": url}})
        return php_json_encode({
            "model": self.cfg.model,
            "stream": bool(stream),
            "temperature": float(self.cfg.temperature),
            "max_tokens": int(max_tokens) if max_tokens > 0 else int(self.cfg.max_tokens),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
        })

    def model_request(self, system, prompt, max_tokens, images=None, zs=None):
        body = self.model_body(system, prompt, max_tokens, images, stream=zs is not None)
        return http_request("POST", self.model_url(), self.model_headers(), body.encode("utf-8"),
                            timeout=self.cfg.timeout, connect_timeout=10,
                            sink=zs.feed if zs is not None else None)

    def embed_request(self, texts, timeout=None):
        body = php_json_encode({"model": self.cfg.embed_model, "input": list(texts)})
        return http_request("POST", self.cfg.embed_url, [("Content-Type", "application/json")],
                            body.encode("utf-8"),
                            timeout=self.cfg.embed_timeout if timeout is None else timeout,
                            connect_timeout=5)

    def embed_ready(self):
        r = self.embed_request(["Bereit"], timeout=30)
        return not r.error and r.code == 200

    def model_ready(self):
        """Is the model server answering? Embedding-only processes need no chat model."""
        cfg = self.cfg
        if "einbettung" in cfg.kinds and not self.embed_ready():
            return False
        if all(k == "einbettung" for k in cfg.kinds):
            return True
        if cfg.chat_url:
            return True
        r = http_request("GET", cfg.model_endpoint.rstrip("/") + "/models", self.model_headers(),
                         None, timeout=5, connect_timeout=3)
        return not r.error and r.code == 200

    # -- --probe -------------------------------------------------------------
    def probe(self):
        cfg = self.cfg
        self.log("Probe, rc-node-python %s." % VERSION)
        self.log("  reactive.chat: " + cfg.base_url)
        res = self.pi_request("hol", None, "&n=0&warte=0&arten=" + rawurlencode(",".join(cfg.kinds))
                              + "&kann=" + rawurlencode(",".join(cfg.can)), 20)
        code, err, data, raw = self.pi_read(res, detailed=True)
        if code == 200 and data is not None:
            self.log("    HTTP 200 - signed in, %d job(s) waiting." % php_int(php_get(data, "offen")))
        elif code == 401:
            self.log("    HTTP 401 - rejected. Are node ID and secret correct? Is this machine's clock right (NTP)?"
                     " Has the node been revoked in the customer area?")
        else:
            self.log("    No connection: " + (err if err else "HTTP %d %s" % (code, raw[:200])))

        self.log("  Model: %s (%s)" % (self.model_url(), cfg.model))
        t0 = time.monotonic()
        r = self.model_request(PROBE_SYSTEM, PROBE_PROMPT, PROBE_MAX_TOKENS)
        text, ms, _de, en = read_model(r.code, r.body, r.error_detail, ms_since(t0))
        if text is None:
            self.log("    Failed: " + en)
        else:
            self.log("    Answer in %d ms: %s" % (ms, clean(text)))

        if cfg.embed_url:
            self.log("  Embeddings: %s (%s)" % (cfg.embed_url, cfg.embed_model))
            t0 = time.monotonic()
            r = self.embed_request(["Bereit"])
            payload, _de, en = read_embeddings(r.code, r.body, r.error_detail, 1, cfg.embed_model)
            if payload is None:
                self.log("    Failed: " + en)
            else:
                self.log("    %d dimensions in %d ms" % (json.loads(payload)["dims"], ms_since(t0)))

        self.log("  Node: %s, takes: %s, can: %s, images: %s" % (
            cfg.node_id, ", ".join(cfg.kinds), ", ".join(cfg.can),
            ("yes (at most %d)" % cfg.images_max) if cfg.images else "no"))
        ok = code == 200 and text is not None
        self.log("  Result: %s" % ("OK - the node can run." if ok else
                                   "NOT OK - see the lines above."))
        return 0 if ok else 1

    # -- the loop: fetch, let the model work, deliver - several at once ------
    def loop(self, once):
        cfg = self.cfg
        slots = 1 if self.one else max(1, cfg.concurrency)
        wait_s = max(0, min(60, cfg.poll_wait))
        hol_timeout = wait_s + 20
        kinds_q = (rawurlencode(",".join(cfg.kinds)) + "&kann=" + rawurlencode(",".join(cfg.can))
                   + ("&bilder=1" if cfg.images else ""))
        stream_ms = max(100, cfg.stream_ms)

        running = collections.OrderedDict()   # id -> Job
        finished = []
        in_bring = []
        st ={"in_flight": 0}
        hol_open = bring_open = teil_open = False
        fetched = False
        done = 0
        line_error = False
        failures = 0
        quiet_until = 0
        last_call = int(time.time())
        model_waits = 0

        def spawn(tag, job_id, fn, zs=None):
            st["in_flight"] += 1
            t0 = time.monotonic()

            def run():
                try:
                    res = fn()
                except Exception as e:  # never lose the completion event
                    res = HttpResult(0, b"", "internal error: %s" % e, "internal error: %s" % e)
                if zs is not None:
                    zs.finish()
                self.events.put((tag, job_id, t0, zs, res, time.monotonic()))

            threading.Thread(target=run, name="rc-%s-%s" % (tag, job_id), daemon=True).start()

        def start_model(job):
            p = job.prompt if job.attempt == 1 else job.prompt + RETRY_SUFFIX
            # Streaming only with `strom` in the job AND in the config, and not
            # after reactive.chat refused `teil`. Every attempt starts empty.
            zs = StreamState() if (job.stream and cfg.stream and not self.stream_off) else None
            job.zs = zs
            job.part_text = ""
            spawn("model", job.id,
                  lambda: self.model_request(job.system, p, job.max_tokens, job.images, zs), zs)

        def finish(job_id, sentence, reason):
            nonlocal done
            job = running.pop(job_id)
            done += 1
            if sentence == "":
                what = " discarded: " + reason
            elif job.kind == "einbettung":
                what = " %d ms: %d text(s) embedded" % (job.ms, len(job.texts))
            else:
                what = " %d ms: %s" % (job.ms, sentence[:100])
            parts = ("  parts %d%s" % (job.part_n, "" if job.part_more else " (stopped)")) if job.stream else ""
            self.log("  #%d%s%s  [%d/%d]" % (job_id, what, parts, len(running), slots))
            # Failures are delivered too: someone is waiting in the chat.
            finished.append({"id": job_id, "text": sentence, "grund": reason if sentence == "" else "",
                             "modell": cfg.model, "ms": job.ms, "knoten": cfg.node_id})

        while True:
            free = slots - len(running)
            idle = not hol_open and not bring_open and not running and not teil_open
            fetch_allowed = self.keep_running and not (once and fetched) and int(time.time()) >= quiet_until

            if idle and not finished and (not self.keep_running or (once and fetched)):
                break

            # Check the model first - otherwise the node takes jobs it cannot do.
            if idle and not finished and fetch_allowed:
                if not self.model_ready():
                    if model_waits % 6 == 0:
                        self.log("Model server not reachable, waiting.")
                    model_waits += 1
                    if once:
                        return -1
                    for _ in range(10):
                        if not self.keep_running:
                            break
                        time.sleep(1)
                    continue
                if model_waits > 0:
                    self.log("Model server is reachable again.")
                    model_waits = 0

            if fetch_allowed and not hol_open and free > 0:
                extra = "&n=%d&warte=%d&arten=%s" % (min(free, slots), wait_s, kinds_q)
                spawn("hol", 0, lambda extra=extra: self.pi_request("hol", None, extra, hol_timeout))
                hol_open = True
                fetched = True
                last_call = int(time.time())
            elif self.keep_running and not hol_open and free <= 0 and int(time.time()) - last_call >= HEARTBEAT_S:
                # `kann` in the heartbeat too: without it the server would assume chat.
                extra = "&n=0&warte=0&kann=" + rawurlencode(",".join(cfg.can))
                spawn("puls", 0, lambda extra=extra: self.pi_request("hol", None, extra, 20))
                hol_open = True
                last_call = int(time.time())

            if not bring_open and finished:
                body = php_json_encode({"ergebnisse": list(finished)})
                spawn("bring", 0, lambda body=body: self.pi_request("bring", body))
                in_bring = finished
                finished = []
                bring_open = True

            # Parts while the model writes: never blocking, one `teil` call at a
            # time, only grown text cut at the last whitespace, per job at most
            # every stream_ms. n counts per job, also across a second attempt.
            if not teil_open and not self.stream_off:
                now = time.monotonic()
                entries = []
                for tid, tj in running.items():
                    if len(entries) >= PART_MAX_ENTRIES:
                        break
                    if tj.zs is None or not tj.part_more or (now - tj.part_t) * 1000 < stream_ms:
                        continue
                    ttext = stream_cut(tj.zs.text)
                    tlen = len(ttext.encode("utf-8"))
                    if tlen <= len(tj.part_text.encode("utf-8")):
                        continue
                    if tlen > PART_MAX_BYTES:
                        tj.part_more = False
                        continue
                    tj.part_n += 1
                    tj.part_t = now
                    tj.part_text = ttext
                    entries.append({"id": tid, "n": tj.part_n, "text": ttext})
                if entries:
                    body = php_json_encode({"teile": entries})
                    spawn("teil", 0, lambda body=body: self.pi_request("teil", body, "", 10))
                    teil_open = True

            # Collect finished requests; wait only when nothing is ready. What
            # arrives during the wait is processed right away, before the next
            # round of parts - a finished answer must not be sent as a part.
            batch = []
            while True:
                try:
                    batch.append(self.events.get_nowait())
                except queue.Empty:
                    break
            if not batch:
                if st["in_flight"] > 0:
                    # With a live stream 0.1 s: a due part should not wait.
                    wait = 1.0
                    for sj in running.values():
                        if sj.zs is not None and sj.part_more and not self.stream_off:
                            wait = 0.1
                            break
                    try:
                        batch.append(self.events.get(timeout=wait))
                    except queue.Empty:
                        pass
                    while True:
                        try:
                            batch.append(self.events.get_nowait())
                        except queue.Empty:
                            break
                else:
                    time.sleep(0.2)

            for tag, job_id, t0, zs, res, t1 in batch:
                st["in_flight"] -= 1
                raw = bytes(zs.raw) if zs is not None else res.body
                err = res.error

                if tag == "puls":
                    hol_open = False
                    continue

                if tag == "hol":
                    hol_open = False
                    code, perr, data, rawtext = self.pi_read(res)
                    jobs = php_get(data, "auftraege") if data is not None else None
                    if code != 200 or jobs is None:
                        self.log("Fetching jobs failed: HTTP %d %s" % (code, perr if perr else rawtext[:160]))
                        line_error = True
                        failures += 1
                        quiet_until = int(time.time()) + min(300, 5 * failures)
                        continue
                    failures = 0
                    new = 0
                    for a in php_array(jobs):
                        jid = php_int(php_get(a, "id"))
                        if jid <= 0 or jid in running:
                            continue
                        j = Job()
                        j.id = jid
                        art = php_get(a, "art")
                        j.kind = php_str(art if art is not None else "chat")
                        j.system = php_str(php_get(a, "system"))
                        j.prompt = php_str(php_get(a, "prompt"))
                        j.facts = php_str(php_get(a, "fakten"))
                        j.max_tokens = php_int(php_get(a, "max_tokens"))
                        j.texts = [php_str(x) for x in php_array(php_get(a, "texte"))]
                        j.images = images_from_job(php_get(a, "bilder"), cfg.images, cfg.images_max)
                        j.attempt = 1
                        j.ms = 0
                        j.stream = php_truthy(php_get(a, "strom"))
                        j.zs = None
                        j.part_n = 0
                        j.part_t = 0.0
                        j.part_text = ""
                        j.part_more = True
                        running[jid] = j
                        if j.kind == "einbettung":
                            if cfg.embed_url == "" or not j.texts:
                                finish(jid, "", "kein Einbettungsserver" if cfg.embed_url == ""
                                       else "Einbettung ohne Texte")
                                continue
                            spawn("embed", jid, lambda texts=j.texts: self.embed_request(texts))
                            new += 1
                            continue
                        if j.prompt == "":
                            finish(jid, "", "Auftrag ohne Text")
                            continue
                        if self.one:
                            out = ("\n--- Job #%d (%s) ---\nSYSTEM:\n%s\n\nPROMPT:\n%s%s\n\n"
                                   % (jid, j.kind, j.system, j.prompt,
                                      ("\n\nIMAGES: %d" % len(j.images)) if j.images else ""))
                            try:
                                sys.stdout.write(out)
                                sys.stdout.flush()
                            except Exception:
                                pass
                        start_model(j)
                        new += 1
                    if new:
                        self.log("%d job(s) fetched [%d/%d]." % (new, len(running), slots))
                    continue

                if tag == "teil":
                    teil_open = False
                    code, perr, data, rawtext = self.pi_read(res)
                    # 400/404: this server does not know `teil` - streaming off
                    # until restart. Anything else: the next part comes anyway.
                    if code in (400, 404):
                        self.stream_off = True
                        self.log("Streaming off until restart: teil answered HTTP %d %s" % (code, rawtext[:120]))
                        continue
                    parts_list = php_get(data, "teile") if data is not None else None
                    if code == 200 and isinstance(parts_list, (list, dict)):
                        for e in php_array(parts_list):
                            if not isinstance(e, (list, dict)):
                                continue
                            eid = php_int(php_get(e, "id"))
                            if eid in running and isinstance(e, dict) and "weiter" in e \
                                    and not php_truthy(e["weiter"]):
                                running[eid].part_more = False
                    continue

                if tag == "bring":
                    bring_open = False
                    code, perr, data, rawtext = self.pi_read(res)
                    results = php_get(data, "ergebnisse") if data is not None else None
                    if code != 200 or results is None:
                        self.log("Delivery failed: HTTP %d %s" % (code, perr if perr else rawtext[:160]))
                        line_error = True
                        in_bring = []
                        continue
                    accepted = 0
                    for e in php_array(results):
                        if php_truthy(php_get(e, "angenommen")):
                            accepted += 1
                        elif php_truthy(php_get(e, "grund")):
                            self.log("  #%d rejected: %s" % (php_int(php_get(e, "id")), php_str(php_get(e, "grund"))))
                    self.log("%d of %d accepted." % (accepted, len(in_bring)))
                    in_bring = []
                    continue

                if job_id not in running:
                    continue
                job = running[job_id]
                if tag == "embed":
                    job.ms += ms_since(t0, t1)
                    payload, reason, _en = read_embeddings(res.code, raw, err, len(job.texts), cfg.embed_model)
                    finish(job_id, payload if payload is not None else "", reason)
                    continue

                text, ms, reason, _en = read_model(res.code, raw, err, ms_since(t0, t1), zs)
                job.ms += ms
                if text is None:
                    finish(job_id, "", reason)
                    continue
                candidate = clean(text)
                # KEINE_ANTWORT is the agreed word for "not in the sources" -
                # passed on unchanged, it leads to a hand-over.
                if _NO_ANSWER_RE.search(candidate):
                    finish(job_id, "KEINE_ANTWORT", "")
                    continue
                bad = check_numbers(candidate, job.facts)
                if bad is None and candidate != "":
                    finish(job_id, candidate, "")
                    continue
                if job.attempt < 2:
                    job.attempt += 1
                    start_model(job)
                    continue
                finish(job_id, "", "leer nach dem Saeubern" if candidate == "" else "erfundene Zahl: " + bad)

        return -1 if (once and line_error and done == 0) else done

    # -- --daemon ------------------------------------------------------------
    def run_daemon(self):
        cfg = self.cfg

        def stop(signum, _frame):
            if self.keep_running:
                name = {getattr(signal, "SIGTERM", None): "SIGTERM", signal.SIGINT: "SIGINT"}.get(signum, "signal")
                self.keep_running = False
                self.log("%s - stopping after the running jobs." % name)

        for sig_name in ("SIGTERM", "SIGINT", "SIGBREAK"):
            s = getattr(signal, sig_name, None)
            if s is not None:
                try:
                    signal.signal(s, stop)
                except (OSError, ValueError, RuntimeError):
                    pass
        self.log("Daemon. Node %s, model %s at %s, long-poll %d s, up to %d in parallel, takes: %s." % (
            cfg.node_id, cfg.model, self.model_url(), cfg.poll_wait, 1 if self.one else max(1, cfg.concurrency),
            ", ".join(cfg.kinds)))
        self.loop(False)
        self.log("Stopped.")
        return 0


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------
def parse_args(argv):
    opts = {"config": None, "probe": False, "once": False, "one": False, "daemon": False,
            "help": False, "version": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--config="):
            opts["config"] = a[len("--config="):]
        elif a == "--config" and i + 1 < len(argv):
            i += 1
            opts["config"] = argv[i]
        elif a in ("--probe", "--once", "--one", "--daemon"):
            opts[a[2:]] = True
        elif a in ("-h", "--help"):
            opts["help"] = True
        elif a in ("-V", "--version"):
            opts["version"] = True
        else:
            raise ConfigError("Unknown argument: %s (see --help)." % a)
        i += 1
    return opts


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    try:
        opts = parse_args(argv)
        if opts["help"]:
            sys.stdout.write(USAGE)
            return 0
        if opts["version"]:
            sys.stdout.write("rc-node-python %s\n" % VERSION)
            return 0
        path = opts["config"] or os.environ.get("RC_NODE_CONFIG") or "rc-node.json"
        cfg = load_config(path)
    except ConfigError as e:
        sys.stderr.write(str(e) + "\n")
        return 2
    node = Node(cfg, one=opts["one"])
    try:
        if opts["probe"]:
            return node.probe()
        if opts["daemon"]:
            return node.run_daemon()
        n = node.loop(True)
        return 1 if n < 0 else 0
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
