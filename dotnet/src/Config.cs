using System.Globalization;
using System.Net;
using System.Text.Json;

namespace RcNode;

/// <summary>A configuration problem: one English line on stderr, exit code 2.</summary>
internal sealed class ConfigException : Exception
{
    public ConfigException(string message) : base(message) { }
}

/// <summary>Fixed name resolution, like curl --resolve host:port:address[,address].</summary>
internal sealed class ResolveEntry
{
    public string Host = "";
    public int Port;
    public IPAddress[] Addresses = Array.Empty<IPAddress>();

    public bool Matches(string host, int port)
        => port == Port && string.Equals(host.Trim('[', ']'), Host, StringComparison.OrdinalIgnoreCase);

    public static ResolveEntry Parse(string s)
    {
        string v = s.Trim().TrimStart('+');
        int a = v.IndexOf(':');
        int b = a < 0 ? -1 : v.IndexOf(':', a + 1);
        if (a <= 0 || b < 0) { throw new ConfigException("'resolve' must look like host:port:ip (for example reactive.chat:443:203.0.113.10)."); }
        var e = new ResolveEntry { Host = v[..a].Trim('[', ']') };
        if (!int.TryParse(v[(a + 1)..b], NumberStyles.None, CultureInfo.InvariantCulture, out e.Port) || e.Port < 1 || e.Port > 65535)
        {
            throw new ConfigException("'resolve': the port must be a number between 1 and 65535.");
        }
        var list = new List<IPAddress>();
        foreach (string part in v[(b + 1)..].Split(','))
        {
            string ip = part.Trim().Trim('[', ']');
            if (!IPAddress.TryParse(ip, out var addr)) { throw new ConfigException("'resolve': '" + ip + "' is not an IP address."); }
            list.Add(addr);
        }
        e.Addresses = list.ToArray();
        return e;
    }
}

/// <summary>rc-node.json - flat JSON object, English keys, see ../CONTRACT.md.</summary>
internal sealed class Config
{
    public string BaseUrl = "";
    public string NodeId = "";
    public string Secret = "";
    public string Model = "";
    public string ModelEndpoint = "";
    public string ChatUrl = "";
    public string ModelApiKey = "";
    public string ModelKeyHeader = "Authorization";
    public List<string> Kinds = new() { "chat" };
    public List<string> Capabilities = new();
    public string EmbedUrl = "";
    public string EmbedModel = "";
    public int EmbedTimeout = 120;
    public bool Images;
    public int ImagesMax = 1;
    public bool Stream = true;
    public int StreamMs = 400;
    public int Concurrency = 1;
    public int PollWait = 20;
    public int Timeout = 120;
    public double Temperature = 0.2;
    public int MaxTokens = 300;
    public string BasicAuth = "";
    public string Resolve = "";
    public ResolveEntry? ResolveEntry;
    public bool TlsVerify = true;
    public string LogFile = "";
    public string Timezone = "";

    /// <summary>What the node can overall ('capabilities', empty = 'kinds').</summary>
    public List<string> EffectiveCapabilities => Capabilities.Count > 0 ? Capabilities : Kinds;

    /// <summary>The chat completions URL: 'chat_url' as is, else 'model_endpoint' + /chat/completions.</summary>
    public string ModelUrl => ChatUrl != "" ? ChatUrl : ModelEndpoint.TrimEnd('/') + "/chat/completions";

    public string ModelsUrl => ModelEndpoint.TrimEnd('/') + "/models";

    /// <summary>English aliases accepted in 'kinds'/'capabilities', mapped to the wire names.</summary>
    private static readonly Dictionary<string, string> KindAliases = new(StringComparer.Ordinal)
    {
        ["translation"] = "uebersetzung",
        ["summary"] = "zusammenfassung",
        ["embedding"] = "einbettung",
    };

