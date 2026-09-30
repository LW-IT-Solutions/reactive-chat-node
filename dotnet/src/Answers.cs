using System.Buffers.Binary;
using System.Text.Json;

namespace RcNode;

/// <summary>A model answer: Text, or null and a reason (German, as sent to the server).</summary>
internal readonly record struct ModelAnswer(string? Text, long Ms, string Error);

/// <summary>
/// Reading the answers of the model and embedding servers (modellLesen, einbettenLesen).
/// The reason strings are the reference's German 'grund' texts - reactive.chat and its
/// dashboards know them. <see cref="English"/> translates them for log lines.
/// </summary>
internal static class Answers
{
    public static ModelAnswer ReadModel(HttpResult r, long ms, StreamState? stream, bool detailed = false)
    {
        if (r.Error != "") { return new(null, ms, "Modell nicht erreichbar: " + (detailed ? r.Detail : r.Error)); }
        byte[] raw = stream != null ? stream.RawBytes : r.Body;
        if (r.Code != 200)
        {
            return new(null, ms, "Modell HTTP " + r.Code + ": " + TextRules.Substr(System.Text.Encoding.UTF8.GetString(raw), 160));
        }
        // Streamed: the text is already in the state. Without SSE (a server that ignores
        // stream:true) the recorded body is read like a normal answer below.
        if (stream != null && stream.Sse)
        {
            if (stream.Error != "") { return new(null, ms, "Modell-Strom: " + TextRules.Substr(stream.Error, 160)); }
            if (!stream.Content) { return new(null, ms, "Antwort ohne Text"); }
            if (!stream.End) { return new(null, ms, "Strom ohne Abschluss"); }
            return new(stream.Text, ms, "");
        }
        try
        {
            using var doc = JsonDocument.Parse(raw, Php.JsonOptions);
            JsonElement w = doc.RootElement;
            foreach (string step in new[] { "choices", "0", "message", "content" })
            {
                if (!Php.IsArray(w) || !Php.IsSet(w, step, out var next)) { return new(null, ms, "Antwort ohne Text"); }
                w = next;
            }
            return new(Php.ToStr(w), ms, "");
        }
        catch (Exception)
        {
            return new(null, ms, "Antwort ohne Text");
        }
    }

    /// <summary>
    /// The embedding server's answer -> the payload reactive.chat expects:
    /// {"vektoren":["base64 float32 LE", ...],"dims":N,"modell":"..."}, sorted by index.
    /// One vector more or less than texts is an error, not a partial success.
    /// </summary>
    public static (string? Payload, string Error, int Dims) ReadEmbedding(HttpResult r, int count, string embedModel, bool detailed = false)
    {
        if (r.Error != "") { return (null, "Einbettungsserver nicht erreichbar: " + (detailed ? r.Detail : r.Error), 0); }
        if (r.Code != 200) { return (null, "Einbettung HTTP " + r.Code + ": " + TextRules.Substr(r.BodyText, 160), 0); }
        JsonDocument doc;
        try { doc = JsonDocument.Parse(r.Body, Php.JsonOptions); }
        catch (Exception) { return (null, "Einbettung unlesbar", 0); }
        using (doc)
        {
            try
            {
                var j = doc.RootElement;
                if (!Php.IsArray(j) || !Php.IsSet(j, "data", out var data) || !Php.IsArray(data))
                {
                    return (null, "Einbettung unlesbar", 0);
                }
                // usort by (int)index - stable, as in PHP 8.
                var items = Php.Values(data)
                    .Select((e, pos) => (e, pos, idx: Php.IsArray(e) ? Php.ToInt(Php.Get(e, "index")) : 0L))
                    .OrderBy(x => x.idx).ThenBy(x => x.pos)
                    .Select(x => x.e)
                    .ToList();
                var vectors = new List<object?>();
                int dims = 0;
                foreach (var e in items)
                {
                    var values = Php.IsArray(e) ? Php.Values(Php.Get(e, "embedding")).ToList() : new List<JsonElement>();
                    if (values.Count == 0 || (dims > 0 && values.Count != dims))
                    {
                        return (null, "Vektor leer oder ungleich lang", 0);
                    }
                    dims = values.Count;
                    byte[] b = new byte[4 * values.Count];
                    for (int i = 0; i < values.Count; i++)
                    {
                        BinaryPrimitives.WriteSingleLittleEndian(b.AsSpan(4 * i), (float)Php.ToFloat(values[i]));
                    }
                    vectors.Add(Convert.ToBase64String(b));
                }
                if (vectors.Count != count) { return (null, vectors.Count + " Vektoren fuer " + count + " Texte", 0); }
                string payload = Php.Encode(new JObj { { "vektoren", vectors }, { "dims", dims }, { "modell", embedModel } },
                                            unescapedUnicode: false, unescapedSlashes: true);
                return (payload, "", dims);
            }
            catch (InvalidOperationException)
            {
                return (null, "Einbettung unlesbar", 0);
            }
        }
    }

    /// <summary>The German wire reasons in English, for log lines and the probe report.</summary>
    public static string English(string reason)
    {
        (string de, string en)[] prefixes =
        {
            ("Modell nicht erreichbar: ", "model server not reachable: "),
            ("Modell HTTP ", "model server answered HTTP "),
            ("Modell-Strom: ", "error in the model stream: "),
            ("Einbettungsserver nicht erreichbar: ", "embedding server not reachable: "),
            ("Einbettung HTTP ", "embedding server answered HTTP "),
            ("erfundene Zahl: ", "number not in the sources: "),
        };
        foreach (var (de, en) in prefixes)
        {
            if (reason.StartsWith(de, StringComparison.Ordinal)) { return en + reason[de.Length..]; }
        }
        switch (reason)
        {
            case "Antwort ohne Text": return "answer without text";
            case "Strom ohne Abschluss": return "stream ended without completion";
            case "Einbettung unlesbar": return "embedding answer unreadable";
            case "Vektor leer oder ungleich lang": return "vector empty or of unequal length";
            case "kein Einbettungsserver": return "no embedding server configured";
            case "Einbettung ohne Texte": return "embedding job without texts";
            case "Auftrag ohne Text": return "job without text";
            case "leer nach dem Saeubern": return "empty after clean-up";
        }
        var m = System.Text.RegularExpressions.Regex.Match(reason, "^([0-9]+) Vektoren fuer ([0-9]+) Texte$");
        if (m.Success) { return m.Groups[1].Value + " vectors for " + m.Groups[2].Value + " texts"; }
        return reason;
    }
}
