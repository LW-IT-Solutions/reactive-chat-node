<?php
// Loads selected functions VERBATIM from the reference (the reference file is not modified).
$REF = getenv("RC_REF") ?: dirname(__DIR__, 2) . "/reference/rc-knoten.php";
$src = file_get_contents($REF);
$code = '';
foreach (['zahlenPruefen', 'saeubern', 'bilderAusAuftrag', 'stromNeu', 'stromFuettern', 'stromSchluss',
          'stromZeile', 'stromSchnitt', 'modellLesen', 'einbettenLesen'] as $f) {
    if (!preg_match('/^function ' . $f . '\(.*?^\}\n/ms', $src, $m)) { fwrite(STDERR, "missing $f\n"); exit(3); }
    $code .= $m[0];
}
eval($code);
// The retry suffix: the concatenation expression that follows  $j['prompt'] .  in $anstossen.
$needle = '$j[\'prompt\'] . "';
$a0 = strpos($src, $needle);
if ($a0 === false) { fwrite(STDERR, "no suffix\n"); exit(3); }
$a0 += strlen($needle) - 1;
$a1 = strpos($src, ';', $a0);
$RETRY_SUFFIX = eval('return ' . substr($src, $a0, $a1 - $a0) . ';');
if (!is_string($RETRY_SUFFIX) || strpos($RETRY_SUFFIX, 'WICHTIG') === false) { fwrite(STDERR, "bad suffix\n"); exit(3); }

function refSig($secret, $ts, $method, $path, $query, $body)
{
    // formula copied from piHandle()
    return hash_hmac('sha256', "RC-KI-v2\n" . $ts . "\n" . $method . "\n" . $path . "\n" . $query . "\n" . (string)$body, $secret);
}