    /// <summary>--config=PATH, else $RC_NODE_CONFIG, else ./rc-node.json.</summary>
    public static string ResolvePath(string? cliPath)
    {
        if (!string.IsNullOrEmpty(cliPath)) { return cliPath; }
        string? env = Environment.GetEnvironmentVariable("RC_NODE_CONFIG");
        if (!string.IsNullOrEmpty(env)) { return env; }
        return Path.Combine(Directory.GetCurrentDirectory(), "rc-node.json");
    }

    public static Config Load(string path)
    {
        byte[] bytes;
        try { bytes = File.ReadAllBytes(path); }
        catch (Exception)
        {
            throw new ConfigException("cannot read the configuration file " + path
                + " - copy rc-node.example.json to rc-node.json, fill it in and protect it with chmod 600.");
        }
        // Tolerate a UTF-8 byte order mark (Windows editors).
        int skip = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(bytes.AsMemory(skip), new JsonDocumentOptions { MaxDepth = 64 }); }
        catch (JsonException e)
        {
            throw new ConfigException("the configuration file " + path + " is not valid JSON (line "
                + ((e.LineNumber ?? 0) + 1) + "): " + e.Message.Split('\n')[0]);
        }
        using (doc)
        {
            return FromJson(doc.RootElement);
        }
    }

    public static Config FromJson(JsonElement o)
    {
        if (o.ValueKind != JsonValueKind.Object) { throw new ConfigException("the configuration must be a JSON object."); }
        var c = new Config
        {
            BaseUrl = Str(o, "base_url", ""),
            NodeId = Str(o, "node_id", ""),
            Secret = Str(o, "secret", ""),
            Model = Str(o, "model", ""),
            ModelEndpoint = Str(o, "model_endpoint", ""),
            ChatUrl = Str(o, "chat_url", ""),
            ModelApiKey = Str(o, "model_api_key", ""),
            ModelKeyHeader = Str(o, "model_key_header", "Authorization"),
            Kinds = KindList(o, "kinds", new List<string> { "chat" }),
            Capabilities = KindList(o, "capabilities", new List<string>()),
            EmbedUrl = Str(o, "embed_url", ""),
            EmbedModel = Str(o, "embed_model", ""),
            EmbedTimeout = Int(o, "embed_timeout", 120),
            Images = Bool(o, "images", false),
            ImagesMax = Int(o, "images_max", 1),
            Stream = Bool(o, "stream", true),
            StreamMs = Int(o, "stream_ms", 400),
            Concurrency = Int(o, "concurrency", 1),
            PollWait = Int(o, "poll_wait", 20),
            Timeout = Int(o, "timeout", 120),
            Temperature = Num(o, "temperature", 0.2),
            MaxTokens = Int(o, "max_tokens", 300),
            BasicAuth = Str(o, "basic_auth", ""),
            Resolve = Str(o, "resolve", ""),
            TlsVerify = Bool(o, "tls_verify", true),
            LogFile = Str(o, "log_file", ""),
            Timezone = Str(o, "timezone", ""),
        };

        // Environment overrides the file (keeps the secrets out of the file if wanted).
        string? envSecret = Environment.GetEnvironmentVariable("RC_NODE_SECRET");
        if (!string.IsNullOrEmpty(envSecret)) { c.Secret = envSecret; }
        string? envKey = Environment.GetEnvironmentVariable("RC_NODE_MODEL_API_KEY");
        if (!string.IsNullOrEmpty(envKey)) { c.ModelApiKey = envKey; }

        // Validation in the order of the reference.
        foreach (var (key, value) in new[] { ("base_url", c.BaseUrl), ("node_id", c.NodeId), ("secret", c.Secret), ("model", c.Model) })
        {
            if (value == "") { throw new ConfigException("the configuration lacks '" + key + "'."); }
        }
        if (c.ModelEndpoint == "" && c.ChatUrl == "")
        {
            throw new ConfigException("the configuration lacks 'model_endpoint' (or 'chat_url' for Azure).");
        }
        if (!c.NodeId.StartsWith("kn-", StringComparison.Ordinal))
        {
            throw new ConfigException("'node_id' must start with kn- - exactly as the customer area shows the node ID.");
        }
        if (c.Kinds.Contains("einbettung") && (c.EmbedUrl == "" || c.EmbedModel == ""))
        {
            throw new ConfigException("'kinds' contains 'einbettung' (embedding) - then 'embed_url' and 'embed_model' are required.");
        }
        CheckUrl("base_url", c.BaseUrl);
        CheckUrl("model_endpoint", c.ModelEndpoint);
        CheckUrl("chat_url", c.ChatUrl);
        CheckUrl("embed_url", c.EmbedUrl);
        if (c.Resolve != "") { c.ResolveEntry = ResolveEntry.Parse(c.Resolve); }
        if (c.ModelKeyHeader == "" || c.ModelKeyHeader.Any(ch => ch <= ' ' || ch == ':' || ch > '~'))
        {
            throw new ConfigException("'model_key_header' must be a plain HTTP header name such as Authorization or api-key.");
        }
        return c;
    }

    private static void CheckUrl(string key, string value)
    {
        if (value == "") { return; }
        if (!Uri.TryCreate(value, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https"))
        {
            throw new ConfigException("'" + key + "' must be an absolute http:// or https:// URL.");
        }
    }

    // ---- typed readers: null or missing = default -------------------------------

    private static bool Present(JsonElement o, string key, out JsonElement v)
        => o.TryGetProperty(key, out v) && v.ValueKind != JsonValueKind.Null;

    private static string Str(JsonElement o, string key, string def)
    {
        if (!Present(o, key, out var v)) { return def; }
        if (v.ValueKind != JsonValueKind.String) { throw new ConfigException("'" + key + "' must be a string."); }
        return v.GetString() ?? def;
    }

    private static int Int(JsonElement o, string key, int def)
    {
        if (!Present(o, key, out var v)) { return def; }
        double d;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out d)) { }
        else if (v.ValueKind == JsonValueKind.String
                 && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out d)) { }
        else { throw new ConfigException("'" + key + "' must be a whole number."); }
        d = Math.Truncate(d);
        return d > int.MaxValue ? int.MaxValue : d < int.MinValue ? int.MinValue : (int)d;
    }

    private static double Num(JsonElement o, string key, double def)
    {
        if (!Present(o, key, out var v)) { return def; }
        if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out double d)) { return d; }
        if (v.ValueKind == JsonValueKind.String
            && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out d)) { return d; }
        throw new ConfigException("'" + key + "' must be a number.");
    }

    private static bool Bool(JsonElement o, string key, bool def)
    {
        if (!Present(o, key, out var v)) { return def; }
        if (v.ValueKind == JsonValueKind.True) { return true; }
        if (v.ValueKind == JsonValueKind.False) { return false; }
        if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out double d)) { return d != 0; }
        throw new ConfigException("'" + key + "' must be true or false.");
    }

    private static List<string> KindList(JsonElement o, string key, List<string> def)
    {
        if (!Present(o, key, out var v)) { return def; }
        var raw = new List<string>();
        if (v.ValueKind == JsonValueKind.String) { raw.Add(v.GetString() ?? ""); }
        else if (v.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in v.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) { throw new ConfigException("'" + key + "' must be a list of strings."); }
                raw.Add(item.GetString() ?? "");
            }
        }
        else { throw new ConfigException("'" + key + "' must be a list of strings."); }
        return raw.Select(k => KindAliases.TryGetValue(k, out var wire) ? wire : k).ToList();
    }

    /// <summary>The configured time zone for log lines, or null for the system zone.</summary>
    public static TimeZoneInfo? FindZone(string id)
    {
        if (id == "") { return null; }
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception) { }
        try
        {
            if (TimeZoneInfo.TryConvertIanaIdToWindowsId(id, out string? win) && win != null)
            {
                return TimeZoneInfo.FindSystemTimeZoneById(win);
            }
        }
        catch (Exception) { }
        return null;
    }
}
