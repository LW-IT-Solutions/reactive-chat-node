<?php
// Generates conformance/vectors.json by RUNNING the reference functions (lade.php).
require __DIR__ . '/lade.php';

$NBSP = "\xC2\xA0"; $NNBSP = "\xE2\x80\xAF"; $THIN = "\xE2\x80\x89";
$LDQ = "\xE2\x80\x9C"; $RDQ = "\xE2\x80\x9D"; $LOW = "\xE2\x80\x9E"; $LAQ = "\xC2\xAB"; $RAQ = "\xC2\xBB";
$UE = "\xC3\xBC"; $OE = "\xC3\xB6"; $SZ = "\xC3\x9F"; $NDASH = "\xE2\x80\x93"; $LS = "\xE2\x80\xA8"; $EURO = "\xE2\x82\xAC";

$V = [
    'version' => 1,
    'generated_from' => 'reference/rc-knoten.php v1.3 (functions executed verbatim by PHP ' . PHP_VERSION . ')',
    'notes' => [
        'All strings are UTF-8. Non-ASCII characters are written as \\u escapes.',
        'Byte streams (sse.chunks_b64) are base64 because a chunk may end inside a UTF-8 sequence.',
        'Regex semantics of the reference (PCRE via PHP): a pattern with the /u flag is Unicode-aware (\\s, \\d, \\b, \\R match Unicode); a pattern WITHOUT /u is ASCII/byte based. trim() strips only " \\t\\n\\r\\0\\x0B". See PROTOCOL.md.',
    ],
    'retry_suffix' => $RETRY_SUFFIX,
    'constants' => [
        'signature_prefix' => "RC-KI-v2\n",
        'signature_window_s' => 300,
        'heartbeat_s' => 45,
        'backoff' => 'min(300, 5 * consecutive_failures) seconds',
        'teil_max_entries' => 8,
        'teil_max_bytes' => 16000,
        'stream_ms_min' => 100,
        'poll_wait_max' => 60,
        'image_max_bytes' => 4194304,
        'probe_system' => 'Antworte mit genau einem Wort.',
        'probe_prompt' => 'Sag: Bereit',
        'probe_max_tokens' => 20,
        'embed_probe_input' => ['Bereit'],
    ],
];

