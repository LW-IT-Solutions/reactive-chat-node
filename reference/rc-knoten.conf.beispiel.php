<?php
/**
 * Konfiguration fuer rc-knoten.php - nach rc-knoten.conf.php kopieren,
 * ausfuellen und mit chmod 600 schuetzen (darin steht Ihr Knotengeheimnis).
 *
 * Kennung und Geheimnis stehen im Kundenbereich unter /app/ai-node. Das
 * Geheimnis wird dort genau einmal angezeigt; wer es verliert, widerruft den
 * Knoten und legt einen neuen an.
 */
return [
    // --- reactive.chat -------------------------------------------------
    'basis'  => 'https://reactive.chat',
    'knoten' => 'kn-0000000000000000',            // Kennung aus dem Kundenbereich
    'geheim' => 'rcn_...',                        // Geheimnis aus dem Kundenbereich

    // --- Ihr Sprachmodell (OpenAI-kompatibel) -----------------------------
    // Die Basisadresse MIT /v1 - an sie wird /chat/completions angehaengt.
    //   vLLM:       'http://127.0.0.1:8000/v1'
    //   Ollama:     'http://127.0.0.1:11434/v1'
    //   LM Studio:  'http://127.0.0.1:1234/v1'
    //   llama.cpp:  'http://127.0.0.1:8080/v1'
    'endpunkt' => 'http://127.0.0.1:8000/v1',
    'modell'   => 'mistral-small-24b',           // der Modellname, den Ihr Server erwartet

    // Nur wenn Ihr Modellserver einen Schluessel verlangt.
    'modell_schluessel' => '',
    'schluessel_kopf'   => 'Authorization',      // 'Authorization' (Bearer) oder 'api-key' (Azure)

    // Azure OpenAI (EU-Region): statt 'endpunkt' die volle Adresse, dazu
    //   'schluessel_kopf' => 'api-key'. 'modell' ist dort der Name des Deployments.
    //   'chat_url' => 'https://IHRE-RESSOURCE.openai.azure.com/openai/deployments/IHR-DEPLOYMENT/chat/completions?api-version=2024-10-21',
    'chat_url' => '',

    // --- Betrieb -----------------------------------------------------------
    'arten'        => ['chat'],   // was DIESER Prozess abholt
    // Einbettungen (Modus "nur eigener Knoten"): ein zweiter Prozess mit einer
    //  Kopie dieser Datei, 'arten' => ['einbettung'] und dem Einbettungsserver,
    //  gestartet mit --konf=. Beide Dateien: 'kann' => ['chat', 'einbettung'].
    //  'embed_modell' ist das Etikett der Vektoren - gleich lassen, solange
    //  dasselbe Modell rechnet.
    // 'kann'         => ['chat', 'einbettung'],
    // 'embed_url'    => 'http://127.0.0.1:8001/v1/embeddings',
    // 'embed_modell' => 'bge-m3',
    // Bilder, die Besucher anhaengen (seit Version 1.2): NUR mit einem
    //  Vision-Modell, z. B. Mistral-Small-3.2 (Vision) unter vLLM, gestartet
    //  mit --limit-mm-per-prompt '{"image":1}' - die Zahl muss zu 'bilder_max'
    //  passen. Ein reines Textmodell scheitert an einem Bild mit HTTP 400;
    //  dann weglassen: Ihr Modell bekommt statt des Bildes einen Hinweis,
    //  dass eines da war, und bittet den Besucher um eine Beschreibung.
    // 'bilder'       => true,
    // 'bilder_max'   => 1,
    'gleichzeitig' => 1,          // vLLM kann mehrere zugleich; eine einzelne Karte ohne Batching: 1
    'warte'        => 20,         // Long-Poll in Sekunden (hoechstens 60)
    'wartezeit'    => 120,        // Frist fuer eine einzelne Generierung
    'temperatur'   => 0.2,
    'max_tokens'   => 300,        // Obergrenze, wenn der Auftrag selbst keine nennt
    // Antworten im Strom (seit Version 1.3): der Besucher sieht die Antwort
    //  wachsen, waehrend Ihr Modell noch schreibt. Der Knoten fragt dafuer mit
    //  stream:true (SSE - koennen vLLM, Ollama, LM Studio, llama.cpp, Azure) und
    //  schickt den bisherigen Text als Teil an reactive.chat. false = nie.
    'strom'        => true,
    'strom_ms'     => 400,        // Mindestabstand zweier Teile je Antwort (ms, ab 100)
    'protokoll'    => __DIR__ . '/rc-knoten.log',
    'zeitzone'     => 'Europe/Berlin',

    // Nur fuer Sonderfaelle: Basic-Auth einer Vorabumgebung ('nutzer:passwort'),
    //  eine feste Namensaufloesung ('host:443:1.2.3.4') fuer curl.
    'basic'   => '',
    'resolve' => '',
];
