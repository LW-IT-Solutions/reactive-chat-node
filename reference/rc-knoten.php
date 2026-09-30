<?php
/**
 * reactive.chat - eigener KI-Knoten ("bring your own model")
 * ===========================================================================
 * Dieses Skript laeuft auf IHREM Rechner. Es holt die KI-Auftraege Ihres
 * Workspace bei reactive.chat ab, laesst sie von IHREM Sprachmodell
 * beantworten und liefert die Saetze zurueck. Das Sprachmodell spricht
 * dabei nur mit diesem Skript; reactive.chat baut nie eine Verbindung zu
 * Ihrem Rechner auf - der Knoten ruft an, nicht umgekehrt. Er braucht also
 * keine oeffentliche Adresse, keine Portfreigabe und keine feste IP.
 *
 * WAS SIE BRAUCHEN
 *   - PHP 8.1 oder neuer auf der Kommandozeile, mit den Erweiterungen curl
 *     und json (Debian/Ubuntu: apt install php-cli php-curl).
 *   - Ein Sprachmodell hinter einer OpenAI-kompatiblen Schnittstelle
 *     (/v1/chat/completions): vLLM, Ollama (/v1), LM Studio, llama.cpp
 *     (llama-server) oder Azure OpenAI.
 *   - Kennung und Geheimnis des Knotens aus dem Kundenbereich
 *     (/app/ai-node). Das Geheimnis wird dort genau einmal angezeigt.
 *
 * EINRICHTEN
 *   1. rc-knoten.conf.beispiel.php nach rc-knoten.conf.php kopieren und
 *      ausfuellen (Kennung, Geheimnis, Modellserver, Modellname).
 *      chmod 600 rc-knoten.conf.php - darin steht Ihr Geheimnis.
 *   2. php rc-knoten.php --probe        prueft beide Seiten, nimmt nichts weg
 *   3. php rc-knoten.php --dauer        laeuft dauerhaft (systemd, siehe unten)
 *
 *   php rc-knoten.php --konf=/pfad/zur.conf.php --dauer   andere Konfiguration
 *   php rc-knoten.php --einer                             genau ein Auftrag, ausfuehrlich
 *
 * systemd (Beispiel, /etc/systemd/system/rc-knoten.service):
 *   [Unit]
 *   Description=reactive.chat KI-Knoten
 *   After=network-online.target
 *   [Service]
 *   User=rcknoten
 *   ExecStart=/usr/bin/php /opt/rc-knoten/rc-knoten.php --dauer
 *   Restart=always
 *   RestartSec=15
 *   [Install]
 *   WantedBy=multi-user.target
 *
 * WAS DER KNOTEN BEKOMMT UND WAS ER NICHT BEKOMMT
 *   - Nur Auftraege IHRES Workspace. Der Server ordnet jeden Auftrag einem
 *     Workspace zu und gibt ihn nur an dessen Knoten heraus.
 *   - Er schreibt nie selbst in ein Gespraech. Was er liefert, ist ein
 *     VORSCHLAG: reactive.chat prueft ihn (jede Zahl der Antwort muss in den
 *     Quellen stehen) und faellt sonst auf Zitat oder Uebergabe zurueck.
 *   - Einbettungen (Vektoren fuer die Wissenssuche) nur, wenn Sie einen
 *     Einbettungsserver angeben ('embed_url', OpenAI-Bauart /v1/embeddings)
 *     und der Workspace auf "nur eigener Knoten" steht. Dann rechnet Ihr
 *     Modell die Vektoren fuer Ihre Wissensbasis UND fuer jede Besucherfrage;
 *     ohne ihn sucht die Wissensbasis ueber Woerter. Am besten in einem
 *     zweiten Prozess mit 'arten' => ['einbettung'] (eigene Konfiguration,
 *     --konf=), damit keine Chatfrage hinter einem Stapel wartet - beide mit
 *     'kann' => ['chat', 'einbettung'].
 *   - Bilder, die Besucher anhaengen, nur mit 'bilder' => true - und das nur,
 *     wenn Ihr Modellserver ein VISION-MODELL geladen hat (vLLM: gestartet mit
 *     --limit-mm-per-prompt '{"image":1}'). Dann fragt der Knoten mit
 *     &bilder=1 und bekommt das Bild als verkleinerte JPEG-data:-URL (768 px,
 *     neu kodiert, also ohne EXIF/GPS) in der Auftragszeile. Ohne 'bilder'
 *     bekommt Ihr Modell statt des Bildes nur einen Hinweis, dass eines da
 *     war - ein reines Textmodell scheiterte an einem Bild mit HTTP 400.
 *   - Seit Version 1.3 Antworten im Strom ('strom', Vorgabe an): fragt
 *     reactive.chat eine Antwort als Strom an, liest der Knoten sie per SSE
 *     (stream:true) mit und schickt den bisherigen Text alle 'strom_ms' als
 *     Teil (action=teil), damit der Besucher sie wachsen sieht. Massgeblich
 *     bleibt die fertige Antwort; sie wird geprueft wie bisher.
 *
 * SIGNATUR: jede Anfrage traegt eine HMAC-SHA256-Signatur mit Ihrem
 * Geheimnis ueber "RC-KI-v2\n" + Zeit + "\n" + Methode + "\n" + Pfad + "\n" +
 * Query + "\n" + Rumpf, dazu eine Zufallszahl (nonce) in der Query. Eine
 * Signatur gilt fuenf Minuten und genau einmal - die Uhr dieses Rechners
 * muss also stimmen (NTP).
 *
 * Grundlage ist der Worker, mit dem reactive.chat seine eigenen Knoten
 * betreibt (Long-Poll, mehrere Auftraege gleichzeitig, Scheitern wird
 * gemeldet statt liegengelassen). Dieses Skript enthaelt keine Schluessel
 * von reactive.chat; alles, was es braucht, steht in Ihrer Konfiguration.
 */

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

