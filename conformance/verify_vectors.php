<?php
/**
 * Re-checks conformance/vectors.json against the REFERENCE implementation.
 *
 *   php conformance/verify_vectors.php [path/to/vectors.json]
 *
 * The functions are loaded verbatim from reference/rc-knoten.php (the file is
 * not modified and not executed as a whole). Exit 0 = every vector matches.
 */
$root = dirname(__DIR__);
$REF  = $root . '/reference/rc-knoten.php';
$file = $argv[1] ?? __DIR__ . '/vectors.json';

$src = file_get_contents($REF);
$code = '';
foreach (['zahlenPruefen', 'saeubern', 'bilderAusAuftrag', 'stromNeu', 'stromFuettern', 'stromSchluss',
          'stromZeile', 'stromSchnitt', 'modellLesen', 'einbettenLesen'] as $f) {
    if (!preg_match('/^function ' . $f . '\(.*?^\}\n/ms', $src, $m)) { fwrite(STDERR, "missing $f in reference\n"); exit(3); }
    $code .= $m[0];
}
eval($code);
$needle = '$j[\'prompt\'] . "';
$a0 = strpos($src, $needle) + strlen($needle) - 1;
$a1 = strpos($src, ';', $a0);
$RETRY_SUFFIX = eval('return ' . substr($src, $a0, $a1 - $a0) . ';');

$raw = file_get_contents($file);
if (preg_match('/[\x80-\xFF]/', $raw)) { fwrite(STDERR, "vectors.json contains raw non-ASCII bytes\n"); exit(1); }
$V = json_decode($raw, true);
if (!is_array($V)) { fwrite(STDERR, "vectors.json does not parse\n"); exit(1); }

$ok = 0; $bad = 0;
$pruef = function ($sec, $name, $ist, $soll) use (&$ok, &$bad) {
    if ($ist === $soll) { $ok++; return; }
    $bad++;
    echo "FAIL $sec/$name: got " . json_encode($ist, JSON_UNESCAPED_UNICODE) . ' want ' . json_encode($soll, JSON_UNESCAPED_UNICODE) . "\n";
};

$pruef('retry_suffix', '-', $RETRY_SUFFIX, $V['retry_suffix']);
foreach ($V['signature'] as $c) {
    $pruef('signature', $c['name'], hash_hmac('sha256',
        "RC-KI-v2\n" . $c['ts'] . "\n" . $c['method'] . "\n" . $c['path'] . "\n" . $c['query'] . "\n" . $c['body'],
        $c['secret']), $c['expected_hex']);
}
foreach ($V['clean'] as $c)      { $pruef('clean', $c['name'], saeubern($c['input']), $c['expected']); }
foreach ($V['numbers'] as $c)    { $pruef('numbers', $c['name'], zahlenPruefen($c['text'], $c['facts']), $c['expected']); }
foreach ($V['stream_cut'] as $c) { $pruef('stream_cut', $c['name'], stromSchnitt($c['input']), $c['expected']); }
foreach ($V['sse'] as $c) {
    $s = stromNeu();
    foreach ($c['chunks_b64'] as $b) { stromFuettern($s, base64_decode($b)); }
    stromSchluss($s);
    $pruef('sse', $c['name'], ['text' => $s->text, 'sse' => $s->sse, 'has_content' => $s->inhalt,
                               'ended' => $s->ende, 'error' => $s->fehler], $c['expected']);
    $m = modellLesen(200, $s->roh, '', 0, $s);
    $pruef('sse', $c['name'] . '/result', ['text' => $m['text'], 'fehler' => $m['fehler']], $c['expected_result']);
}
foreach ($V['embed_result'] as $c) {
    $GLOBALS['K'] = ['embed_modell' => $c['embed_model']];
    [$r, $f] = einbettenLesen($c['http_status'], $c['body'], $c['transport_error'], $c['text_count']);
    $pruef('embed_result', $c['name'], [$r, $f], [$c['expected_result'], $c['expected_error']]);
}
foreach ($V['images'] as $c) {
    $GLOBALS['K'] = ['bilder' => $c['images'], 'bilder_max' => $c['images_max']];
    $pruef('images', $c['name'], bilderAusAuftrag($c['input']), $c['expected']);
}
echo "vectors ok=$ok fail=$bad\n";
exit($bad ? 1 : 0);