// ---------------------------------------------------------------- signature
$sig = [
    ['name' => 'get_hol_probe', 'secret' => 'rcn_test_secret_0123456789abcdef', 'ts' => '1790000000', 'method' => 'GET',
     'path' => '/v1/ki', 'query' => 'action=hol&knoten=kn-0123456789abcdef&n=0&warte=0&arten=chat&kann=chat&nonce=00112233aabbccdd', 'body' => ''],
    ['name' => 'get_hol_longpoll', 'secret' => 'rcn_test_secret_0123456789abcdef', 'ts' => '1790000001', 'method' => 'GET',
     'path' => '/v1/ki', 'query' => 'action=hol&knoten=kn-0123456789abcdef&n=3&warte=20&arten=chat%2Cuebersetzung&kann=chat%2Cuebersetzung%2Ceinbettung&bilder=1&nonce=0f1e2d3c4b5a6978', 'body' => ''],
    ['name' => 'get_heartbeat', 'secret' => 'rcn_other', 'ts' => '1790000002', 'method' => 'GET',
     'path' => '/v1/ki', 'query' => 'action=hol&knoten=kn-abc&n=0&warte=0&kann=chat&nonce=ffffffffffffffff', 'body' => ''],
    ['name' => 'post_bring_utf8', 'secret' => 'rcn_test_secret_0123456789abcdef', 'ts' => '1790000003', 'method' => 'POST',
     'path' => '/v1/ki', 'query' => 'action=bring&knoten=kn-0123456789abcdef&nonce=a1b2c3d4e5f60718',
     'body' => json_encode(['ergebnisse' => [['id' => 17, 'text' => "Gr{$UE}{$SZ}e {$NDASH} sch{$OE}n, 49 {$EURO}", 'grund' => '',
                                                 'modell' => 'mistral', 'ms' => 812, 'knoten' => 'kn-0123456789abcdef']]], JSON_UNESCAPED_UNICODE)],
    ['name' => 'post_bring_failure', 'secret' => 'rcn_test_secret_0123456789abcdef', 'ts' => '1790000004', 'method' => 'POST',
     'path' => '/v1/ki', 'query' => 'action=bring&knoten=kn-0123456789abcdef&nonce=1111222233334444',
     'body' => json_encode(['ergebnisse' => [['id' => 5, 'text' => '', 'grund' => 'erfundene Zahl: 59',
                                                 'modell' => 'm', 'ms' => 1500, 'knoten' => 'kn-0123456789abcdef']]], JSON_UNESCAPED_UNICODE)],
    ['name' => 'post_teil', 'secret' => 'rcn_x', 'ts' => '1790000005', 'method' => 'POST',
     'path' => '/v1/ki', 'query' => 'action=teil&knoten=kn-0123456789abcdef&nonce=5555666677778888',
     'body' => json_encode(['teile' => [['id' => 17, 'n' => 1, 'text' => "Wir {$OE}ffnen "]]], JSON_UNESCAPED_UNICODE)],
    ['name' => 'subpath_base_url', 'secret' => 'rcn_test_secret_0123456789abcdef', 'ts' => '1790000006', 'method' => 'GET',
     'path' => '/staging/v1/ki', 'query' => 'action=hol&knoten=kn-0123456789abcdef&n=1&warte=20&arten=chat&kann=chat&nonce=0000000000000000', 'body' => ''],
];
foreach ($sig as &$s) {
    $s['string_to_sign'] = "RC-KI-v2\n" . $s['ts'] . "\n" . $s['method'] . "\n" . $s['path'] . "\n" . $s['query'] . "\n" . $s['body'];
    $s['expected_hex'] = refSig($s['secret'], $s['ts'], $s['method'], $s['path'], $s['query'], $s['body']);
    // independent cross-check with openssl-free recomputation
    if (hash_hmac('sha256', $s['string_to_sign'], $s['secret']) !== $s['expected_hex']) { fwrite(STDERR, "sig mismatch\n"); exit(4); }
}
unset($s);
$V['signature'] = $sig;

