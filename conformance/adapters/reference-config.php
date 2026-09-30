<?php
/**
 * CONTRACT.md JSON config -> legacy rc-knoten.conf.php (printed to stdout).
 * Only a key translation: validation stays with the reference itself, so a
 * missing key is left out and the reference reports it (exit 2).
 */
$datei = $argv[1] ?? '';
$roh = @file_get_contents($datei);
if ($roh === false) { fwrite(STDERR, "config file not readable: $datei\n"); exit(2); }
$j = json_decode($roh, true);
if (!is_array($j) || (array_is_list($j) && $j !== [])) { fwrite(STDERR, "config is not a JSON object: $datei\n"); exit(2); }

// Environment overrides (CONTRACT.md) - the reference has none.
foreach (['RC_NODE_SECRET' => 'secret', 'RC_NODE_MODEL_API_KEY' => 'model_api_key'] as $env => $key) {
    $v = getenv($env);
    if ($v !== false && $v !== '') { $j[$key] = $v; }
}

$map = [
    'base_url' => 'basis', 'node_id' => 'knoten', 'secret' => 'geheim', 'model' => 'modell',
    'model_endpoint' => 'endpunkt', 'chat_url' => 'chat_url', 'model_api_key' => 'modell_schluessel',
    'model_key_header' => 'schluessel_kopf', 'kinds' => 'arten', 'capabilities' => 'kann',
    'embed_url' => 'embed_url', 'embed_model' => 'embed_modell', 'embed_timeout' => 'embed_wartezeit',
    'images' => 'bilder', 'images_max' => 'bilder_max', 'stream' => 'strom', 'stream_ms' => 'strom_ms',
    'concurrency' => 'gleichzeitig', 'poll_wait' => 'warte', 'timeout' => 'wartezeit',
    'temperature' => 'temperatur', 'max_tokens' => 'max_tokens', 'basic_auth' => 'basic',
    'resolve' => 'resolve', 'tls_verify' => 'tls_pruefen', 'log_file' => 'protokoll', 'timezone' => 'zeitzone',
];
$alias = ['translation' => 'uebersetzung', 'summary' => 'zusammenfassung', 'embedding' => 'einbettung'];

// CONTRACT default for log_file is "" (stdout only); the reference would write next to itself.
$K = ['protokoll' => ''];
foreach ($map as $en => $de) {
    if (!array_key_exists($en, $j)) { continue; }
    $v = $j[$en];
    if ($en === 'kinds' || $en === 'capabilities') {
        $v = array_values(array_map(static function ($a) use ($alias) { return $alias[$a] ?? $a; }, (array)$v));
    }
    $K[$de] = $v;
}
echo "<?php\nreturn " . var_export($K, true) . ";\n";