// 1.3 (28.09.2026): Antworten im Strom ('strom', 'strom_ms').
const RC_KNOTEN_VERSION = '1.3';

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
$konfDatei = __DIR__ . '/rc-knoten.conf.php';
foreach ($argv as $a) {
    if (strpos($a, '--konf=') === 0) { $konfDatei = substr($a, 7); }
}
if (!is_readable($konfDatei)) {
    fwrite(STDERR, "Es fehlt " . $konfDatei . ".\n"
                 . "rc-knoten.conf.beispiel.php kopieren, ausfuellen und chmod 600 setzen.\n");
    exit(2);
}
$K = require $konfDatei;
if (!is_array($K)) { fwrite(STDERR, "Die Konfiguration muss ein Array zurueckgeben.\n"); exit(2); }

foreach (['basis', 'knoten', 'geheim', 'modell'] as $pflicht) {
    if (empty($K[$pflicht])) {
        fwrite(STDERR, "In der Konfiguration fehlt '" . $pflicht . "'.\n");
        exit(2);
    }
}
if (empty($K['endpunkt']) && empty($K['chat_url'])) {
    fwrite(STDERR, "In der Konfiguration fehlt 'endpunkt' (oder 'chat_url' fuer Azure).\n");
    exit(2);
}
if (strpos((string)$K['knoten'], 'kn-') !== 0) {
    fwrite(STDERR, "'knoten' muss mit kn- beginnen - so, wie der Kundenbereich die Kennung anzeigt.\n");
    exit(2);
}

$K += [
    'endpunkt'          => '',
    'chat_url'          => '',
    'modell_schluessel' => '',
    'schluessel_kopf'   => 'Authorization',
    'arten'             => ['chat'],
    // Was der Knoten insgesamt kann, wenn er seine Arten auf zwei Prozesse
    //  verteilt ('arten' = was DIESER Prozess abholt). Leer = 'arten'.
    'kann'              => [],
    // Einbettungen (27.09.2026): volle Adresse, z. B.
    //  'http://127.0.0.1:8001/v1/embeddings', und der Name, unter dem die
    //  Vektoren abgelegt werden. Der Name trennt die Vektorraeume - er muss
    //  gleich bleiben, solange dasselbe Modell rechnet.
    'embed_url'         => '',
    'embed_modell'      => '',
    'embed_wartezeit'   => 120,
    // Bilder (27.09.2026): true NUR mit einem Vision-Modell - siehe oben
    //  und rc-knoten.conf.beispiel.php. VORGABE false = Verhalten von 1.1.
    'bilder'            => false,
    // Hoechstens so viele Bilder je Anfrage - muss zu vLLMs
    //  --limit-mm-per-prompt passen. reactive.chat schickt heute hoechstens 1.
    'bilder_max'        => 1,
    // Strom (seit 1.3): Auftraege mit 'strom' als SSE beim Modell abholen und
    //  den bisherigen Text alle 'strom_ms' als Teil an reactive.chat schicken.
    //  false = nie. Ohne 'strom' im Auftrag fragt der Knoten wie in 1.2.
    'strom'             => true,
    'strom_ms'          => 400,
    'gleichzeitig'      => 1,
    'warte'             => 20,
    'wartezeit'         => 120,
    'temperatur'        => 0.2,
    'max_tokens'        => 300,
    'basic'             => '',
    'resolve'           => '',
    'tls_pruefen'       => true,
    'protokoll'         => __DIR__ . '/rc-knoten.log',
    'zeitzone'          => '',
];
if ($K['zeitzone'] !== '') { @date_default_timezone_set($K['zeitzone']); }
if (in_array('einbettung', (array)$K['arten'], true)
    && ($K['embed_url'] === '' || $K['embed_modell'] === '')) {
    fwrite(STDERR, "'arten' enthaelt 'einbettung' - dann braucht es 'embed_url' und 'embed_modell'.\n");
    exit(2);
}
$KANN = (array)($K['kann'] ?: $K['arten']);

$DAUER = in_array('--dauer', $argv, true);
$PROBE = in_array('--probe', $argv, true);
$EINER = in_array('--einer', $argv, true);
/* true, sobald reactive.chat 'teil' mit 400/404 ablehnt (Stand ohne Strom) -
   dann streamt dieser Prozess nicht mehr, bis er neu startet. */
$STROM_AUS = false;

// ---------------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------------
function sagen($zeile)
{
    global $K;
    $z = date('Y-m-d H:i:s') . '  ' . $zeile . "\n";
    echo $z;
    if ($K['protokoll'] !== '') { @file_put_contents($K['protokoll'], $z, FILE_APPEND); }
}

/**
 * Jede Ziffernfolge der Antwort muss in den Quellen stehen - dieselbe Regel,
 * die reactive.chat beim Abliefern prueft. Hier nur aus Sparsamkeit: ein
 * Satz, der ohnehin abgelehnt wuerde, bekommt einen zweiten Anlauf.
 */
function zahlenPruefen($text, $fakten)
{
    $ziffern = function ($s) {
        $s = preg_replace('/(\d)[ .,\x{00A0}\x{202F}\x{2009}](?=\d\d\d\b)/u', '$1', $s);
        preg_match_all('/\d+/', $s, $m);
        return $m[0];
    };
    $erlaubt = array_flip($ziffern($fakten));
    foreach ($ziffern($text) as $z) {
        if (!isset($erlaubt[$z])) { return $z; }
    }
    return null;
}

/** Denkbloecke, Markdown und Vorreden weg. */
function saeubern($text)
{
    $t = (string)$text;
    $t = preg_replace('/<think>.*?<\/think>/su', ' ', $t);
    $t = preg_replace('/<[^>]*>/', ' ', $t);
    $t = str_replace(['**', '__', '`', '#'], '', $t);
    $t = trim($t);
    $t = preg_replace('/^\s*(hier (ist|sind)[^:\n]*:|here (is|are)[^:\n]*:|antwort:|answer:)\s*/i', '', $t);
    $t = trim($t);
    if (preg_match('/^["\x{201C}\x{201E}\x{00AB}](.*)["\x{201D}\x{201C}\x{00BB}]$/us', $t, $m)) {
        $t = trim($m[1]);
    }
    $t = preg_replace('/\s*\R\s*/u', ' ', $t);
    return trim(preg_replace('/\s{2,}/u', ' ', $t));
}

function curlGemeinsam(array &$opt)
{
    global $K;
    if ($K['resolve'] !== '') { $opt[CURLOPT_RESOLVE] = (array)$K['resolve']; }
    if (!$K['tls_pruefen']) {
        $opt[CURLOPT_SSL_VERIFYPEER] = false;
        $opt[CURLOPT_SSL_VERIFYHOST] = 0;
    }
}