// ---------------------------------------------------------------- clean
$clean = [
    ['think_block', "<think>Ich {$UE}berlege...</think>Die Antwort ist 42."],
    ['think_multiline', "<think>\nline1\nline2\n</think>\n\nHallo"],
    ['think_unclosed', "<think>unfertig ohne Ende"],
    ['html_tags', "Hallo <b>Welt</b>!"],
    ['angle_brackets_math', "a > b and c < d"],
    ['angle_brackets_pair', "x < y > z"],
    ['markdown', "**Fett** und __unter__ und `code` und # Titel"],
    ['markdown_heading_lines', "## Oeffnungszeiten\n\n- Mo: 9 Uhr\n- Di: 10 Uhr"],
    ['lead_in_de_ist', "Hier ist die Antwort: Wir {$OE}ffnen um 9 Uhr."],
    ['lead_in_de_sind', "Hier sind die Details: A und B"],
    ['lead_in_de_case', "HIER IST, was ich wei{$SZ}: Ja."],
    ['lead_in_en_is', "Here is the answer: We open at 9."],
    ['lead_in_en_are_newline', "Here are the facts:\nA and B"],
    ['lead_in_antwort', "Antwort: Ja."],
    ['lead_in_answer_upper', "ANSWER: yes"],
    ['lead_in_not_at_start', "Die Antwort: 42"],
    ['lead_in_only_once', "Antwort: Antwort: doppelt"],
    ['lead_in_after_think', "<think>x</think>  Here is my reply: Fine."],
    ['only_lead_in', "Antwort: <think>x</think>"],
    ['quotes_german', "{$LOW}Das ist zitiert.{$LDQ}"],
    ['quotes_english', "{$LDQ}Quoted text.{$RDQ}"],
    ['quotes_guillemets', "{$LAQ}Guillemets{$RAQ}"],
    ['quotes_straight', "\"Straight\""],
    ['quotes_unclosed', "{$LOW}Unclosed quote"],
    ['quotes_two_quoted_parts', "{$LOW}a{$LDQ} und {$LOW}b{$LDQ}"],
    ['lead_in_then_quote', "Hier ist die Antwort: {$LOW}Wir {$OE}ffnen um 9 Uhr.{$LDQ}"],
    ['newlines', "Zeile 1\nZeile 2\r\nZeile 3\rZeile 4"],
    ['double_spaces', "Zu   viele    Leerzeichen"],
    ['tabs_and_outer_ws', "  \t Hallo \t Welt \n "],
    ['nbsp_runs', "a{$NBSP}{$NBSP}b und c{$NBSP}d"],
    ['nbsp_edges', "{$NBSP}Hallo{$NBSP}"],
    ['unicode_line_separator', "a{$LS}b"],
    ['keine_antwort', "KEINE_ANTWORT"],
    ['empty', ""],
    ['numbered_list', "Here is a list:\n1. A\n2. B"],
    ['lead_in_without_colon', "Hier ist alles gut."],
    ['lead_in_heres_not_matched', "Here's the answer: yes"],
    ['lead_in_colon_on_next_line', "Hier ist\nAntwort: ja"],
];
$V['clean'] = [];
foreach ($clean as [$n, $in]) { $V['clean'][] = ['name' => $n, 'input' => $in, 'expected' => saeubern($in)]; }

// ---------------------------------------------------------------- numbers
$num = [
    ['same_number', 'Das kostet 49 Euro.', 'Preis: 49 EUR'],
    ['invented', 'Das kostet 59 Euro.', 'Preis: 49 EUR'],
    ['sep_space', 'Wir haben 1 000 Nutzer.', '1000 Nutzer'],
    ['sep_dot', 'Wir haben 1.000 Nutzer.', '1000 Nutzer'],
    ['sep_comma', 'Wir haben 1,000 Nutzer.', '1000 Nutzer'],
    ['sep_nbsp', "Wir haben 1{$NBSP}000 Nutzer.", '1000 Nutzer'],
    ['sep_narrow_nbsp', "Wir haben 1{$NNBSP}000 Nutzer.", '1 000 Nutzer'],
    ['sep_thin', "Wir haben 1{$THIN}000 Nutzer.", '1.000 Nutzer'],
    ['facts_have_separator', 'Es sind 10000 Stueck.', '10 000 Stueck'],
    ['millions', '1.000.000 Besucher', '1000000'],
    ['phone', 'Tel. 0800 123 456', 'Telefon 0800123456'],
    ['decimal_comma', '1,5 Stunden', '1 Stunde'],
    ['not_a_thousands_group', '12 34', '1234'],
    ['four_digits_after_space', '1 0000', '10000'],
    ['money_de', "1.234,56 {$EURO}", 'Preis 1234,56'],
    ['version', 'Version 2.0.1', 'Version 2.0.1'],
    ['date_reordered', 'am 2024-09-30', 'Stand 30.09.2024'],
    ['leading_zero_matters', 'am 9. Mai', 'am 09. Mai'],
    ['no_digits', 'Keine Zahlen hier.', ''],
    ['empty_text', '', '123'],
    ['fullwidth_digits_ignored', "Preis \xEF\xBC\x91\xEF\xBC\x92\xEF\xBC\x93", ''],
    ['first_offender_reported', 'Zwischen 7 und 8 Uhr, 9 Tage', '7'],
];
$V['numbers'] = [];
foreach ($num as [$n, $t, $f]) { $V['numbers'][] = ['name' => $n, 'text' => $t, 'facts' => $f, 'expected' => zahlenPruefen($t, $f)]; }

