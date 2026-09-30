#!/usr/bin/env php
<?php
/**
 * reactive.chat - your own AI node ("bring your own model"), PHP edition
 * ===========================================================================
 * rc-node-php 2.0.0 - MIT licence - https://reactive.chat
 *
 * This script runs on YOUR machine. It fetches the AI jobs of your workspace
 * from reactive.chat, lets YOUR language model answer them and delivers the
 * answers back. Your model only ever talks to this script; reactive.chat never
 * opens a connection to your machine - the node calls out, not the other way
 * round. No public address, no open port, no fixed IP is needed.
 *
 * Requirements: PHP 8.1+ CLI with the curl and json extensions
 * (Debian/Ubuntu: apt install php-cli php-curl). Nothing else.
 *
 *   php rc-node.php --probe                 check both sides, take nothing
 *   php rc-node.php                         one fetch cycle (same as --once)
 *   php rc-node.php --one                   one slot, print each job's prompt
 *   php rc-node.php --daemon                run forever (systemd, see README)
 *   php rc-node.php --config=/path/rc-node.json --daemon
 *   php rc-node.php --konf=/path/rc-knoten.conf.php --dauer   (legacy 1.x config)
 *
 * Signature: every request to reactive.chat carries an HMAC-SHA256 signature
 * with your node secret over "RC-KI-v2\n" + time + "\n" + method + "\n" +
 * path + "\n" + query + "\n" + body, plus a random nonce in the query. A
 * signature is valid for five minutes and exactly once, so this machine's
 * clock must be right (NTP).
 *
 * This is the English rewrite of rc-knoten.php 1.3. The wire format is
 * unchanged: JSON field names and the reasons ("grund") sent to reactive.chat
 * stay German, because the server and its dashboards know them.
 */

namespace RcNode;

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

const VERSION    = '2.0.0';
const USER_AGENT = 'rc-node-php/' . VERSION;

/** Appended to the prompt for the one retry after an invented number (wire text, German). */
const RETRY_SUFFIX = "\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, "
                   . "die nicht in den Quellen steht. Uebernimm Zahlen genau so, "
                   . "wie sie dort stehen, oder lass sie weg.";

const HEARTBEAT_S       = 45;       // report in while all slots are busy, or the server thinks we are dead
const PART_MAX_ENTRIES  = 8;        // reactive.chat takes at most 8 parts per 'teil' call
const PART_MAX_BYTES    = 16000;    // longer texts are not accepted as parts
const STREAM_RAW_MAX    = 4194304;  // keep at most 4 MiB of the raw model answer
const IMAGE_MAX_BYTES   = 4194304;

/** Exit code 2 with a one-line message. */
final class ConfigError extends \RuntimeException {}

// ===========================================================================
// Configuration
// ===========================================================================
final class Config
{
    public string $baseUrl = '';
    public string $nodeId = '';
    public string $secret = '';
    public string $model = '';
    public string $modelEndpoint = '';
    public string $chatUrl = '';
    public string $modelApiKey = '';
    public string $modelKeyHeader = 'Authorization';
    /** @var string[] what THIS process fetches */
    public array $kinds = ['chat'];
    /** @var string[] what the node can overall (empty = kinds) */
    public array $capabilities = [];
    public string $embedUrl = '';
    public string $embedModel = '';
    public int $embedTimeout = 120;
    public bool $images = false;
    public int $imagesMax = 1;
    public bool $stream = true;
    public int $streamMs = 400;
    public int $concurrency = 1;
    public int $pollWait = 20;
    public int $timeout = 120;
    public float $temperature = 0.2;
    public int $maxTokens = 300;
    public string $basicAuth = '';
    public string $resolve = '';
    public bool $tlsVerify = true;
    public string $logFile = '';
    public string $timezone = '';
    /** Where the configuration came from (for messages). */
    public string $source = '';
    public bool $legacy = false;

    /** English key => [property, type, legacy German key]. */
    public const KEYS = [
        'base_url'         => ['baseUrl',        'string', 'basis'],
        'node_id'          => ['nodeId',         'string', 'knoten'],
        'secret'           => ['secret',         'string', 'geheim'],
        'model'            => ['model',          'string', 'modell'],
        'model_endpoint'   => ['modelEndpoint',  'string', 'endpunkt'],
        'chat_url'         => ['chatUrl',        'string', 'chat_url'],
        'model_api_key'    => ['modelApiKey',    'string', 'modell_schluessel'],
        'model_key_header' => ['modelKeyHeader', 'string', 'schluessel_kopf'],
        'kinds'            => ['kinds',          'list',   'arten'],
        'capabilities'     => ['capabilities',   'list',   'kann'],
        'embed_url'        => ['embedUrl',       'string', 'embed_url'],
        'embed_model'      => ['embedModel',     'string', 'embed_modell'],
        'embed_timeout'    => ['embedTimeout',   'int',    'embed_wartezeit'],
        'images'           => ['images',         'bool',   'bilder'],
        'images_max'       => ['imagesMax',      'int',    'bilder_max'],
        'stream'           => ['stream',         'bool',   'strom'],
        'stream_ms'        => ['streamMs',       'int',    'strom_ms'],
        'concurrency'      => ['concurrency',    'int',    'gleichzeitig'],
        'poll_wait'        => ['pollWait',       'int',    'warte'],
        'timeout'          => ['timeout',        'int',    'wartezeit'],
        'temperature'      => ['temperature',    'float',  'temperatur'],
        'max_tokens'       => ['maxTokens',      'int',    'max_tokens'],
        'basic_auth'       => ['basicAuth',      'string', 'basic'],
        'resolve'          => ['resolve',        'string', 'resolve'],
        'tls_verify'       => ['tlsVerify',      'bool',   'tls_pruefen'],
        'log_file'         => ['logFile',        'string', 'protokoll'],
        'timezone'         => ['timezone',       'string', 'zeitzone'],
    ];

    /** English aliases of the wire kind names. */
    public const KIND_ALIASES = [
        'translation' => 'uebersetzung',
        'summary'     => 'zusammenfassung',
        'embedding'   => 'einbettung',
    ];