// ---------------------------------------------------------------------------
// Die Leitung zu reactive.chat
// ---------------------------------------------------------------------------
function piHandle($aktion, $rumpf = null, $zusatz = '', $fristS = 60)
{
    global $K;
    $ts = (string)time();
    /* DIE NONCE: zwei Abrufe mit denselben Parametern in derselben Sekunde
       haetten sonst dieselbe Signatur, und der Server weist die zweite als
       Wiederholung ab. Sie steht in der Query und ist damit mitsigniert. */
    $url = rtrim($K['basis'], '/') . '/v1/ki?action=' . $aktion
         . '&knoten=' . rawurlencode($K['knoten']) . $zusatz
         . '&nonce=' . bin2hex(random_bytes(8));
    $teile   = parse_url($url);
    $pfad    = (string)($teile['path']  ?? '/');
    $query   = (string)($teile['query'] ?? '');
    $methode = $rumpf !== null ? 'POST' : 'GET';
    $sig = hash_hmac('sha256',
                     "RC-KI-v2\n" . $ts . "\n" . $methode . "\n" . $pfad . "\n" . $query . "\n"
                   . (string)$rumpf,
                     $K['geheim']);

    $ch = curl_init($url);
    $opt = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['X-RC-KI-TS: ' . $ts, 'X-RC-KI-SIG: ' . $sig,
                                   'Content-Type: application/json',
                                   'User-Agent: rc-knoten/' . RC_KNOTEN_VERSION],
        CURLOPT_TIMEOUT        => $fristS,
        CURLOPT_CONNECTTIMEOUT => 15,
    ];
    // NUR BEI EINEM RUMPF: CURLOPT_POSTFIELDS macht jede Anfrage zum POST,
    //  und dann stimmte die signierte Methode nicht mehr.
    if ($rumpf !== null) {
        $opt[CURLOPT_POST]       = true;
        $opt[CURLOPT_POSTFIELDS] = $rumpf;
    }
    if ($K['basic'] !== '') { $opt[CURLOPT_USERPWD] = $K['basic']; }
    curlGemeinsam($opt);
    curl_setopt_array($ch, $opt);
    return $ch;
}

function piLesen($code, $roh, $fehler)
{
    if ($fehler !== '') { return ['code' => 0, 'fehler' => $fehler, 'daten' => null, 'roh' => '']; }
    $daten = json_decode((string)$roh, true);
    return ['code' => (int)$code, 'fehler' => '', 'daten' => is_array($daten) ? $daten : null,
            'roh' => (string)$roh];
}

function anPi($aktion, $rumpf = null, $zusatz = '', $fristS = 60)
{
    $ch = piHandle($aktion, $rumpf, $zusatz, $fristS);
    $antwort = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $fehler = curl_error($ch);
    curl_close($ch);
    return piLesen($code, $antwort === false ? '' : (string)$antwort,
                   $antwort === false ? ($fehler !== '' ? $fehler : 'curl ohne Antwort') : '');
}

// ---------------------------------------------------------------------------
// Die Leitung zum Modell (OpenAI-Bauart)
// ---------------------------------------------------------------------------
function modellUrl()
{
    global $K;
    if ($K['chat_url'] !== '') { return $K['chat_url']; }
    return rtrim($K['endpunkt'], '/') . '/chat/completions';
}

function modellKopf()
{
    global $K;
    $kopf = ['Content-Type: application/json'];
    if ($K['modell_schluessel'] !== '') {
        $kopf[] = strcasecmp($K['schluessel_kopf'], 'Authorization') === 0
            ? 'Authorization: Bearer ' . $K['modell_schluessel']
            : $K['schluessel_kopf'] . ': ' . $K['modell_schluessel'];
    }
    return $kopf;
}

/**
 * Die Bilder eines Auftrags, wie reactive.chat sie schickt
 * (data:image/jpeg;base64,...) - geprueft und gedeckelt. Ohne 'bilder' in der
 * Konfiguration immer leer, egal was ankommt. Wortgleich mit dem Worker, mit
 * dem reactive.chat seine eigenen Knoten betreibt.
 */
function bilderAusAuftrag($roh)
{
    global $K;
    if (empty($K['bilder']) || !is_array($roh)) { return []; }
    $raus = [];
    foreach ($roh as $url) {
        if (count($raus) >= max(0, (int)$K['bilder_max'])) { break; }
        if (!is_string($url) || strlen($url) > 4 * 1024 * 1024) { continue; }
        if (!preg_match('~^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$~', $url)) { continue; }
        $raus[] = $url;
    }
    return $raus;
}

function modellHandle($system, $prompt, $maxTokens, $bilder = [], $strom = null)
{
    global $K;
    /* MIT BILD WIRD content ZUR LISTE (OpenAI-Bauart, die vLLM versteht):
       erst der Text, dann je Bild ein image_url. OHNE BILD BLEIBT ES DIE
       ZEICHENKETTE von vorher - ein Textmodell sieht dieselbe Anfrage wie
       mit Version 1.1. */
    $inhalt = (string)$prompt;
    if (is_array($bilder) && $bilder) {
        $inhalt = [['type' => 'text', 'text' => (string)$prompt]];
        foreach ($bilder as $url) {
            $inhalt[] = ['type' => 'image_url', 'image_url' => ['url' => (string)$url]];
        }
    }
    $koerper = json_encode([
        'model'       => $K['modell'],
        // Mit Strom-Zustand (stromNeu()) als SSE, sonst false wie immer.
        'stream'      => $strom !== null,
        'temperature' => (float)$K['temperatur'],
        'max_tokens'  => $maxTokens > 0 ? (int)$maxTokens : (int)$K['max_tokens'],
        'messages'    => [
            ['role' => 'system', 'content' => (string)$system],
            ['role' => 'user',   'content' => $inhalt],
        ],
    ], JSON_UNESCAPED_UNICODE);
    $ch = curl_init(modellUrl());
    $opt = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $koerper,
        CURLOPT_HTTPHEADER     => modellKopf(),
        CURLOPT_TIMEOUT        => (int)$K['wartezeit'],
        CURLOPT_CONNECTTIMEOUT => 10,
    ];
    /* STROM: die Bytes gehen in den Zustand statt in den Rueckgabepuffer.
       NACH CURLOPT_RETURNTRANSFER - PHP nimmt die zuletzt gesetzte Art. */
    if ($strom !== null) {
        $opt[CURLOPT_WRITEFUNCTION] = function ($h, $daten) use ($strom) {
            stromFuettern($strom, $daten);
            return strlen($daten);
        };
    }
    curl_setopt_array($ch, $opt);
    return $ch;
}