// ---------------------------------------------------------------- stream_cut
$cut = [
    ['two_words', 'Hallo Welt'],
    ['trailing_space', 'Hallo Welt '],
    ['no_whitespace', 'Hallo'],
    ['empty', ''],
    ['newline', "abc\ndef"],
    ['tab', "a\tb"],
    ['carriage_return', "a\rb"],
    ['thousands_space_inside', 'Preis 1 000'],
    ['digit_space_at_end', 'Es sind 12 '],
    ['digit_space_letter', 'Es sind 12 Tage'],
    ['letter_space_digit', 'Seite 3'],
    ['multibyte', "Gr{$UE}{$SZ}e an alle"],
    ['nbsp_is_not_a_cut', "a{$NBSP}b"],
    ['only_space', ' '],
    ['digit_space_digit_then_word', 'um 1 000 Uhr'],
];
$V['stream_cut'] = [];
foreach ($cut as [$n, $t]) { $V['stream_cut'][] = ['name' => $n, 'input' => $t, 'expected' => stromSchnitt($t)]; }

// ---------------------------------------------------------------- sse
function d($content, $finish = null) {
    $c = ['index' => 0, 'delta' => ['content' => $content]];
    if ($finish !== null) { $c['finish_reason'] = $finish; }
    return 'data: ' . json_encode(['id' => 'x', 'object' => 'chat.completion.chunk', 'choices' => [$c]], JSON_UNESCAPED_UNICODE) . "\n\n";
}
$role = 'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}' . "\n\n";
$fin  = 'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}' . "\n\n";
$done = "data: [DONE]\n\n";
$mb = $role . d("Gr{$UE}{$SZ}e ") . d("{$NDASH} sch{$OE}n") . $fin . $done;
$posUe = strpos($mb, "\xC3\xBC") + 1;     // inside the u-umlaut
$posDash = strpos($mb, "\xE2\x80\x93") + 2; // inside the en dash
$crlf = str_replace("\n", "\r\n", $role . d('Hallo') . d(' Welt') . $fin . $done);
$posCR = strpos($crlf, "\r\n") + 1;        // between \r and \n
$sse = [
    ['basic_one_chunk', $role . d('Hallo') . d(' Welt') . $fin . $done, 'one'],
    ['basic_7_byte_chunks', $role . d('Hallo') . d(' Welt') . $fin . $done, 7],
    ['byte_by_byte', $role . d('Ja.') . $done, 1],
    ['split_inside_multibyte', $mb, [$posUe, $posDash]],
    ['crlf_split_between_cr_lf', $crlf, [$posCR, $posCR + 40]],
    ['no_space_after_data_comments_events', ": keep-alive\n\nevent: message\nid: 1\ndata:{\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\nretry: 1000\ndata:  {\"choices\":[{\"delta\":{\"content\":\"B\"}}]}  \n\ndata:[DONE]\n\n", 'one'],
    ['finish_reason_without_done', $role . d('Nur') . d(' so', 'stop'), 'one'],
    ['no_trailing_newline', $role . d('Ende') . 'data: [DONE]', [10]],
    ['error_event_vllm', $role . d('Teil') . 'data: {"error":{"message":"out of memory","type":"InternalServerError","code":500}}' . "\n\n" . $done, 'one'],
    ['error_object_error', 'data: {"object":"error","message":"bad request","type":"BadRequestError","code":400}' . "\n\n", 'one'],
    ['error_string', 'data: {"error":"quota exceeded"}' . "\n\n" . $done, 'one'],
    ['no_termination', $role . d('abgebrochen'), 'one'],
    ['role_only_then_done', $role . $done, 'one'],
    ['empty_string_content', $role . d('') . $done, 'one'],
    ['content_null_ignored', 'data: {"choices":[{"delta":{"content":null}}]}' . "\n\n" . d('X') . $done, 'one'],
    ['invalid_json_line_ignored', "data: {kaputt\n\n" . d('OK') . $done, 'one'],
    ['content_after_done_still_appended', d('A') . $done . d('B'), 'one'],
    ['unicode_escapes_in_json', 'data: {"choices":[{"delta":{"content":"Gr\u00fc\u00dfe \ud83d\ude00"}}]}' . "\n\n" . $done, 'one'],
    ['indented_data_line_ignored', "  data: {\"choices\":[{\"delta\":{\"content\":\"X\"}}]}\n\n" . d('Y') . $done, 'one'],
    ['not_sse_plain_json', '{"id":"c","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Kein Strom"},"finish_reason":"stop"}]}', 'one'],
    ['not_sse_error_json', '{"error":{"message":"model not found"}}', 'one'],
];
$V['sse'] = [];
foreach ($sse as [$n, $raw, $how]) {
    if ($how === 'one') { $chunks = [$raw]; }
    elseif (is_int($how)) { $chunks = str_split($raw, $how); }
    else { $chunks = []; $prev = 0; foreach ($how as $p) { $chunks[] = substr($raw, $prev, $p - $prev); $prev = $p; } $chunks[] = substr($raw, $prev); }
    if (implode('', $chunks) !== $raw) { fwrite(STDERR, "chunk error $n\n"); exit(4); }
    $s = stromNeu();
    foreach ($chunks as $c) { stromFuettern($s, $c); }
    stromSchluss($s);
    $m = modellLesen(200, $s->roh, '', 0, $s);
    $V['sse'][] = ['name' => $n, 'chunks_b64' => array_map('base64_encode', $chunks),
                   'expected' => ['text' => $s->text, 'sse' => $s->sse, 'has_content' => $s->inhalt,
                                  'ended' => $s->ende, 'error' => $s->fehler],
                   'expected_result' => ['text' => $m['text'], 'fehler' => $m['fehler']]];
}