    /** Load a JSON config (rc-node.json). */
    public static function fromJsonFile(string $path): self
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new ConfigError('Config file not found or not readable: ' . $path
                . ' (copy rc-node.example.json to rc-node.json, fill it in, chmod 600).');
        }
        $raw = (string)file_get_contents($path);
        if (strncmp($raw, "\xEF\xBB\xBF", 3) === 0) { $raw = substr($raw, 3); }  // BOM from Windows editors
        $data = json_decode($raw, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new ConfigError('Config file ' . $path . ' is not valid JSON: ' . json_last_error_msg() . '.');
        }
        if (!is_array($data) || ($data !== [] && array_is_list_compat($data))) {
            throw new ConfigError('Config file ' . $path . ' must contain a JSON object.');
        }
        $c = new self();
        $c->source = $path;
        $c->apply($data, false);
        return $c;
    }

    /** Load a legacy 1.x config (rc-knoten.conf.php, a PHP file returning a German-keyed array). */
    public static function fromLegacyFile(string $path): self
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new ConfigError('Legacy config file not found or not readable: ' . $path . '.');
        }
        $data = (static function (string $f) { return require $f; })($path);
        if (!is_array($data)) {
            throw new ConfigError('The legacy config ' . $path . ' must return an array.');
        }
        $c = new self();
        $c->source = $path;
        $c->legacy = true;
        // 1.x wrote its log next to the script unless told otherwise.
        $c->logFile = __DIR__ . '/rc-knoten.log';
        $mapped = [];
        foreach (self::KEYS as $en => [, , $de]) {
            if (array_key_exists($de, $data)) { $mapped[$en] = $data[$de]; }
        }
        $c->apply($mapped, true);
        return $c;
    }

    /** Set the values, apply environment overrides and validate. */
    private function apply(array $data, bool $legacy): void
    {
        foreach (self::KEYS as $key => [$prop, $type]) {
            if (!array_key_exists($key, $data) || $data[$key] === null) { continue; }
            $this->$prop = self::coerce($data[$key], $type, $this->keyName($key));
        }
        $env = getenv('RC_NODE_SECRET');
        if (is_string($env) && $env !== '') { $this->secret = $env; }
        $env = getenv('RC_NODE_MODEL_API_KEY');
        if (is_string($env) && $env !== '') { $this->modelApiKey = $env; }

        $this->kinds        = self::wireKinds($this->kinds);
        $this->capabilities = self::wireKinds($this->capabilities);
        if ($this->kinds === []) { $this->kinds = ['chat']; }

        foreach (['base_url', 'node_id', 'secret', 'model'] as $required) {
            $prop = self::KEYS[$required][0];
            if (trim($this->$prop) === '') {
                throw new ConfigError('Config is missing ' . $this->keyName($required) . '.');
            }
        }
        if ($this->modelEndpoint === '' && $this->chatUrl === '') {
            throw new ConfigError('Config is missing ' . $this->keyName('model_endpoint')
                . ' (or ' . $this->keyName('chat_url') . ' for Azure).');
        }
        if (strpos($this->nodeId, 'kn-') !== 0) {
            throw new ConfigError($this->keyName('node_id')
                . ' must start with kn- (exactly as the customer area shows it).');
        }
        if (in_array('einbettung', $this->kinds, true) && ($this->embedUrl === '' || $this->embedModel === '')) {
            throw new ConfigError($this->keyName('kinds') . ' contains einbettung (embedding) - then '
                . $this->keyName('embed_url') . ' and ' . $this->keyName('embed_model') . ' are required.');
        }
    }

    private function keyName(string $key): string
    {
        return $this->legacy ? "'" . self::KEYS[$key][2] . "'" : "'" . $key . "'";
    }

    /** @return mixed */
    private static function coerce($v, string $type, string $name)
    {
        switch ($type) {
            case 'string':
                if (is_string($v)) { return $v; }
                if (is_int($v) || is_float($v)) { return (string)$v; }
                if (is_bool($v)) { return $v ? '1' : ''; }
                throw new ConfigError($name . ' must be a string.');
            case 'int':
                if (is_int($v)) { return $v; }
                if (is_float($v) || (is_string($v) && is_numeric(trim($v)))) { return (int)$v; }
                if (is_bool($v)) { return (int)$v; }
                throw new ConfigError($name . ' must be a number.');
            case 'float':
                if (is_int($v) || is_float($v) || (is_string($v) && is_numeric(trim($v)))) { return (float)$v; }
                throw new ConfigError($name . ' must be a number.');
            case 'bool':
                if (is_bool($v)) { return $v; }
                if (is_int($v) || is_float($v)) { return $v != 0; }
                if (is_string($v)) {
                    $s = strtolower(trim($v));
                    if (in_array($s, ['1', 'true', 'yes', 'on'], true)) { return true; }
                    if (in_array($s, ['', '0', 'false', 'no', 'off'], true)) { return false; }
                }
                throw new ConfigError($name . ' must be true or false.');
            case 'list':
                if (is_string($v)) { $v = $v === '' ? [] : explode(',', $v); }
                if (!is_array($v)) { throw new ConfigError($name . ' must be a list of strings.'); }
                $out = [];
                foreach ($v as $item) {
                    if (!is_scalar($item)) { throw new ConfigError($name . ' must be a list of strings.'); }
                    $s = trim((string)$item);
                    if ($s !== '') { $out[] = $s; }
                }
                return $out;
        }
        return $v;
    }

    /** @param string[] $kinds */
    public static function wireKinds(array $kinds): array
    {
        $out = [];
        foreach ($kinds as $k) {
            $w = self::KIND_ALIASES[strtolower($k)] ?? $k;
            if (!in_array($w, $out, true)) { $out[] = $w; }
        }
        return $out;
    }

    /** What the node can overall: 'capabilities', or 'kinds' when empty. */
    public function can(): array
    {
        return $this->capabilities !== [] ? $this->capabilities : $this->kinds;
    }

    public function chatUrl(): string
    {
        if ($this->chatUrl !== '') { return $this->chatUrl; }
        return rtrim($this->modelEndpoint, '/') . '/chat/completions';
    }

    /** @return string[] */
    public function modelHeaders(): array
    {
        $h = ['Content-Type: application/json'];
        if ($this->modelApiKey !== '') {
            $h[] = strcasecmp($this->modelKeyHeader, 'Authorization') === 0
                ? 'Authorization: Bearer ' . $this->modelApiKey
                : $this->modelKeyHeader . ': ' . $this->modelApiKey;
        }
        return $h;
    }
}

/** array_is_list() exists from PHP 8.1 on; keep a fallback anyway. */
function array_is_list_compat(array $a): bool
{
    if (function_exists('array_is_list')) { return array_is_list($a); }
    $i = 0;
    foreach ($a as $k => $_) { if ($k !== $i++) { return false; } }
    return true;
}

/** Timezone for the log: the configured one, else the system's (PHP itself defaults to UTC). */
function applyTimezone(string $tz): void
{
    if ($tz !== '') {
        if (!@date_default_timezone_set($tz)) {
            fwrite(STDERR, "Warning: unknown timezone '" . $tz . "', using " . date_default_timezone_get() . ".\n");
        }
        return;
    }
    if ((string)ini_get('date.timezone') !== '') { return; }
    $candidates = [];
    $env = getenv('TZ');
    if (is_string($env) && $env !== '') { $candidates[] = ltrim($env, ':'); }
    if (is_readable('/etc/timezone')) { $candidates[] = trim((string)file_get_contents('/etc/timezone')); }
    if (is_link('/etc/localtime')) {
        $target = (string)readlink('/etc/localtime');
        if (($p = strpos($target, 'zoneinfo/')) !== false) { $candidates[] = substr($target, $p + 9); }
    }
    foreach ($candidates as $c) {
        if ($c !== '' && @date_default_timezone_set($c)) { return; }
    }
}