/** $strom: Zustand eines gestreamten Aufrufs (stromNeu()) oder null. */
function modellLesen($code, $roh, $fehler, $ms, $strom = null)
{
    if ($fehler !== '') { return ['text' => null, 'ms' => (int)$ms, 'fehler' => 'Modell nicht erreichbar: ' . $fehler]; }
    if ((int)$code !== 200) {
        return ['text' => null, 'ms' => (int)$ms,
                'fehler' => 'Modell HTTP ' . (int)$code . ': ' . mb_substr((string)$roh, 0, 160)];
    }
    /* STROM: kam SSE, steht der Text schon im Zustand. Kam keins (ein Server,
       der stream nicht kennt), geht es unten weiter wie bisher - $roh ist
       dann der mitgeschriebene Rumpf. */
    if ($strom !== null && $strom->sse) {
        if ($strom->fehler !== '') {
            return ['text' => null, 'ms' => (int)$ms, 'fehler' => 'Modell-Strom: ' . mb_substr($strom->fehler, 0, 160)];
        }
        if (!$strom->inhalt) { return ['text' => null, 'ms' => (int)$ms, 'fehler' => 'Antwort ohne Text']; }
        if (!$strom->ende)   { return ['text' => null, 'ms' => (int)$ms, 'fehler' => 'Strom ohne Abschluss']; }
        return ['text' => $strom->text, 'ms' => (int)$ms, 'fehler' => ''];
    }
    $wert = json_decode((string)$roh, true);
    foreach (['choices', 0, 'message', 'content'] as $schritt) {
        if (!is_array($wert) || !isset($wert[$schritt])) {
            return ['text' => null, 'ms' => (int)$ms, 'fehler' => 'Antwort ohne Text'];
        }
        $wert = $wert[$schritt];
    }
    return ['text' => (string)$wert, 'ms' => (int)$ms, 'fehler' => ''];
}

// ---------------------------------------------------------------------------
// Strom (seit 1.3)
//
// Ein Auftrag mit 'strom' soll beim Besucher wachsen, waehrend das Modell
// noch schreibt. Der Knoten fragt dafuer mit stream:true, liest die SSE-
// Zeilen mit (CURLOPT_WRITEFUNCTION) und schickt den bisherigen Text als
// Teil an reactive.chat (action=teil, siehe schleife()). Das ERGEBNIS
// entsteht wie immer: saeubern, Zahlenprobe, bring - ein Teil ist Vorschau,
// keine Lieferung. Wortgleich mit dem Worker von reactive.chat.
// ---------------------------------------------------------------------------
/** Zustand eines gestreamten Modellaufrufs, je Anlauf neu. */
function stromNeu()
{
    return (object)['roh' => '', 'puffer' => '', 'text' => '', 'sse' => false,
                    'inhalt' => false, 'ende' => false, 'fehler' => ''];
}

/**
 * Bytes vom Modell. Eine SSE-Zeile kann ueber zwei Stuecke gehen - deshalb
 * bis zum Zeilenende puffern, dann erst lesen. 'roh' schreibt mit
 * (gedeckelt), damit eine Antwort ohne SSE (Fehler-JSON, HTTP-Fehler) in
 * modellLesen() ausgewertet wird wie bisher.
 */
function stromFuettern($s, $daten)
{
    if (strlen($s->roh) < 4 * 1024 * 1024) { $s->roh .= $daten; }
    $s->puffer .= $daten;
    while (($p = strpos($s->puffer, "\n")) !== false) {
        stromZeile($s, rtrim(substr($s->puffer, 0, $p), "\r"));
        $s->puffer = (string)substr($s->puffer, $p + 1);
    }
}

/** Was nach dem letzten Zeilenende noch im Puffer steht - am Ende des Aufrufs. */
function stromSchluss($s)
{
    if ($s->puffer !== '') { stromZeile($s, rtrim($s->puffer, "\r")); $s->puffer = ''; }
}

/** Eine SSE-Zeile. Es zaehlen nur "data: {...}" und "data: [DONE]". */
function stromZeile($s, $zeile)
{
    if (strncmp($zeile, 'data:', 5) !== 0) { return; }
    $s->sse = true;
    $nutz = trim(substr($zeile, 5));
    if ($nutz === '[DONE]') { $s->ende = true; return; }
    $j = json_decode($nutz, true);
    if (!is_array($j)) { return; }
    // vLLM meldet einen Fehler mitten im Strom als eigenes Ereignis.
    if (isset($j['error']) || ($j['object'] ?? '') === 'error') {
        $f = $j['error'] ?? $j;
        $s->fehler = is_array($f) ? (string)($f['message'] ?? 'Fehler ohne Text') : (string)$f;
        return;
    }
    $c = $j['choices'][0] ?? null;
    if (!is_array($c)) { return; }
    if (isset($c['delta']['content']) && is_string($c['delta']['content'])) {
        $s->text  .= $c['delta']['content'];
        $s->inhalt = true;
    }
    if (!empty($c['finish_reason'])) { $s->ende = true; }
}

/**
 * Der Text bis einschliesslich der letzten Leerstelle oder des letzten
 * Zeilenendes - kein halbes Wort, keine halbe Zahl. Ein Leerzeichen hinter
 * einer Ziffer, auf das eine Ziffer folgt oder noch nichts, kann ein
 * Tausendertrenner sein ("1 000"); dort wird nicht geschnitten, sonst saehe
 * die Zahlenpruefung von reactive.chat eine "1", die nie gemeint war.
 */
function stromSchnitt($text)
{
    for ($i = strlen($text) - 1; $i >= 0; $i--) {
        $c = $text[$i];
        if ($c !== ' ' && $c !== "\n" && $c !== "\r" && $c !== "\t") { continue; }
        if ($c === ' ' && $i > 0 && ctype_digit($text[$i - 1])
            && ($i + 1 === strlen($text) || ctype_digit($text[$i + 1]))) { continue; }
        return substr($text, 0, $i + 1);
    }
    return '';
}

