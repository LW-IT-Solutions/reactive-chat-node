<?php
/**
 * Unit tests for rc-node.php against conformance/vectors.json.
 *
 *   php tests/unit.php [path/to/vectors.json]
 *
 * Exit 0 = every vector matches. No network, no config needed.
 */
define('RC_NODE_LIBRARY', true);
require __DIR__ . '/../rc-node.php';

use function RcNode\{signature, cleanText, checkNumbers, streamCut, readModelAnswer, readEmbedding, imagesFromJob};
use RcNode\StreamState;

$file = $argv[1] ?? dirname(__DIR__, 2) . '/conformance/vectors.json';
$V = json_decode((string)@file_get_contents($file), true);
if (!is_array($V)) { fwrite(STDERR, "cannot read $file\n"); exit(1); }

$ok = 0; $bad = 0; $bySection = [];
$check = function (string $sec, string $name, $got, $want) use (&$ok, &$bad, &$bySection) {
    $bySection[$sec] = ($bySection[$sec] ?? 0) + 1;
    if ($got === $want) { $ok++; return; }
    $bad++;
    echo "FAIL $sec/$name: got " . json_encode($got, JSON_UNESCAPED_UNICODE)
       . ' want ' . json_encode($want, JSON_UNESCAPED_UNICODE) . "\n";
};

$check('retry_suffix', '-', RcNode\RETRY_SUFFIX, $V['retry_suffix']);
$check('constants', 'heartbeat_s', RcNode\HEARTBEAT_S, $V['constants']['heartbeat_s']);
$check('constants', 'teil_max_entries', RcNode\PART_MAX_ENTRIES, $V['constants']['teil_max_entries']);
$check('constants', 'teil_max_bytes', RcNode\PART_MAX_BYTES, $V['constants']['teil_max_bytes']);
$check('constants', 'image_max_bytes', RcNode\IMAGE_MAX_BYTES, $V['constants']['image_max_bytes']);

foreach ($V['signature'] as $c) {
    $check('signature', $c['name'],
           signature($c['secret'], $c['ts'], $c['method'], $c['path'], $c['query'], $c['body']), $c['expected_hex']);
}
foreach ($V['clean'] as $c)      { $check('clean', $c['name'], cleanText($c['input']), $c['expected']); }
foreach ($V['numbers'] as $c)    { $check('numbers', $c['name'], checkNumbers($c['text'], $c['facts']), $c['expected']); }
foreach ($V['stream_cut'] as $c) { $check('stream_cut', $c['name'], streamCut($c['input']), $c['expected']); }
foreach ($V['sse'] as $c) {
    $s = new StreamState();
    foreach ($c['chunks_b64'] as $b) { $s->feed(base64_decode($b)); }
    $s->finish();
    $check('sse', $c['name'], ['text' => $s->text, 'sse' => $s->sse, 'has_content' => $s->content,
                               'ended' => $s->done, 'error' => $s->error], $c['expected']);
    $m = readModelAnswer(200, $s->raw, '', 0, $s);
    $check('sse', $c['name'] . '/result', ['text' => $m['text'], 'fehler' => $m['error']], $c['expected_result']);
}
foreach ($V['embed_result'] as $c) {
    $check('embed_result', $c['name'],
           readEmbedding($c['http_status'], $c['body'], $c['transport_error'], $c['text_count'], $c['embed_model']),
           [$c['expected_result'], $c['expected_error']]);
}
foreach ($V['images'] as $c) {
    $check('images', $c['name'], imagesFromJob($c['input'], !empty($c['images']), (int)$c['images_max']), $c['expected']);
}

// utf8Prefix without mbstring must agree with mb_substr on valid UTF-8
$check('utf8', 'prefix', RcNode\utf8Prefix("\u{00C4}bc\u{20AC}def", 4), "\u{00C4}bc\u{20AC}");

ksort($bySection);
$parts = [];
foreach ($bySection as $k => $n) { $parts[] = "$k $n"; }
echo 'unit: ' . ($bad ? 'FAILED' : 'ok') . " - $ok passed, $bad failed (" . implode(', ', $parts) . ")\n";
exit($bad ? 1 : 0);