// ===========================================================================
// Logging
// ===========================================================================
final class Log
{
    public static string $file = '';

    public static function line(string $text): void
    {
        $line = date('Y-m-d H:i:s') . '  ' . $text . "\n";
        echo $line;
        if (self::$file !== '') { @file_put_contents(self::$file, $line, FILE_APPEND); }
    }
}

// ===========================================================================
// Pure functions (unit-tested against conformance/vectors.json)
// ===========================================================================

/** HMAC-SHA256 over the canonical request, hex. */
function signature(string $secret, string $ts, string $method, string $path, string $query, string $body): string
{
    return hash_hmac('sha256', "RC-KI-v2\n" . $ts . "\n" . $method . "\n" . $path . "\n" . $query . "\n" . $body,
                     $secret);
}

/**
 * The first $n characters of a UTF-8 string (like mb_substr, which the
 * reference used; mbstring is not a hard requirement here).
 */
function utf8Prefix(string $s, int $n): string
{
    if (function_exists('mb_substr')) { return mb_substr($s, 0, $n, 'UTF-8'); }
    if (preg_match('//u', $s) !== 1) {
        $s = (string)preg_replace_callback(
            '/[\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}'
            . '|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}'
            . '|\xF4[\x80-\x8F][\x80-\xBF]{2}|(.)/s',
            static function ($m) { return isset($m[1]) ? '?' : $m[0]; }, $s);
    }
    return preg_match('/^.{0,' . max(0, $n) . '}/su', $s, $m) === 1 ? $m[0] : '';
}

/**
 * Every digit sequence of the answer must appear in the sources - the same
 * rule reactive.chat applies on delivery. Checked here only to save a
 * round-trip: an answer that would be rejected anyway gets a second attempt.
 * Returns the first offending number, or null.
 */
function checkNumbers(string $text, string $facts): ?string
{
    $digits = static function (string $s): array {
        // "1 000", "1.000", "1,000" (also with NBSP/narrow/thin space) count as one number
        $s = (string)preg_replace('/(\d)[ .,\x{00A0}\x{202F}\x{2009}](?=\d\d\d\b)/u', '$1', $s);
        preg_match_all('/\d+/', $s, $m);
        return $m[0];
    };
    $allowed = array_flip($digits($facts));
    foreach ($digits($text) as $d) {
        if (!isset($allowed[$d])) { return (string)$d; }
    }
    return null;
}

/** Remove think blocks, markup, Markdown and lead-ins ("Here is ...:", "Antwort:"), unquote, one line. */
function cleanText(string $text): string
{
    $t = $text;
    $t = (string)preg_replace('/<think>.*?<\/think>/su', ' ', $t);
    $t = (string)preg_replace('/<[^>]*>/', ' ', $t);
    $t = str_replace(['**', '__', '`', '#'], '', $t);
    $t = trim($t);
    $t = (string)preg_replace('/^\s*(hier (ist|sind)[^:\n]*:|here (is|are)[^:\n]*:|antwort:|answer:)\s*/i', '', $t);
    $t = trim($t);
    if (preg_match('/^["\x{201C}\x{201E}\x{00AB}](.*)["\x{201D}\x{201C}\x{00BB}]$/us', $t, $m)) {
        $t = trim($m[1]);
    }
    $t = (string)preg_replace('/\s*\R\s*/u', ' ', $t);
    return trim((string)preg_replace('/\s{2,}/u', ' ', $t));
}

/** One ASCII digit (ctype_digit() without needing the ctype extension). */
function isDigit(string $c): bool
{
    return strlen($c) === 1 && $c >= '0' && $c <= '9';
}

/**
 * The text up to and including the last whitespace - no half word, no half
 * number. A space after a digit that is followed by a digit (or by nothing
 * yet) may be a thousands separator ("1 000"); no cut there.
 */
function streamCut(string $text): string
{
    for ($i = strlen($text) - 1; $i >= 0; $i--) {
        $c = $text[$i];
        if ($c !== ' ' && $c !== "\n" && $c !== "\r" && $c !== "\t") { continue; }
        if ($c === ' ' && $i > 0 && isDigit($text[$i - 1])
            && ($i + 1 === strlen($text) || isDigit($text[$i + 1]))) { continue; }
        return substr($text, 0, $i + 1);
    }
    return '';
}

/**
 * The images of a job as reactive.chat sends them (data:image/...;base64,...),
 * checked and capped. Always empty unless 'images' is enabled.
 * @param mixed $raw
 * @return string[]
 */
function imagesFromJob($raw, bool $enabled, int $max): array
{
    if (!$enabled || !is_array($raw)) { return []; }
    $out = [];
    foreach ($raw as $url) {
        if (count($out) >= max(0, $max)) { break; }
        if (!is_string($url) || strlen($url) > IMAGE_MAX_BYTES) { continue; }
        if (!preg_match('~^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$~', $url)) { continue; }
        $out[] = $url;
    }
    return $out;
}

/** Message content: a plain string without images, a content list (text + image_url) with images. */
function messageContent(string $prompt, array $images)
{
    if (!$images) { return $prompt; }
    $content = [['type' => 'text', 'text' => $prompt]];
    foreach ($images as $url) {
        $content[] = ['type' => 'image_url', 'image_url' => ['url' => (string)$url]];
    }
    return $content;
}