function ansModell($system, $prompt)
{
    $t0 = microtime(true);
    $ch = modellHandle($system, $prompt, 20);
    $a = curl_exec($ch);
    $f = curl_error($ch);
    $c = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return modellLesen($c, $a === false ? '' : (string)$a,
                       $a === false ? ($f !== '' ? $f : 'curl ohne Antwort') : '',
                       (int)round((microtime(true) - $t0) * 1000));
}

// ---------------------------------------------------------------------------
// Einbetten (OpenAI-Bauart, /v1/embeddings) - seit dem 27.09.2026
// ---------------------------------------------------------------------------
function einbettenHandle(array $texte)
{
    global $K;
    $ch = curl_init($K['embed_url']);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode(['model' => $K['embed_modell'], 'input' => array_values($texte)],
                                              JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_TIMEOUT        => (int)$K['embed_wartezeit'],
        CURLOPT_CONNECTTIMEOUT => 5,
    ]);
    return $ch;
}

/**
 * Die Antwort des Einbettungsservers -> das Nutzfeld, das reactive.chat
 * erwartet: {"vektoren":["<base64 float32 LE>", ...],"dims":N,"modell":"..."}.
 * NACH index SORTIERT - die OpenAI-Antwort traegt das Feld, und ein Server
 * darf umsortieren. Eine Zahl weniger oder mehr als Texte ist ein Fehler,
 * kein Teilerfolg: der Pi ordnet Vektoren ueber ihre Stelle zu.
 */
function einbettenLesen($code, $roh, $fehler, int $anzahl)
{
    global $K;
    if ($fehler !== '') { return [null, 'Einbettungsserver nicht erreichbar: ' . $fehler]; }
    if ((int)$code !== 200) { return [null, 'Einbettung HTTP ' . (int)$code . ': ' . mb_substr((string)$roh, 0, 160)]; }
    $j = json_decode((string)$roh, true);
    if (!is_array($j) || !isset($j['data']) || !is_array($j['data'])) { return [null, 'Einbettung unlesbar']; }
    $daten = $j['data'];
    usort($daten, static function ($x, $y) { return ((int)($x['index'] ?? 0)) - ((int)($y['index'] ?? 0)); });
    $vek = []; $dims = 0;
    foreach ($daten as $e) {
        $werte = (array)($e['embedding'] ?? []);
        if ($werte === [] || ($dims > 0 && count($werte) !== $dims)) { return [null, 'Vektor leer oder ungleich lang']; }
        $dims = count($werte);
        $b = '';
        foreach ($werte as $w) { $b .= pack('g', (float)$w); }
        $vek[] = base64_encode($b);
    }
    if (count($vek) !== $anzahl) { return [null, count($vek) . ' Vektoren fuer ' . $anzahl . ' Texte']; }
    return [json_encode(['vektoren' => $vek, 'dims' => $dims, 'modell' => (string)$K['embed_modell']],
                        JSON_UNESCAPED_SLASHES), ''];
}

/** Antwortet der Einbettungsserver? /health (eigener Dienst) oder, wenn es das nicht gibt, ein Probetext. */
function einbettenBereit()
{
    global $K;
    $ch = einbettenHandle(['Bereit']);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    $a = curl_exec($ch);
    $c = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $a !== false && $c === 200;
}

/** Antwortet der Modellserver? Bei 'chat_url' (Azure) gibt es kein /models - dann gilt er als da. */
function modellBereit()
{
    global $K;
    // Wer nur einbettet, braucht das Sprachmodell nicht - und umgekehrt.
    $braucht = (array)$K['arten'];
    if (in_array('einbettung', $braucht, true) && !einbettenBereit()) { return false; }
    if (array_diff($braucht, ['einbettung']) === []) { return true; }
    if ($K['chat_url'] !== '') { return true; }
    $ch = curl_init(rtrim($K['endpunkt'], '/') . '/models');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5,
                            CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_HTTPHEADER => modellKopf()]);
    $a = curl_exec($ch);
    $c = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $a !== false && $c === 200;
}

