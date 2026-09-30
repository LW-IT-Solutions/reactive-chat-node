# SPDX-License-Identifier: MIT
"""Unit tests for rc_node against the known vectors in ../conformance/vectors.json.

    python3 -m unittest -v test_rc_node        (from python/)
    RC_NODE_VECTORS=/path/to/vectors.json python3 test_rc_node.py
"""

import base64
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import rc_node  # noqa: E402

VECTORS_PATH = os.environ.get("RC_NODE_VECTORS") or os.path.join(HERE, "..", "conformance", "vectors.json")
with open(VECTORS_PATH, "r", encoding="utf-8") as _fh:
    V = json.load(_fh)


class TestSignature(unittest.TestCase):
    def test_vectors(self):
        for c in V["signature"]:
            with self.subTest(c["name"]):
                self.assertEqual(rc_node.signature(c["secret"], c["ts"], c["method"], c["path"],
                                                   c["query"], c["body"].encode("utf-8")),
                                 c["expected_hex"])
                self.assertTrue(c["string_to_sign"].startswith(V["constants"]["signature_prefix"]))

    def test_bodies_encode_like_php(self):
        # The signed POST bodies are exactly what json_encode(..., JSON_UNESCAPED_UNICODE) gives.
        for c in V["signature"]:
            if c["body"]:
                with self.subTest(c["name"]):
                    self.assertEqual(rc_node.php_json_encode(json.loads(c["body"])), c["body"])

    def test_retry_suffix(self):
        self.assertEqual(rc_node.RETRY_SUFFIX, V["retry_suffix"])

    def test_constants(self):
        k = V["constants"]
        self.assertEqual(rc_node.HEARTBEAT_S, k["heartbeat_s"])
        self.assertEqual(rc_node.PART_MAX_ENTRIES, k["teil_max_entries"])
        self.assertEqual(rc_node.PART_MAX_BYTES, k["teil_max_bytes"])
        self.assertEqual(rc_node.IMAGE_MAX_BYTES, k["image_max_bytes"])
        self.assertEqual(rc_node.PROBE_SYSTEM, k["probe_system"])
        self.assertEqual(rc_node.PROBE_PROMPT, k["probe_prompt"])
        self.assertEqual(rc_node.PROBE_MAX_TOKENS, k["probe_max_tokens"])


class TestClean(unittest.TestCase):
    def test_vectors(self):
        for c in V["clean"]:
            with self.subTest(c["name"]):
                self.assertEqual(rc_node.clean(c["input"]), c["expected"])


class TestNumbers(unittest.TestCase):
    def test_vectors(self):
        for c in V["numbers"]:
            with self.subTest(c["name"]):
                self.assertEqual(rc_node.check_numbers(c["text"], c["facts"]), c["expected"])


class TestStreamCut(unittest.TestCase):
    def test_vectors(self):
        for c in V["stream_cut"]:
            with self.subTest(c["name"]):
                self.assertEqual(rc_node.stream_cut(c["input"]), c["expected"])


class TestSSE(unittest.TestCase):
    def test_vectors(self):
        for c in V["sse"]:
            with self.subTest(c["name"]):
                s = rc_node.StreamState()
                for chunk in c["chunks_b64"]:
                    s.feed(base64.b64decode(chunk))
                s.finish()
                self.assertEqual({"text": s.text, "sse": s.sse, "has_content": s.has_content,
                                  "ended": s.ended, "error": s.error}, c["expected"])
                text, _ms, reason, _en = rc_node.read_model(200, bytes(s.raw), "", 0, s)
                self.assertEqual({"text": text, "fehler": reason}, c["expected_result"])


class TestEmbedResult(unittest.TestCase):
    def test_vectors(self):
        for c in V["embed_result"]:
            with self.subTest(c["name"]):
                payload, reason, _en = rc_node.read_embeddings(
                    c["http_status"], c["body"].encode("utf-8"), c["transport_error"],
                    c["text_count"], c["embed_model"])
                self.assertEqual(payload, c["expected_result"])
                self.assertEqual(reason, c["expected_error"])


class TestImages(unittest.TestCase):
    def test_vectors(self):
        for c in V["images"]:
            with self.subTest(c["name"]):
                self.assertEqual(rc_node.images_from_job(c["input"], c["images"], c["images_max"]),
                                 c["expected"])

    def test_too_large_skipped(self):
        big = "data:image/png;base64," + "A" * (rc_node.IMAGE_MAX_BYTES)
        self.assertEqual(rc_node.images_from_job([big], True, 1), [])


class TestPhpHelpers(unittest.TestCase):
    def test_json_escapes_slash_and_line_separators(self):
        self.assertEqual(rc_node.php_json_encode({"a": "x/y" + chr(0x2028)}), '{"a":"x\\/y\\u2028"}')

    def test_int_cast(self):
        self.assertEqual(rc_node.php_int("12abc"), 12)
        self.assertEqual(rc_node.php_int(" 7"), 7)
        self.assertEqual(rc_node.php_int("1e3"), 1000)
        self.assertEqual(rc_node.php_int("abc"), 0)
        self.assertEqual(rc_node.php_int(3.9), 3)

    def test_json_decode_rejects_what_php_rejects(self):
        self.assertIsNone(rc_node.php_json_decode(b""))
        self.assertIsNone(rc_node.php_json_decode(b"NaN"))
        self.assertIsNone(rc_node.php_json_decode(b'"\\ud800"'))
        self.assertIsNone(rc_node.php_json_decode(b"\xff"))
        self.assertEqual(rc_node.php_json_decode(b'"\\ud83d\\ude00"'), chr(0x1F600))

    def test_resolve(self):
        self.assertEqual(rc_node._resolve_lookup("example.com:443:10.0.0.1", "Example.com", 443), "10.0.0.1")
        self.assertIsNone(rc_node._resolve_lookup("example.com:443:10.0.0.1", "example.com", 80))
        self.assertEqual(rc_node._resolve_lookup("h:8443:[::1]", "h", 8443), "::1")


if __name__ == "__main__":
    unittest.main(verbosity=1)