/** Chat completion request body, byte-compatible with the reference. */
function chatBody(Config $c, string $system, string $prompt, int $maxTokens, array $images, bool $stream): string
{
    return (string)json_encode([
        'model'       => $c->model,
        'stream'      => $stream,
        'temperature' => $c->temperature,
        'max_tokens'  => $maxTokens > 0 ? $maxTokens : $c->maxTokens,
        'messages'    => [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user',   'content' => messageContent($prompt, $images)],
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
}

/** State of one streamed (SSE) model call; new for every attempt. */
final class StreamState
{
    public string $raw = '';      // raw bytes (capped), for answers that are not SSE
    public string $buffer = '';   // incomplete line
    public string $text = '';     // text so far
    public bool $sse = false;     // at least one "data:" line seen
    public bool $content = false; // at least one content delta seen
    public bool $done = false;    // [DONE] or finish_reason seen
    public string $error = '';    // error event in the stream

    /** Bytes from the model. An SSE line may span two chunks, so buffer up to the line end. */
    public function feed(string $data): void
    {
        if (strlen($this->raw) < STREAM_RAW_MAX) { $this->raw .= $data; }
        $this->buffer .= $data;
        while (($p = strpos($this->buffer, "\n")) !== false) {
            $this->line(rtrim(substr($this->buffer, 0, $p), "\r"));
            $this->buffer = (string)substr($this->buffer, $p + 1);
        }
    }

    /** Whatever is left after the last line end - at the end of the call. */
    public function finish(): void
    {
        if ($this->buffer !== '') { $this->line(rtrim($this->buffer, "\r")); $this->buffer = ''; }
    }

    /** One SSE line. Only "data: {...}" and "data: [DONE]" count. */
    public function line(string $line): void
    {
        if (strncmp($line, 'data:', 5) !== 0) { return; }
        $this->sse = true;
        $payload = trim(substr($line, 5));
        if ($payload === '[DONE]') { $this->done = true; return; }
        $j = json_decode($payload, true);
        if (!is_array($j)) { return; }
        // vLLM reports an error in the middle of a stream as its own event.
        if (isset($j['error']) || ($j['object'] ?? '') === 'error') {
            $e = $j['error'] ?? $j;
            $this->error = is_array($e) ? scalarString($e['message'] ?? 'Fehler ohne Text') : scalarString($e);
            return;
        }
        $choice = $j['choices'][0] ?? null;
        if (!is_array($choice)) { return; }
        if (isset($choice['delta']['content']) && is_string($choice['delta']['content'])) {
            $this->text   .= $choice['delta']['content'];
            $this->content = true;
        }
        if (!empty($choice['finish_reason'])) { $this->done = true; }
    }
}

/** (string) for scalars, '' for anything else (the reference would have produced "Array"). */
function scalarString($v): string
{
    return is_scalar($v) ? (string)$v : '';
}

/**
 * Model answer -> ['text' => ?string, 'ms' => int, 'error' => string].
 * 'error' is the German reason sent to reactive.chat.
 */
function readModelAnswer(int $code, string $raw, string $curlError, int $ms, ?StreamState $s = null): array
{
    if ($curlError !== '') { return ['text' => null, 'ms' => $ms, 'error' => 'Modell nicht erreichbar: ' . $curlError]; }
    if ($code !== 200) {
        return ['text' => null, 'ms' => $ms, 'error' => 'Modell HTTP ' . $code . ': ' . utf8Prefix($raw, 160)];
    }
    // Streamed: the text is already in the state. No SSE came (a server that
    //  ignores "stream") - then $raw is the recorded body, read as before.
    if ($s !== null && $s->sse) {
        if ($s->error !== '') { return ['text' => null, 'ms' => $ms, 'error' => 'Modell-Strom: ' . utf8Prefix($s->error, 160)]; }
        if (!$s->content)     { return ['text' => null, 'ms' => $ms, 'error' => 'Antwort ohne Text']; }
        if (!$s->done)        { return ['text' => null, 'ms' => $ms, 'error' => 'Strom ohne Abschluss']; }
        return ['text' => $s->text, 'ms' => $ms, 'error' => ''];
    }
    $v = json_decode($raw, true);
    foreach (['choices', 0, 'message', 'content'] as $step) {
        if (!is_array($v) || !isset($v[$step])) { return ['text' => null, 'ms' => $ms, 'error' => 'Antwort ohne Text']; }
        $v = $v[$step];
    }
    return ['text' => is_array($v) ? 'Array' : (string)$v, 'ms' => $ms, 'error' => ''];
}

/**
 * Embedding server answer -> [payload JSON or null, German reason].
 * Payload: {"vektoren":["<base64 float32 LE>",...],"dims":N,"modell":"..."},
 * sorted by index. One vector more or fewer than texts is an error.
 */
function readEmbedding(int $code, string $raw, string $curlError, int $count, string $embedModel): array
{
    if ($curlError !== '') { return [null, 'Einbettungsserver nicht erreichbar: ' . $curlError]; }
    if ($code !== 200) { return [null, 'Einbettung HTTP ' . $code . ': ' . utf8Prefix($raw, 160)]; }
    $j = json_decode($raw, true);
    if (!is_array($j) || !isset($j['data']) || !is_array($j['data'])) { return [null, 'Einbettung unlesbar']; }
    $data = $j['data'];
    $idx = static function ($e): int { return is_array($e) ? (int)scalarOr($e['index'] ?? 0) : 0; };
    usort($data, static function ($x, $y) use ($idx) { return $idx($x) - $idx($y); });
    $vectors = [];
    $dims = 0;
    foreach ($data as $e) {
        $values = is_array($e) ? (array)($e['embedding'] ?? []) : [];
        if ($values === [] || ($dims > 0 && count($values) !== $dims)) { return [null, 'Vektor leer oder ungleich lang']; }
        $dims = count($values);
        $bin = '';
        foreach ($values as $v) { $bin .= pack('g', is_scalar($v) ? (float)$v : 0.0); }
        $vectors[] = base64_encode($bin);
    }
    if (count($vectors) !== $count) { return [null, count($vectors) . ' Vektoren fuer ' . $count . ' Texte']; }
    return [(string)json_encode(['vektoren' => $vectors, 'dims' => $dims, 'modell' => $embedModel],
                                JSON_UNESCAPED_SLASHES), ''];
}

/** @return mixed a scalar or 0 */
function scalarOr($v)
{
    return is_scalar($v) ? $v : 0;
}

// ===========================================================================
// The node
// ===========================================================================

/** One job while it runs. */
final class Job
{
    public int $id;
    public string $kind = 'chat';
    public string $system = '';
    public string $prompt = '';
    public string $facts = '';
    public int $maxTokens = 0;
    /** @var string[] */
    public array $texts = [];
    /** @var string[] */
    public array $images = [];
    public int $attempt = 1;
    public int $ms = 0;
    // streaming
    public bool $stream = false;       // the job asks for a stream
    public ?StreamState $state = null; // state of the running attempt (null = not streamed)
    public int $partN = 0;             // parts sent (keeps counting across a retry)
    public float $partT = 0.0;         // time of the last part
    public string $partText = '';      // text of the last part (of this attempt)
    public bool $partMore = true;      // false after weiter:false or > 16000 bytes

    public static function fromWire(array $a, Config $c): self
    {
        $j = new self();
        $j->id        = (int)scalarOr($a['id'] ?? 0);
        $j->kind      = isset($a['art']) ? scalarString($a['art']) : 'chat';
        $j->system    = scalarString($a['system'] ?? '');
        $j->prompt    = scalarString($a['prompt'] ?? '');
        $j->facts     = scalarString($a['fakten'] ?? '');
        $j->maxTokens = (int)scalarOr($a['max_tokens'] ?? 0);
        $j->texts     = array_values(array_map(__NAMESPACE__ . '\scalarString', (array)($a['texte'] ?? [])));
        $j->images    = imagesFromJob($a['bilder'] ?? null, $c->images, $c->imagesMax);
        $j->stream    = !empty($a['strom']);
        return $j;
    }
}

final class Node
{
    private Config $c;
    /** false after SIGTERM/SIGINT: no more fetching. */
    public bool $running = true;
    /** true once reactive.chat answers 'teil' with 400/404 - no streaming until restart. */
    private bool $streamOff = false;
    private bool $verbose = false;

    public function __construct(Config $c)
    {
        $this->c = $c;
    }

    // ---- the line to reactive.chat -------------------------------------

    /** Signed request to /v1/ki. GET without body, POST with body. */
    public function piHandle(string $action, ?string $body = null, string $extra = '', int $timeoutS = 60)
    {
        $c = $this->c;
        $ts = (string)time();
        /* The nonce: two calls with the same parameters in the same second
           would otherwise carry the same signature, and the server rejects
           the second as a replay. It is in the query and thus signed. */
        $url = rtrim($c->baseUrl, '/') . '/v1/ki?action=' . $action
             . '&knoten=' . rawurlencode($c->nodeId) . $extra
             . '&nonce=' . bin2hex(random_bytes(8));
        $parts  = parse_url($url);
        $path   = is_array($parts) ? (string)($parts['path'] ?? '/') : '/';
        $query  = is_array($parts) ? (string)($parts['query'] ?? '') : '';
        $method = $body !== null ? 'POST' : 'GET';
        $sig = signature($c->secret, $ts, $method, $path, $query, (string)$body);

        $ch = curl_init($url);
        $opt = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => ['X-RC-KI-TS: ' . $ts, 'X-RC-KI-SIG: ' . $sig,
                                       'Content-Type: application/json',
                                       'User-Agent: ' . USER_AGENT],
            CURLOPT_TIMEOUT        => $timeoutS,
            CURLOPT_CONNECTTIMEOUT => 15,
        ];
        // ONLY WITH A BODY: CURLOPT_POSTFIELDS turns any request into a POST,
        //  and the signed method would no longer match.
        if ($body !== null) {
            $opt[CURLOPT_POST]       = true;
            $opt[CURLOPT_POSTFIELDS] = $body;
        }
        if ($c->basicAuth !== '') {
            $opt[CURLOPT_HTTPAUTH] = CURLAUTH_BASIC;
            $opt[CURLOPT_USERPWD]  = $c->basicAuth;
        }
        // Fixed name resolution: connect to the IP, keep Host header and TLS name.
        if ($c->resolve !== '') { $opt[CURLOPT_RESOLVE] = [$c->resolve]; }
        if (!$c->tlsVerify) {
            $opt[CURLOPT_SSL_VERIFYPEER] = false;
            $opt[CURLOPT_SSL_VERIFYHOST] = 0;
        }
        curl_setopt_array($ch, $opt);
        return $ch;
    }

    /** ['code', 'error', 'data' (array|null), 'raw']. */
    public static function piRead(int $code, string $raw, string $error): array
    {
        if ($error !== '') { return ['code' => 0, 'error' => $error, 'data' => null, 'raw' => '']; }
        $data = json_decode($raw, true);
        return ['code' => $code, 'error' => '', 'data' => is_array($data) ? $data : null, 'raw' => $raw];
    }

    public function toPi(string $action, ?string $body = null, string $extra = '', int $timeoutS = 60): array
    {
        $ch = $this->piHandle($action, $body, $extra, $timeoutS);
        $out = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        return self::piRead($code, $out === false ? '' : (string)$out,
                            $out === false ? ($err !== '' ? $err : 'curl ohne Antwort') : '');
    }

    // ---- the line to the model (OpenAI style) -------------------------

    public function modelHandle(string $system, string $prompt, int $maxTokens, array $images = [],
                                ?StreamState $stream = null)
    {
        $c = $this->c;
        $ch = curl_init($c->chatUrl());
        $opt = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => chatBody($c, $system, $prompt, $maxTokens, $images, $stream !== null),
            CURLOPT_HTTPHEADER     => $c->modelHeaders(),
            CURLOPT_TIMEOUT        => $c->timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
        ];
        // Streamed: the bytes go into the state instead of the return buffer
        //  (set AFTER CURLOPT_RETURNTRANSFER - PHP uses the last one set).
        if ($stream !== null) {
            $opt[CURLOPT_WRITEFUNCTION] = static function ($h, $data) use ($stream) {
                $stream->feed($data);
                return strlen($data);
            };
        }
        curl_setopt_array($ch, $opt);
        return $ch;
    }

    /** One blocking, non-streamed completion (probe). */
    public function askModel(string $system, string $prompt): array
    {
        $t0 = microtime(true);
        $ch = $this->modelHandle($system, $prompt, 20);
        $out = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        return readModelAnswer($code, $out === false ? '' : (string)$out,
                               $out === false ? ($err !== '' ? $err : 'curl ohne Antwort') : '',
                               (int)round((microtime(true) - $t0) * 1000));
    }

    public function embedHandle(array $texts)
    {
        $c = $this->c;
        $ch = curl_init($c->embedUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => (string)json_encode(['model' => $c->embedModel, 'input' => array_values($texts)],
                                                          JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT        => $c->embedTimeout,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        return $ch;
    }

    /** Does the embedding server answer? One test text. */
    private function embedReady(): bool
    {
        $ch = $this->embedHandle(['Bereit']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        $out = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        return $out !== false && $code === 200;
    }

    /** Does the model server answer? With 'chat_url' (Azure) there is no /models - then it counts as there. */
    private function modelReady(): bool
    {
        $c = $this->c;
        // Who only embeds does not need the language model - and vice versa.
        if (in_array('einbettung', $c->kinds, true) && !$this->embedReady()) { return false; }
        if (array_diff($c->kinds, ['einbettung']) === []) { return true; }
        if ($c->chatUrl !== '') { return true; }
        $ch = curl_init(rtrim($c->modelEndpoint, '/') . '/models');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5,
                                CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_HTTPHEADER => $c->modelHeaders()]);
        $out = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        return $out !== false && $code === 200;
    }

    // ---- --probe --------------------------------------------------------

    /** Check both sides, take nothing (n=0). Returns the exit code. */
    public function probe(): int
    {
        $c = $this->c;
        Log::line('Probe, rc-node-php ' . VERSION . ' (config: ' . $c->source . ').');
        Log::line('  reactive.chat: ' . $c->baseUrl);
        $a = $this->toPi('hol', null, '&n=0&warte=0&arten=' . rawurlencode(implode(',', $c->kinds))
                                    . '&kann=' . rawurlencode(implode(',', $c->can())), 20);
        if ($a['code'] === 200 && is_array($a['data'])) {
            Log::line('    OK: HTTP 200 - signed in, ' . (int)scalarOr($a['data']['offen'] ?? 0)
                    . ' job(s) waiting.');
        } elseif ($a['code'] === 200) {
            Log::line('    HTTP 200, but the answer is not JSON: ' . utf8Prefix($a['raw'], 200));
        } elseif ($a['code'] === 401) {
            Log::line('    FAILED: HTTP 401 - rejected. Are node ID and secret right? Is this machine\'s'
                    . ' clock right (NTP)? Was the node revoked in the customer area?');
        } else {
            Log::line('    FAILED: no connection: ' . ($a['error'] !== '' ? $a['error']
                    : 'HTTP ' . $a['code'] . ' ' . utf8Prefix($a['raw'], 200)));
        }
        Log::line('  Model: ' . $c->chatUrl() . ' (' . $c->model . ')');
        $m = $this->askModel('Antworte mit genau einem Wort.', 'Sag: Bereit');
        Log::line($m['text'] === null ? '    FAILED: ' . $m['error']
                                      : '    OK: answer in ' . $m['ms'] . ' ms: ' . cleanText($m['text']));
        if ($c->embedUrl !== '') {
            Log::line('  Embedding: ' . $c->embedUrl . ' (' . $c->embedModel . ')');
            $ch = $this->embedHandle(['Bereit']);
            $t0 = microtime(true);
            $out = curl_exec($ch);
            $e = readEmbedding((int)curl_getinfo($ch, CURLINFO_HTTP_CODE), $out === false ? '' : (string)$out,
                               $out === false ? curl_error($ch) : '', 1, $c->embedModel);
            Log::line($e[0] === null ? '    FAILED: ' . $e[1]
                    : '    OK: ' . (int)(json_decode($e[0], true)['dims'] ?? 0) . ' dimensions in '
                      . (int)round((microtime(true) - $t0) * 1000) . ' ms');
        }
        Log::line('  Node: ' . $c->nodeId . ', takes: ' . implode(', ', $c->kinds)
                . ', can: ' . implode(', ', $c->can())
                . ', images: ' . ($c->images ? 'yes (at most ' . $c->imagesMax . ')' : 'no')
                . ', streaming: ' . ($c->stream ? 'yes' : 'no') . '.');
        $ok = $a['code'] === 200 && $m['text'] !== null;
        Log::line($ok ? 'Probe passed: reactive.chat and the model both answered.'
                      : 'Probe FAILED - see above.');
        return $ok ? 0 : 1;
    }

    // ---- the loop: fetch, compute, deliver - several at once -----------

    /**
     * @param bool $once one fetch cycle only
     * @return int jobs done, or -1 (once: connection error and nothing done, or model not ready)
     */
    public function run(bool $once, bool $verbose): int
    {
        $c = $this->c;
        $this->verbose = $verbose;
        $slots    = $verbose ? 1 : max(1, $c->concurrency);
        $waitS    = max(0, min(60, $c->pollWait));
        $holLimit = $waitS + 20;
        $kindsQ   = rawurlencode(implode(',', $c->kinds))
                  . '&kann=' . rawurlencode(implode(',', $c->can()))
                  // only a node that can take images says so
                  . ($c->images ? '&bilder=1' : '');
        $canQ     = rawurlencode(implode(',', $c->can()));
        $streamMs = max(100, $c->streamMs);

        $multi = curl_multi_init();
        /** @var array<int, array> $handles spl_object_id => what */
        $handles = [];
        /** @var array<int, Job> $jobs */
        $jobs = [];
        $finished = []; $inBring = [];
        $holOpen = false; $bringOpen = false; $partOpen = false; $fetched = false;
        $done = 0; $lineError = false; $failures = 0; $quietUntil = 0;
        $lastCall = time(); $modelWaits = 0;

        $add = static function ($ch, array $what) use ($multi, &$handles): void {
            curl_multi_add_handle($multi, $ch);
            $handles[spl_object_id($ch)] = $what + ['t0' => microtime(true)];
        };

        $start = function (Job $j) use ($add): void {
            $prompt = $j->attempt === 1 ? $j->prompt : $j->prompt . RETRY_SUFFIX;
            // Stream only if the job AND the config ask for it and reactive.chat
            //  has not refused 'teil'. Each attempt starts with empty text.
            $j->state    = ($j->stream && $this->c->stream && !$this->streamOff) ? new StreamState() : null;
            $j->partText = '';
            $ch = $this->modelHandle($j->system, $prompt, $j->maxTokens, $j->images, $j->state);
            $add($ch, ['what' => 'model', 'id' => $j->id, 'stream' => $j->state]);
        };

        $finish = function (int $id, string $text, string $reason) use (&$jobs, &$finished, &$done, $slots): void {
            $j = $jobs[$id];
            unset($jobs[$id]);
            $done++;
            Log::line('  #' . $id . ($text === '' ? ' discarded: ' . $reason
                                                  : ' ' . $j->ms . ' ms: ' . ($j->kind === 'einbettung'
                                                        ? count($j->texts) . ' text(s) embedded'
                                                        : utf8Prefix($text, 100)))
                    . ($j->stream ? '  parts ' . $j->partN . ($j->partMore ? '' : ' (stopped)') : '')
                    . '  [' . count($jobs) . '/' . $slots . ']');
            // FAILURES ARE DELIVERED TOO: someone is waiting in the chat, and the
            //  server can hand over at once instead of waiting for the lease.
            $finished[] = ['id' => $id, 'text' => $text, 'grund' => $text === '' ? $reason : '',
                           'modell' => $this->c->model, 'ms' => $j->ms, 'knoten' => $this->c->nodeId];
        };

        while (true) {
            $free    = $slots - count($jobs);
            $idle    = !$holOpen && !$bringOpen && !$jobs && !$partOpen;
            $mayFetch = $this->running && !($once && $fetched) && time() >= $quietUntil;

            if ($idle && !$finished && (!$this->running || ($once && $fetched))) { break; }

            // First check that the model answers - otherwise the node would
            //  fetch jobs it cannot do.
            if ($idle && !$finished && $mayFetch) {
                if (!$this->modelReady()) {
                    if ($modelWaits % 6 === 0) { Log::line('Model server not reachable, waiting.'); }
                    $modelWaits++;
                    if ($once) { curl_multi_close($multi); return -1; }
                    for ($i = 0; $i < 10 && $this->running; $i++) { sleep(1); }
                    continue;
                }
                if ($modelWaits > 0) { Log::line('Model server is back.'); $modelWaits = 0; }
            }

            if ($mayFetch && !$holOpen && $free > 0) {
                $add($this->piHandle('hol', null, '&n=' . min($free, $slots) . '&warte=' . $waitS
                                                . '&arten=' . $kindsQ, $holLimit), ['what' => 'hol', 'id' => 0]);
                $holOpen = true; $fetched = true; $lastCall = time();
            } elseif ($this->running && !$holOpen && $free <= 0 && (time() - $lastCall) >= HEARTBEAT_S) {
                // Heartbeat while all slots are busy. 'kann' too: without it the
                //  server would assume 'chat', and a pure embedder would lose its kind.
                $add($this->piHandle('hol', null, '&n=0&warte=0&kann=' . $canQ, 20), ['what' => 'heartbeat', 'id' => 0]);
                $holOpen = true; $lastCall = time();
            }

            if (!$bringOpen && $finished) {
                $body = (string)json_encode(['ergebnisse' => array_values($finished)],
                                            JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                $add($this->piHandle('bring', $body), ['what' => 'bring', 'id' => 0]);
                $inBring = $finished; $finished = []; $bringOpen = true;
            }

            /* Parts while the model writes (streaming). Never blocking, one
               'teil' call at a time for all jobs together: a slow server slows
               the parts, not the answers. Only grown text, cut at the last
               whitespace, per job at most every stream_ms. n keeps counting
               per job, also across a retry. */
            if (!$partOpen && !$this->streamOff) {
                $now = microtime(true);
                $entries = [];
                foreach ($jobs as $pid => $pj) {
                    if (count($entries) >= PART_MAX_ENTRIES) { break; }
                    if ($pj->state === null || !$pj->partMore || ($now - $pj->partT) * 1000 < $streamMs) { continue; }
                    $ptext = streamCut($pj->state->text);
                    if (strlen($ptext) <= strlen($pj->partText)) { continue; }
                    if (strlen($ptext) > PART_MAX_BYTES) { $pj->partMore = false; continue; }
                    $pj->partN++;
                    $pj->partT    = $now;
                    $pj->partText = $ptext;
                    $entries[] = ['id' => $pid, 'n' => $pj->partN, 'text' => $ptext];
                }
                if ($entries) {
                    $add($this->piHandle('teil', (string)json_encode(['teile' => $entries],
                                         JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), '', 10),
                         ['what' => 'teil', 'id' => 0]);
                    $partOpen = true;
                }
            }

            $active = 0;
            do { $st = curl_multi_exec($multi, $active); } while ($st === CURLM_CALL_MULTI_PERFORM);

            $something = false;
            while ($info = curl_multi_info_read($multi)) {
                $something = true;
                $ch   = $info['handle'];
                $key  = spl_object_id($ch);
                $h    = $handles[$key] ?? ['what' => '?', 'id' => 0, 't0' => microtime(true)];
                $raw  = (string)curl_multi_getcontent($ch);
                $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                // streamed: the bytes are in the state, not in curl's buffer
                if (!empty($h['stream'])) { $h['stream']->finish(); $raw = $h['stream']->raw; }
                $cerr = $info['result'] === CURLE_OK ? '' : (string)curl_strerror($info['result']);
                curl_multi_remove_handle($multi, $ch);
                unset($handles[$key]);

                if ($h['what'] === 'heartbeat') { $holOpen = false; continue; }

                if ($h['what'] === 'hol') {
                    $holOpen = false;
                    $a = self::piRead($code, $raw, $cerr);
                    if ($a['code'] !== 200 || !isset($a['data']['auftraege'])) {
                        $failures++;
                        $backoff = min(300, 5 * $failures);
                        $quietUntil = time() + $backoff;
                        $lineError = true;
                        Log::line('Fetching jobs failed: HTTP ' . $a['code'] . ' '
                                . ($a['error'] !== '' ? $a['error'] : utf8Prefix($a['raw'], 160))
                                . ($once ? '' : ' - next try in ' . $backoff . ' s'));
                        continue;
                    }
                    $failures = 0;
                    $new = 0;
                    foreach ((array)$a['data']['auftraege'] as $wire) {
                        if (!is_array($wire)) { continue; }
                        $j = Job::fromWire($wire, $c);
                        $id = $j->id;
                        if ($id <= 0 || isset($jobs[$id])) { continue; }
                        $jobs[$id] = $j;
                        if ($j->kind === 'einbettung') {
                            if ($c->embedUrl === '' || $j->texts === []) {
                                $finish($id, '', $c->embedUrl === '' ? 'kein Einbettungsserver' : 'Einbettung ohne Texte');
                                continue;
                            }
                            $add($this->embedHandle($j->texts), ['what' => 'embedding', 'id' => $id]);
                            $new++;
                            continue;
                        }
                        if ($j->prompt === '') {
                            $finish($id, '', 'Auftrag ohne Text');
                            continue;
                        }
                        if ($this->verbose) {
                            echo "\n--- Job #" . $id . ' (' . $j->kind . ") ---\nSYSTEM:\n" . $j->system
                               . "\n\nPROMPT:\n" . $j->prompt
                               . ($j->images ? "\n\nIMAGES: " . count($j->images) : '') . "\n\n";
                        }
                        $start($j);
                        $new++;
                    }
                    if ($new) { Log::line($new . ' job(s) fetched [' . count($jobs) . '/' . $slots . '].'); }
                    continue;
                }

                if ($h['what'] === 'teil') {
                    $partOpen = false;
                    $t = self::piRead($code, $raw, $cerr);
                    /* 400/404: this server does not know 'teil' - streaming off
                       until restart, said once. Network errors and anything
                       else: never mind, the next part comes anyway. */
                    if ($t['code'] === 400 || $t['code'] === 404) {
                        $this->streamOff = true;
                        Log::line('Streaming off until restart: teil answered HTTP ' . $t['code'] . ' '
                                . utf8Prefix($t['raw'], 120));
                        continue;
                    }
                    if ($t['code'] === 200 && isset($t['data']['teile']) && is_array($t['data']['teile'])) {
                        foreach ($t['data']['teile'] as $e) {
                            // weiter:false - no more parts for this job
                            if (is_array($e) && isset($jobs[(int)scalarOr($e['id'] ?? 0)])
                                && array_key_exists('weiter', $e) && !$e['weiter']) {
                                $jobs[(int)scalarOr($e['id'])]->partMore = false;
                            }
                        }
                    }
                    continue;
                }

                if ($h['what'] === 'bring') {
                    $bringOpen = false;
                    $b = self::piRead($code, $raw, $cerr);
                    if ($b['code'] !== 200 || !isset($b['data']['ergebnisse'])) {
                        Log::line('Delivery failed: HTTP ' . $b['code'] . ' '
                                . ($b['error'] !== '' ? $b['error'] : utf8Prefix($b['raw'], 160)));
                        $lineError = true;
                        $inBring = [];
                        continue;
                    }
                    $accepted = 0;
                    foreach ((array)$b['data']['ergebnisse'] as $e) {
                        if (!is_array($e)) { continue; }
                        if (!empty($e['angenommen'])) { $accepted++; }
                        elseif (!empty($e['grund'])) {
                            Log::line('  #' . (int)scalarOr($e['id'] ?? 0) . ' rejected: ' . scalarString($e['grund']));
                        }
                    }
                    Log::line($accepted . ' of ' . count($inBring) . ' accepted.');
                    $inBring = [];
                    continue;
                }

                $id = (int)$h['id'];
                if (!isset($jobs[$id])) { continue; }
                $j = $jobs[$id];
                if ($h['what'] === 'embedding') {
                    $j->ms += (int)round((microtime(true) - $h['t0']) * 1000);
                    [$payload, $eerr] = readEmbedding($code, $raw, $cerr, count($j->texts), $c->embedModel);
                    $finish($id, $payload === null ? '' : $payload, $eerr);
                    continue;
                }
                $m = readModelAnswer($code, $raw, $cerr, (int)round((microtime(true) - $h['t0']) * 1000),
                                     $h['stream'] ?? null);
                $j->ms += $m['ms'];
                if ($m['text'] === null) { $finish($id, '', $m['error']); continue; }

                $candidate = cleanText($m['text']);
                // KEINE_ANTWORT is the agreed word for "not in the sources" -
                //  passed through unchanged, it leads to a handover.
                if (stripos($candidate, 'KEINE_ANTWORT') !== false) {
                    $finish($id, 'KEINE_ANTWORT', '');
                    continue;
                }
                $bad = checkNumbers($candidate, $j->facts);
                if ($bad === null && $candidate !== '') { $finish($id, $candidate, ''); continue; }
                if ($j->attempt < 2) { $j->attempt++; $start($j); continue; }
                $finish($id, '', $candidate === '' ? 'leer nach dem Saeubern' : 'erfundene Zahl: ' . $bad);
            }

            if (!$something) {
                if ($active > 0) {
                    // With a running stream 0.1 s: a due part should not wait.
                    $sel = 1.0;
                    foreach ($jobs as $sj) {
                        if ($sj->state !== null && $sj->partMore && !$this->streamOff) { $sel = 0.1; break; }
                    }
                    if (curl_multi_select($multi, $sel) === -1) { usleep(50000); }
                } else {
                    usleep(200000);
                }
            }
        }
        curl_multi_close($multi);
        return ($once && $lineError && $done === 0) ? -1 : $done;
    }

    /** Daemon mode: run until SIGTERM/SIGINT (Windows: Ctrl+C), then finish running jobs. */
    public function daemon(bool $verbose): int
    {
        $c = $this->c;
        $stop = function (string $what): void {
            if (!$this->running) { return; }
            $this->running = false;
            Log::line($what . ' - stopping after the running jobs.');
        };
        if (function_exists('pcntl_async_signals')) {
            pcntl_async_signals(true);
            pcntl_signal(SIGTERM, static function () use ($stop) { $stop('SIGTERM'); });
            pcntl_signal(SIGINT,  static function () use ($stop) { $stop('SIGINT'); });
        } elseif (function_exists('sapi_windows_set_ctrl_handler')) {
            sapi_windows_set_ctrl_handler(static function ($event) use ($stop) {
                $stop($event === PHP_WINDOWS_EVENT_CTRL_C ? 'Ctrl+C' : 'Ctrl+Break');
            }, true);
        }
        Log::line('rc-node-php ' . VERSION . ' daemon. Node ' . $c->nodeId . ', model ' . $c->model
                . ' at ' . $c->chatUrl() . ', long-poll ' . max(0, min(60, $c->pollWait)) . ' s, up to '
                . ($verbose ? 1 : max(1, $c->concurrency)) . ' in parallel, takes: ' . implode(', ', $c->kinds) . '.');
        $this->run(false, $verbose);
        Log::line('Stopped.');
        return 0;
    }
}

// ===========================================================================
// Command line
// ===========================================================================
const USAGE = <<<'TXT'
Usage: php rc-node.php [--config=PATH | --konf=PATH] [--probe | --once | --one | --daemon]

  --config=PATH  JSON config (default: $RC_NODE_CONFIG, else ./rc-node.json)
  --konf=PATH    legacy rc-knoten.conf.php (1.x, German keys)
  --probe        check reactive.chat and the model, take nothing
  --once         one fetch cycle, then exit (default)
  --one          like --once with one slot; prints each job's prompt
  --daemon       run until SIGTERM/SIGINT
  --dauer, --einer   legacy aliases of --daemon and --one
  --version, --help
TXT;

/** @return int exit code */
function main(array $argv): int
{
    $configPath = null; $legacyPath = null;
    $probe = false; $daemon = false; $one = false;
    $args = array_slice($argv, 1);
    for ($i = 0; $i < count($args); $i++) {
        $a = $args[$i];
        if (strpos($a, '--config=') === 0)    { $configPath = substr($a, 9); }
        elseif ($a === '--config' && isset($args[$i + 1])) { $configPath = $args[++$i]; }
        elseif (strpos($a, '--konf=') === 0)  { $legacyPath = substr($a, 7); }
        elseif ($a === '--probe')             { $probe = true; }
        elseif ($a === '--once')              { /* default */ }
        elseif ($a === '--one' || $a === '--einer')    { $one = true; }
        elseif ($a === '--daemon' || $a === '--dauer') { $daemon = true; }
        elseif ($a === '--version')           { echo 'rc-node-php ' . VERSION . "\n"; return 0; }
        elseif ($a === '--help' || $a === '-h') { echo USAGE . "\n"; return 0; }
        else {
            fwrite(STDERR, 'Unknown option ' . $a . " (see --help).\n");
            return 2;
        }
    }

    if (!function_exists('curl_multi_init')) {
        fwrite(STDERR, "The PHP curl extension is missing (Debian/Ubuntu: apt install php-curl).\n");
        return 2;
    }

    try {
        if ($configPath !== null && $configPath !== '') {
            $c = preg_match('/\.php$/i', $configPath) ? Config::fromLegacyFile($configPath)
                                                       : Config::fromJsonFile($configPath);
        } elseif ($legacyPath !== null && $legacyPath !== '') {
            $c = Config::fromLegacyFile($legacyPath);
        } else {
            $env = getenv('RC_NODE_CONFIG');
            if (is_string($env) && $env !== '') {
                $c = preg_match('/\.php$/i', $env) ? Config::fromLegacyFile($env) : Config::fromJsonFile($env);
            } elseif (is_file('rc-node.json')) {
                $c = Config::fromJsonFile('rc-node.json');
            } elseif (is_file(__DIR__ . '/rc-knoten.conf.php')) {
                // drop-in replacement of rc-knoten.php 1.x: its config next to the script
                $c = Config::fromLegacyFile(__DIR__ . '/rc-knoten.conf.php');
            } else {
                $c = Config::fromJsonFile('rc-node.json');   // reports the missing file
            }
        }
    } catch (ConfigError $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        return 2;
    }

    applyTimezone($c->timezone);
    Log::$file = $c->logFile;
    if (DIRECTORY_SEPARATOR === '/' && ($perm = @fileperms($c->source)) !== false && ($perm & 0077) !== 0) {
        fwrite(STDERR, 'Warning: ' . $c->source . ' contains your node secret and is readable by others;'
                     . ' run chmod 600 ' . $c->source . ".\n");
    }

    $node = new Node($c);
    if ($probe)  { return $node->probe(); }
    if ($daemon) { return $node->daemon($one); }
    return $node->run(true, $one) < 0 ? 1 : 0;
}

if (!defined('RC_NODE_LIBRARY')) {
    exit(main($argv));
}