// ---------------------------------------------------------------------------
// --probe: beide Seiten ansehen, nichts wegnehmen (n=0)
// ---------------------------------------------------------------------------
if ($PROBE) {
    sagen('Probe, rc-knoten ' . RC_KNOTEN_VERSION . '.');
    sagen('  reactive.chat: ' . $K['basis']);
    $a = anPi('hol', null, '&n=0&warte=0&arten=' . rawurlencode(implode(',', (array)$K['arten']))
                           . '&kann=' . rawurlencode(implode(',', $GLOBALS['KANN'])), 20);
    if ($a['code'] === 200 && is_array($a['daten'])) {
        sagen('    HTTP 200 - angemeldet, ' . (int)($a['daten']['offen'] ?? 0) . ' Auftrag/Auftraege offen.');
    } elseif ($a['code'] === 401) {
        sagen('    HTTP 401 - abgelehnt. Stimmen Kennung und Geheimnis? Geht die Uhr richtig (NTP)?'
            . ' Ist der Knoten im Kundenbereich widerrufen?');
    } else {
        sagen('    Keine Verbindung: ' . ($a['fehler'] !== '' ? $a['fehler']
              : 'HTTP ' . $a['code'] . ' ' . mb_substr($a['roh'], 0, 200)));
    }
    sagen('  Modell: ' . modellUrl() . ' (' . $K['modell'] . ')');
    $m = ansModell('Antworte mit genau einem Wort.', 'Sag: Bereit');
    sagen($m['text'] === null ? '    ' . $m['fehler']
                              : '    Antwort in ' . $m['ms'] . ' ms: ' . saeubern($m['text']));
    if ($K['embed_url'] !== '') {
        sagen('  Einbetten: ' . $K['embed_url'] . ' (' . $K['embed_modell'] . ')');
        $ch = einbettenHandle(['Bereit']);
        $t0 = microtime(true);
        $roh = curl_exec($ch);
        $e = einbettenLesen((int)curl_getinfo($ch, CURLINFO_HTTP_CODE), $roh === false ? '' : (string)$roh,
                            $roh === false ? curl_error($ch) : '', 1);
        curl_close($ch);
        sagen($e[0] === null ? '    ' . $e[1]
                             : '    ' . (json_decode($e[0], true)['dims'] ?? 0) . ' Dimensionen in '
                               . (int)round((microtime(true) - $t0) * 1000) . ' ms');
    }
    sagen('  Knoten: ' . $K['knoten'] . ', nimmt: ' . implode(', ', (array)$K['arten'])
        . ', kann: ' . implode(', ', $GLOBALS['KANN'])
        . ', Bilder: ' . (!empty($K['bilder']) ? 'ja (hoechstens ' . (int)$K['bilder_max'] . ')' : 'nein'));
    exit(($a['code'] === 200 && $m['text'] !== null) ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Die Schleife: holen, rechnen lassen, abliefern - mehrere zugleich
// ---------------------------------------------------------------------------
function hSchluessel($ch)
{
    return is_object($ch) ? 'o' . spl_object_id($ch) : 'r' . (int)$ch;
}

function schleife($einmal)
{
    global $K, $EINER, $weiter, $STROM_AUS;

    $plaetze = $EINER ? 1 : max(1, (int)$K['gleichzeitig']);
    $warteS  = max(0, min(60, (int)$K['warte']));
    $frist   = $warteS + 20;
    $arten   = rawurlencode(implode(',', (array)$K['arten']))
             . '&kann=' . rawurlencode(implode(',', $GLOBALS['KANN']))
             // Siehe 'bilder': nur wer Bilder kann, sagt es reactive.chat.
             . (!empty($K['bilder']) ? '&bilder=1' : '');
    $PULS_S  = 45;   // bei voller Auslastung trotzdem melden - der Server haelt den Knoten sonst fuer tot
    /* STROM - siehe stromNeu(). EIN teil-Aufruf zur Zeit fuer alle laufenden
       Auftraege zusammen (hoechstens 8 Eintraege, mehr nimmt reactive.chat
       nicht); je Auftrag hoechstens alle strom_ms. */
    $stromMs   = max(100, (int)$K['strom_ms']);
    $teilOffen = false;

    $multi = curl_multi_init();
    $wer = []; $lauf = []; $fertig = []; $imBring = [];
    $holOffen = false; $bringOffen = false; $schonGeholt = false;
    $getan = 0; $leitungsfehler = false; $fehlLaeufe = 0; $ruhigBis = 0;
    $letzterRuf = time(); $modellWartet = 0;

    $anstossen = function ($id) use (&$multi, &$wer, &$lauf) {
        global $K, $STROM_AUS;
        $j = $lauf[$id];
        $p = $j['versuch'] === 1 ? $j['prompt']
           : $j['prompt'] . "\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, "
                          . "die nicht in den Quellen steht. Uebernimm Zahlen genau so, "
                          . "wie sie dort stehen, oder lass sie weg.";
        /* Strom nur mit 'strom' im Auftrag UND in der Konfiguration, und nicht
           mehr, seit reactive.chat 'teil' abgelehnt hat. null = der Aufruf von
           1.2, Byte fuer Byte. Jeder Anlauf beginnt mit leerem Text. */
        $zs = (!empty($j['strom']) && !empty($K['strom']) && !$STROM_AUS) ? stromNeu() : null;
        $lauf[$id]['zs']       = $zs;
        $lauf[$id]['teilText'] = '';
        $ch = modellHandle($j['system'], $p, $j['max_tokens'], isset($j['bilder']) ? $j['bilder'] : [], $zs);
        curl_multi_add_handle($multi, $ch);
        $wer[hSchluessel($ch)] = ['was' => 'modell', 'id' => $id, 't0' => microtime(true), 'strom' => $zs];
    };

    $abschliessen = function ($id, $satz, $grund) use (&$lauf, &$fertig, &$getan, $K, $plaetze) {
        $j = $lauf[$id];
        unset($lauf[$id]);
        $getan++;
        sagen('  #' . $id . ($satz === '' ? ' verworfen: ' . $grund
                                          : ' ' . $j['ms'] . ' ms: ' . ($j['art'] === 'einbettung'
                                              ? count((array)$j['texte']) . ' Text(e) eingebettet'
                                              : mb_substr($satz, 0, 100)))
            // Strom: wie viele Teile gingen (gestoppt = weiter:false).
            . (!empty($j['strom']) ? '  Teile ' . $j['teilN'] . ($j['teilWeiter'] ? '' : ' (gestoppt)') : '')
            . '  [' . count($lauf) . '/' . $plaetze . ']');
        /* AUCH DAS SCHEITERN WIRD ABGELIEFERT: im Chat wartet jemand, und der
           Server soll sofort uebergeben koennen, statt die Pacht abzuwarten. */
        $fertig[] = ['id' => $id, 'text' => $satz, 'grund' => $satz === '' ? $grund : '',
                     'modell' => $K['modell'], 'ms' => $j['ms'], 'knoten' => $K['knoten']];
    };

    while (true) {
        $frei = $plaetze - count($lauf);
        $ruht = !$holOffen && !$bringOffen && !$lauf && !$teilOffen;
        $holenErlaubt = $weiter && !($einmal && $schonGeholt) && time() >= $ruhigBis;

        if ($ruht && !$fertig && (!$weiter || ($einmal && $schonGeholt))) { break; }

        // Erst pruefen, ob das Modell antwortet - sonst holt der Knoten
        //  Auftraege, die er nicht erledigen kann.
        if ($ruht && !$fertig && $holenErlaubt) {
            if (!modellBereit()) {
                if ($modellWartet % 6 === 0) { sagen('Modellserver nicht erreichbar, warte.'); }
                $modellWartet++;
                if ($einmal) { curl_multi_close($multi); return -1; }
                for ($i = 0; $i < 10 && $weiter; $i++) { sleep(1); }
                continue;
            }
            if ($modellWartet > 0) { sagen('Modellserver ist da.'); $modellWartet = 0; }
        }

        if ($holenErlaubt && !$holOffen && $frei > 0) {
            $ch = piHandle('hol', null, '&n=' . min($frei, $plaetze) . '&warte=' . $warteS
                                        . '&arten=' . $arten, $frist);
            curl_multi_add_handle($multi, $ch);
            $wer[hSchluessel($ch)] = ['was' => 'hol', 'id' => 0, 't0' => microtime(true)];
            $holOffen = true; $schonGeholt = true; $letzterRuf = time();
        } elseif ($weiter && !$holOffen && $frei <= 0 && (time() - $letzterRuf) >= $PULS_S) {
            // 'kann' auch im Puls: ohne Angabe gaelte 'chat', und ein reiner
            //  Einbetter verloere bei jedem Puls seine Art.
            $ch = piHandle('hol', null, '&n=0&warte=0&kann=' . rawurlencode(implode(',', $GLOBALS['KANN'])), 20);
            curl_multi_add_handle($multi, $ch);
            $wer[hSchluessel($ch)] = ['was' => 'puls', 'id' => 0, 't0' => microtime(true)];
            $holOffen = true; $letzterRuf = time();
        }

        if (!$bringOffen && $fertig) {
            $rumpf = json_encode(['ergebnisse' => array_values($fertig)], JSON_UNESCAPED_UNICODE);
            $ch = piHandle('bring', $rumpf);
            curl_multi_add_handle($multi, $ch);
            $wer[hSchluessel($ch)] = ['was' => 'bring', 'id' => 0, 't0' => microtime(true)];
            $imBring = $fertig; $fertig = []; $bringOffen = true;
        }

        /* Teile, solange das Modell schreibt (Strom). NIE BLOCKIEREND, EIN
           teil-Aufruf zur Zeit: ein langsamer Server bremst die Teile, nicht
           die Antworten. Nur gewachsener Text, geschnitten an der letzten
           Leerstelle (stromSchnitt), je Auftrag hoechstens alle strom_ms. n
           zaehlt je Auftrag hoch, auch ueber einen zweiten Anlauf. */
        if (!$teilOffen && !$STROM_AUS) {
            $jetzt = microtime(true);
            $eintraege = [];
            foreach ($lauf as $tid => $tj) {
                if (count($eintraege) >= 8) { break; }
                if ($tj['zs'] === null || !$tj['teilWeiter']
                    || ($jetzt - $tj['teilT']) * 1000 < $stromMs) { continue; }
                $ttext = stromSchnitt($tj['zs']->text);
                if (strlen($ttext) <= strlen($tj['teilText'])) { continue; }
                // Mehr nimmt reactive.chat nicht an - dann eben keine Teile mehr.
                if (strlen($ttext) > 16000) { $lauf[$tid]['teilWeiter'] = false; continue; }
                $lauf[$tid]['teilN']++;
                $lauf[$tid]['teilT']    = $jetzt;
                $lauf[$tid]['teilText'] = $ttext;
                $eintraege[] = ['id' => $tid, 'n' => $lauf[$tid]['teilN'], 'text' => $ttext];
            }
            if ($eintraege) {
                $ch = piHandle('teil', json_encode(['teile' => $eintraege],
                                                   JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), '', 10);
                curl_multi_add_handle($multi, $ch);
                $wer[hSchluessel($ch)] = ['was' => 'teil', 'id' => 0, 't0' => microtime(true)];
                $teilOffen = true;
            }
        }

        $aktiv = 0;
        do { $st = curl_multi_exec($multi, $aktiv); } while ($st === CURLM_CALL_MULTI_PERFORM);

        $etwas = false;
        while ($info = curl_multi_info_read($multi)) {
            $etwas = true;
            $ch = $info['handle'];
            $k  = hSchluessel($ch);
            $z  = isset($wer[$k]) ? $wer[$k] : ['was' => '?', 'id' => 0, 't0' => microtime(true)];
            $roh  = (string)curl_multi_getcontent($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            // Strom: die Bytes stehen im Zustand, nicht im curl-Puffer.
            if (!empty($z['strom'])) { stromSchluss($z['strom']); $roh = $z['strom']->roh; }
            $cerr = $info['result'] === CURLE_OK ? '' : curl_strerror($info['result']);
            curl_multi_remove_handle($multi, $ch);
            unset($wer[$k]);
            curl_close($ch);

            if ($z['was'] === 'puls') { $holOffen = false; continue; }

            if ($z['was'] === 'hol') {
                $holOffen = false;
                $a = piLesen($code, $roh, $cerr);
                if ($a['code'] !== 200 || !isset($a['daten']['auftraege'])) {
                    sagen('Auftraege holen fehlgeschlagen: HTTP ' . $a['code'] . ' '
                        . ($a['fehler'] !== '' ? $a['fehler'] : mb_substr($a['roh'], 0, 160)));
                    $leitungsfehler = true;
                    $fehlLaeufe++;
                    $rf = min(300, 5 * $fehlLaeufe);
                    $ruhigBis = time() + $rf;
                    continue;
                }
                $fehlLaeufe = 0;
                $neu = 0;
                foreach ((array)$a['daten']['auftraege'] as $auf) {
                    $id = (int)($auf['id'] ?? 0);
                    if ($id <= 0 || isset($lauf[$id])) { continue; }
                    $lauf[$id] = ['id' => $id, 'art' => (string)($auf['art'] ?? 'chat'),
                                  'system' => (string)($auf['system'] ?? ''),
                                  'prompt' => (string)($auf['prompt'] ?? ''),
                                  'fakten' => (string)($auf['fakten'] ?? ''),
                                  'max_tokens' => (int)($auf['max_tokens'] ?? 0),
                                  'texte' => array_values(array_map('strval', (array)($auf['texte'] ?? []))),
                                  'bilder' => bilderAusAuftrag($auf['bilder'] ?? null),
                                  'versuch' => 1, 'ms' => 0,
                                  // Strom: Zustand des laufenden Anlaufs, Teile an reactive.chat
                                  'strom' => !empty($auf['strom']), 'zs' => null,
                                  'teilN' => 0, 'teilT' => 0.0, 'teilText' => '', 'teilWeiter' => true];
                    if ($lauf[$id]['art'] === 'einbettung') {
                        if ($K['embed_url'] === '' || $lauf[$id]['texte'] === []) {
                            $abschliessen($id, '', $K['embed_url'] === '' ? 'kein Einbettungsserver'
                                                                          : 'Einbettung ohne Texte');
                            continue;
                        }
                        $ch = einbettenHandle($lauf[$id]['texte']);
                        curl_multi_add_handle($multi, $ch);
                        $wer[hSchluessel($ch)] = ['was' => 'einbettung', 'id' => $id, 't0' => microtime(true)];
                        $neu++;
                        continue;
                    }
                    if ($lauf[$id]['prompt'] === '') {
                        $abschliessen($id, '', 'Auftrag ohne Text');
                        continue;
                    }
                    if ($EINER) {
                        echo "\n--- Auftrag #$id (" . $lauf[$id]['art'] . ") ---\nSYSTEM:\n"
                           . $lauf[$id]['system'] . "\n\nPROMPT:\n" . $lauf[$id]['prompt']
                           . ($lauf[$id]['bilder'] ? "\n\nBILDER: " . count($lauf[$id]['bilder']) : '') . "\n\n";
                    }
                    $anstossen($id);
                    $neu++;
                }
                if ($neu) { sagen($neu . ' Auftrag/Auftraege geholt [' . count($lauf) . '/' . $plaetze . '].'); }
                continue;
            }

            if ($z['was'] === 'teil') {
                $teilOffen = false;
                $t = piLesen($code, $roh, $cerr);
                /* 400/404: dieser Server kennt 'teil' nicht (Stand ohne Strom) -
                   Strom aus bis zum Neustart, einmal gesagt. Netzfehler und
                   alles andere: egal, der naechste Teil kommt ohnehin. */
                if ($t['code'] === 400 || $t['code'] === 404) {
                    $STROM_AUS = true;
                    sagen('Strom aus bis zum Neustart: teil antwortet HTTP ' . $t['code'] . ' '
                        . mb_substr($t['roh'], 0, 120));
                    continue;
                }
                if ($t['code'] === 200 && isset($t['daten']['teile']) && is_array($t['daten']['teile'])) {
                    foreach ($t['daten']['teile'] as $e) {
                        // weiter:false - fuer diesen Auftrag keine Teile mehr.
                        if (is_array($e) && isset($lauf[(int)($e['id'] ?? 0)])
                            && array_key_exists('weiter', $e) && !$e['weiter']) {
                            $lauf[(int)$e['id']]['teilWeiter'] = false;
                        }
                    }
                }
                continue;
            }

            if ($z['was'] === 'bring') {
                $bringOffen = false;
                $b = piLesen($code, $roh, $cerr);
                if ($b['code'] !== 200 || !isset($b['daten']['ergebnisse'])) {
                    sagen('Abliefern fehlgeschlagen: HTTP ' . $b['code'] . ' '
                        . ($b['fehler'] !== '' ? $b['fehler'] : mb_substr($b['roh'], 0, 160)));
                    $leitungsfehler = true;
                    $imBring = [];
                    continue;
                }
                $angenommen = 0;
                foreach ((array)$b['daten']['ergebnisse'] as $e) {
                    if (!empty($e['angenommen'])) { $angenommen++; }
                    elseif (!empty($e['grund'])) { sagen('  #' . (int)($e['id'] ?? 0) . ' abgelehnt: ' . $e['grund']); }
                }
                sagen($angenommen . ' von ' . count($imBring) . ' angenommen.');
                $imBring = [];
                continue;
            }

            $id = (int)$z['id'];
            if (!isset($lauf[$id])) { continue; }
            if ($z['was'] === 'einbettung') {
                $lauf[$id]['ms'] += (int)round((microtime(true) - $z['t0']) * 1000);
                [$nutz, $efehler] = einbettenLesen($code, $roh, $cerr, count($lauf[$id]['texte']));
                $abschliessen($id, $nutz === null ? '' : $nutz, $efehler);
                continue;
            }
            $m = modellLesen($code, $roh, $cerr, (int)round((microtime(true) - $z['t0']) * 1000),
                             $z['strom'] ?? null);
            $lauf[$id]['ms'] += $m['ms'];
            if ($m['text'] === null) { $abschliessen($id, '', $m['fehler']); continue; }

            $kandidat = saeubern($m['text']);
            // KEINE_ANTWORT ist das vereinbarte Wort fuer "steht nicht in den
            //  Quellen" - unveraendert weiterreichen, es fuehrt zur Uebergabe.
            if (stripos($kandidat, 'KEINE_ANTWORT') !== false) {
                $abschliessen($id, 'KEINE_ANTWORT', '');
                continue;
            }
            $schlecht = zahlenPruefen($kandidat, $lauf[$id]['fakten']);
            if ($schlecht === null && $kandidat !== '') { $abschliessen($id, $kandidat, ''); continue; }
            if ($lauf[$id]['versuch'] < 2) { $lauf[$id]['versuch']++; $anstossen($id); continue; }
            $abschliessen($id, '', $kandidat === '' ? 'leer nach dem Saeubern' : 'erfundene Zahl: ' . $schlecht);
        }

        if (!$etwas) {
            if ($aktiv > 0) {
                // Mit laufendem Strom 0,1 s: ein faelliger Teil soll nicht liegen.
                $warteSel = 1.0;
                foreach ($lauf as $sj) {
                    if ($sj['zs'] !== null && $sj['teilWeiter'] && !$STROM_AUS) { $warteSel = 0.1; break; }
                }
                if (curl_multi_select($multi, $warteSel) === -1) { usleep(50000); }
            } else {
                usleep(200000);
            }
        }
    }
    curl_multi_close($multi);
    return ($einmal && $leitungsfehler && $getan === 0) ? -1 : $getan;
}

$weiter = true;
if (!$DAUER) {
    $n = schleife(true);
    exit($n < 0 ? 1 : 0);
}
if (function_exists('pcntl_async_signals')) {
    pcntl_async_signals(true);
    pcntl_signal(SIGTERM, function () use (&$weiter) { $weiter = false; sagen('SIGTERM - Schluss nach den laufenden Auftraegen.'); });
    pcntl_signal(SIGINT,  function () use (&$weiter) { $weiter = false; sagen('SIGINT - Schluss nach den laufenden Auftraegen.'); });
}
sagen('Dauerlauf. Knoten ' . $K['knoten'] . ', Modell ' . $K['modell'] . ' auf ' . modellUrl()
    . ', Long-Poll ' . (int)$K['warte'] . ' s, bis zu ' . max(1, (int)$K['gleichzeitig'])
    . ' gleichzeitig, nimmt: ' . implode(', ', (array)$K['arten']) . '.');
schleife(false);
sagen('Beendet.');