// ---------------------------------------------------------------- embed_result
$K = ['embed_modell' => 'bge-m3'];
$emb = [
    ['two_vectors_sorted_by_index', 200, json_encode(['object' => 'list', 'data' => [
        ['object' => 'embedding', 'index' => 1, 'embedding' => [0.5, -1.25, 3]],
        ['object' => 'embedding', 'index' => 0, 'embedding' => [0.1, 0.2, 0.3]]], 'model' => 'x']), '', 2, 'bge-m3'],
    ['float32_rounding_and_ints', 200, '{"data":[{"index":0,"embedding":[1,0,-0.0,1e-8,3.4028235e38,0.333333333333,-2.5]}]}', '', 1, 'bge-m3'],
    ['missing_index_counts_as_0', 200, '{"data":[{"embedding":[1,2]},{"index":1,"embedding":[3,4]}]}', '', 2, 'bge-m3'],
    ['model_label_non_ascii_is_escaped', 200, '{"data":[{"index":0,"embedding":[0.25]}]}', '', 1, "bge-m3-{$UE}/v2"],
    ['count_mismatch_fewer', 200, '{"data":[{"index":0,"embedding":[1,2]}]}', '', 2, 'bge-m3'],
    ['count_mismatch_more', 200, '{"data":[{"index":0,"embedding":[1]},{"index":1,"embedding":[2]}]}', '', 1, 'bge-m3'],
    ['unequal_lengths', 200, '{"data":[{"index":0,"embedding":[1,2]},{"index":1,"embedding":[3]}]}', '', 2, 'bge-m3'],
    ['empty_vector', 200, '{"data":[{"index":0,"embedding":[]}]}', '', 1, 'bge-m3'],
    ['no_data_field', 200, '{"object":"list"}', '', 1, 'bge-m3'],
    ['not_json', 200, 'Internal Server Error', '', 1, 'bge-m3'],
    ['http_500_long_multibyte_body', 500, str_repeat("{$UE}", 170) . 'ENDE', '', 1, 'bge-m3'],
    ['http_404', 404, '{"detail":"Not Found"}', '', 1, 'bge-m3'],
    ['transport_error', 0, '', 'Failed to connect to 127.0.0.1 port 8001: Connection refused', 1, 'bge-m3'],
];
$V['embed_result'] = [];
foreach ($emb as [$n, $code, $body, $err, $cnt, $model]) {
    $K['embed_modell'] = $model;
    [$res, $f] = einbettenLesen($code, $body, $err, $cnt);
    $V['embed_result'][] = ['name' => $n, 'http_status' => $code, 'body' => $body, 'transport_error' => $err,
                            'text_count' => $cnt, 'embed_model' => $model,
                            'expected_result' => $res, 'expected_error' => $f]
                          + ($err !== '' ? ['note' => 'transport error texts are implementation specific; only the prefix "Einbettungsserver nicht erreichbar: " is normative'] : []);
}
// sanity: decode first vector
$chk = json_decode($V['embed_result'][0]['expected_result'], true);
if (unpack('g3', base64_decode($chk['vektoren'][0]))[1] - 0.1 > 1e-6) { fwrite(STDERR, "vec order?\n"); exit(4); }

// ---------------------------------------------------------------- images
$J = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
$P = 'data:image/png;base64,iVBORw0KGgo=';
$W = 'data:image/webp;base64,UklGRg';
$G = 'data:image/gif;base64,R0lGODlh';
$img = [
    ['images_off', false, 1, [$J]],
    ['one_jpeg', true, 1, [$J]],
    ['max_1_takes_first', true, 1, [$J, $P]],
    ['max_2_skips_gif', true, 2, [$G, $P, $W]],
    ['max_2_of_3_valid', true, 2, [$J, $P, $W]],
    ['non_strings_skipped', true, 2, [123, null, ['x'], $J]],
    ['string_not_list', true, 1, $J],
    ['null_input', true, 1, null],
    ['space_in_base64', true, 1, ['data:image/jpeg;base64,AA AA']],
    ['empty_payload', true, 1, ['data:image/jpeg;base64,']],
    ['uppercase_mime_rejected', true, 1, ['data:image/JPEG;base64,AAAA']],
    ['url_not_data', true, 1, ['https://example.com/a.jpg']],
    ['padding_ok', true, 1, ['data:image/png;base64,AAA=']],
    ['padding_in_middle_rejected', true, 1, ['data:image/png;base64,AA=A']],
    ['trailing_newline_accepted_pcre_dollar', true, 1, ["data:image/png;base64,AAAA\n"]],
    ['max_0', true, 0, [$J]],
    ['max_negative', true, -1, [$J]],
    ['json_object_values_used', true, 1, ['a' => $J]],
    ['invalid_skipped_do_not_count', true, 1, [$G, 'x', $P]],
];
$V['images'] = [];
foreach ($img as [$n, $on, $max, $in]) {
    $K = ['bilder' => $on, 'bilder_max' => $max];
    $V['images'][] = ['name' => $n, 'images' => $on, 'images_max' => $max, 'input' => $in, 'expected' => bilderAusAuftrag($in)];
}
$V['images_note'] = 'An entry longer than image_max_bytes (4 MiB) is skipped. "input" is the job field "bilder" as decoded from JSON; a JSON object counts like a list of its values (PHP array). PCRE "$" also matches before one final "\\n".';

$out = json_encode($V, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
if ($out === false) { fwrite(STDERR, json_last_error_msg() . "\n"); exit(5); }
file_put_contents($argv[1], $out . "\n");
fwrite(STDERR, sprintf("signature=%d clean=%d numbers=%d stream_cut=%d sse=%d embed_result=%d images=%d\n",
    count($V['signature']), count($V['clean']), count($V['numbers']), count($V['stream_cut']),
    count($V['sse']), count($V['embed_result']), count($V['images'])));
