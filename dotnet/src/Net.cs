using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RcNode;

/// <summary>Outcome of one HTTP exchange. Error != "" means the transfer failed.</summary>
internal sealed class HttpResult
{
    public int Code;
    public byte[] Body = Array.Empty<byte>();
    /// <summary>Short, curl_strerror()-style text (goes into 'grund' on the wire).</summary>
    public string Error = "";
    /// <summary>Longer text for humans (probe output).</summary>
    public string Detail = "";
    public string BodyText => Encoding.UTF8.GetString(Body);
}

/// <summary>A reactive.chat answer, read like piLesen(): JSON object/list or null.</summary>
internal sealed class RcAnswer : IDisposable
{
    public int Code;
    public string Error = "";
    public string Raw = "";
    private JsonDocument? _doc;
    public JsonElement? Data => _doc?.RootElement;

    public static RcAnswer From(HttpResult r)
    {
        var a = new RcAnswer();
        if (r.Error != "") { a.Error = r.Error; return a; }
        a.Code = r.Code;
        a.Raw = r.BodyText;
        try
        {
            var doc = JsonDocument.Parse(r.Body, Php.JsonOptions);
            if (Php.IsArray(doc.RootElement)) { a._doc = doc; } else { doc.Dispose(); }
        }
        catch (Exception) { }
        return a;
    }

    public void Dispose() => _doc?.Dispose();
}

/// <summary>The request signature towards reactive.chat (HMAC-SHA256, scheme RC-KI-v2).</summary>
internal static class Signature
{
    /// <summary>hash_hmac('sha256', "RC-KI-v2\n" + ts + "\n" + method + "\n" + path + "\n" + query + "\n" + body, secret).</summary>
    public static string Sign(string secret, string ts, string method, string path, string query, byte[] body)
    {
        byte[] head = Encoding.UTF8.GetBytes("RC-KI-v2\n" + ts + "\n" + method + "\n" + path + "\n" + query + "\n");
        byte[] msg = new byte[head.Length + body.Length];
        Buffer.BlockCopy(head, 0, msg, 0, head.Length);
        Buffer.BlockCopy(body, 0, msg, head.Length, body.Length);
        byte[] mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), msg);
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    /// <summary>16 lowercase hex characters (8 random bytes).</summary>
    public static string Nonce() => Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
}

/// <summary>
/// HTTP for both sides. reactive.chat gets its own handler (resolve, tls_verify, basic auth
/// apply only there - as in the reference); the model and embedding servers share another.
/// Every call is asynchronous, so model calls, the long poll, bring and teil run in parallel.
/// </summary>
internal sealed class Net
{
    public const string UserAgent = AppInfo.UserAgent;

    private static readonly HttpRequestOptionsKey<double> ConnectKey = new("rc-node.connect-timeout");

    private readonly Config _c;
    private readonly HttpClient _rc;
    private readonly HttpClient _model;

    public Net(Config c)
    {
        _c = c;
        _rc = new HttpClient(Handler(c.ResolveEntry, c.TlsVerify), disposeHandler: true) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        _model = new HttpClient(Handler(null, true), disposeHandler: true) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
    }

    private static SocketsHttpHandler Handler(ResolveEntry? resolve, bool verify)
    {
        var h = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,      // curl does not follow redirects either
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(60),   // upper bound; the per-request value is applied below
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        };
        if (!verify)
        {
            h.SslOptions = new SslClientAuthenticationOptions { RemoteCertificateValidationCallback = (_, _, _, _) => true };
        }
        h.ConnectCallback = (ctx, ct) => ConnectAsync(ctx, ct, resolve);
        return h;
    }

    /// <summary>
    /// TCP connect with the request's connect timeout. With 'resolve' the socket goes to the
    /// fixed address while the URL (Host header, TLS SNI and certificate name) stays unchanged.
    /// </summary>
    private static async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext ctx, CancellationToken ct, ResolveEntry? resolve)
    {
        double secs = ctx.InitialRequestMessage.Options.TryGetValue(ConnectKey, out double s) ? s : 15;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (secs > 0) { cts.CancelAfter(TimeSpan.FromSeconds(secs)); }
        var ep = ctx.DnsEndPoint;
        try
        {
            IPAddress[] addrs;
            if (resolve != null && resolve.Matches(ep.Host, ep.Port)) { addrs = resolve.Addresses; }
            else if (IPAddress.TryParse(ep.Host, out var literal)) { addrs = new[] { literal }; }
            else { addrs = await Dns.GetHostAddressesAsync(ep.Host, cts.Token).ConfigureAwait(false); }

            Exception? last = null;
            foreach (var addr in addrs)
            {
                var sock = new Socket(addr.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await sock.ConnectAsync(new IPEndPoint(addr, ep.Port), cts.Token).ConfigureAwait(false);
                    return new NetworkStream(sock, ownsSocket: true);
                }
                catch (Exception e)
                {
                    sock.Dispose();
                    last = e;
                    if (cts.IsCancellationRequested) { break; }
                }
            }
            if (cts.IsCancellationRequested && !ct.IsCancellationRequested) { throw new TimeoutException(); }
            throw last ?? new SocketException((int)SocketError.HostNotFound);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("Connection timed out after " + (long)(secs * 1000) + " milliseconds");
        }
    }

    /// <summary>
    /// One request. totalS/connectS as CURLOPT_TIMEOUT/CURLOPT_CONNECTTIMEOUT (0 = no limit).
    /// With a stream state the body goes there chunk by chunk instead of into Body.
    /// Never throws.
    /// </summary>
    public async Task<HttpResult> SendAsync(bool toRc, HttpMethod method, Uri uri, byte[]? body,
        IReadOnlyList<KeyValuePair<string, string>> headers, double totalS, double connectS, StreamState? stream = null)
    {
        var r = new HttpResult();
        using var cts = new CancellationTokenSource();
        if (totalS > 0) { cts.CancelAfter(TimeSpan.FromSeconds(totalS)); }
        var sw = Stopwatch.StartNew();
        try
        {
            using var req = new HttpRequestMessage(method, uri);
            req.Options.Set(ConnectKey, connectS);
            ByteArrayContent? content = body != null ? new ByteArrayContent(body) : null;
            foreach (var (name, value) in headers)
            {
                if (name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
                {
                    // The reference sends Content-Type on every request, GET included.
                    content ??= new ByteArrayContent(Array.Empty<byte>());
                    content.Headers.TryAddWithoutValidation(name, value);
                }
                else
                {
                    req.Headers.TryAddWithoutValidation(name, value);
                }
            }
            req.Content = content;
            using var resp = await (toRc ? _rc : _model)
                .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
            r.Code = (int)resp.StatusCode;
            using var s = await resp.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false);
            var buf = new byte[16384];
            var ms = stream == null ? new MemoryStream() : null;
            int n;
            while ((n = await s.ReadAsync(buf, cts.Token).ConfigureAwait(false)) > 0)
            {
                if (stream != null) { stream.Feed(buf.AsSpan(0, n)); } else { ms!.Write(buf, 0, n); }
            }
            r.Body = ms?.ToArray() ?? Array.Empty<byte>();
        }
        catch (Exception e)
        {
            (r.Error, r.Detail) = Describe(e, cts.IsCancellationRequested, sw.ElapsedMilliseconds);
            if (r.Error == "") { r.Error = "transfer failed"; }
        }
        return r;
    }

    /// <summary>Exception to a curl-like error text: short (curl_strerror) and detailed.</summary>
    internal static (string shortText, string detail) Describe(Exception e, bool timedOut, long ms)
    {
        Exception inner = e;
        while (inner.InnerException != null) { inner = inner.InnerException; }
        string why = inner.Message;

        if (timedOut || Find<TimeoutException>(e) != null)
        {
            return ("Timeout was reached", "Operation timed out after " + ms + " milliseconds");
        }
        string shortText;
        var sock = Find<SocketException>(e);
        var hre = Find<HttpRequestException>(e);
        if (sock != null && sock.SocketErrorCode is SocketError.HostNotFound or SocketError.TryAgain or SocketError.NoData)
        {
            shortText = "Couldn't resolve host name";
        }
        else if (hre != null && hre.HttpRequestError == HttpRequestError.NameResolutionError)
        {
            shortText = "Couldn't resolve host name";
        }
        else if (hre != null && hre.HttpRequestError == HttpRequestError.ConnectionError)
        {
            shortText = "Couldn't connect to server";
        }
        else if (Find<AuthenticationException>(e) != null || (hre != null && hre.HttpRequestError == HttpRequestError.SecureConnectionError))
        {
            shortText = why.Contains("certificate", StringComparison.OrdinalIgnoreCase)
                ? "SSL peer certificate or SSH remote key was not OK"
                : "SSL connect error";
        }
        else if (hre != null && hre.HttpRequestError == HttpRequestError.ResponseEnded)
        {
            shortText = "Server returned nothing (no headers, no data)";
        }
        else if (hre != null && hre.HttpRequestError == HttpRequestError.InvalidResponse)
        {
            shortText = "Weird server reply";
        }
        else if (e is UriFormatException || e is InvalidOperationException)
        {
            shortText = "URL using bad/illegal format or missing URL";
        }
        else if (e is NotSupportedException)
        {
            shortText = "Unsupported protocol";
        }
        else if (sock != null && hre == null)
        {
            shortText = "Failure when receiving data from the peer";
        }
        else if (e is IOException || hre != null)
        {
            shortText = "Failure when receiving data from the peer";
        }
        else
        {
            shortText = why;
        }
        return (shortText, why == shortText ? shortText : shortText + " (" + why + ")");
    }

    private static T? Find<T>(Exception? e) where T : Exception
    {
        for (; e != null; e = e.InnerException) { if (e is T t) { return t; } }
        return null;
    }

    // ------------------------------------------------------------------
    // reactive.chat
    // ------------------------------------------------------------------

    /// <summary>
    /// A signed call to {base_url}/v1/ki?action=...&amp;knoten=...{extra}&amp;nonce=...
    /// GET without body, POST with body. The signed path and query are taken from the very
    /// URI that is sent, so they are byte-identical to the request line.
    /// </summary>
    public Task<HttpResult> RcAsync(string action, string? body, string extra, double totalS)
    {
        Uri uri;
        try
        {
            string url = _c.BaseUrl.TrimEnd('/') + "/v1/ki?action=" + action
                       + "&knoten=" + Uri.EscapeDataString(_c.NodeId) + extra
                       + "&nonce=" + Signature.Nonce();
            uri = new Uri(url, UriKind.Absolute);
        }
        catch (Exception e)
        {
            var (s, d) = Describe(e, false, 0);
            return Task.FromResult(new HttpResult { Error = s, Detail = d });
        }
        string path = uri.AbsolutePath;
        string query = uri.Query.StartsWith('?') ? uri.Query[1..] : uri.Query;
        string method = body != null ? "POST" : "GET";
        byte[]? bytes = body != null ? Encoding.UTF8.GetBytes(body) : null;
        string ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        string sig = Signature.Sign(_c.Secret, ts, method, path, query, bytes ?? Array.Empty<byte>());

        var headers = new List<KeyValuePair<string, string>>
        {
            new("X-RC-KI-TS", ts),
            new("X-RC-KI-SIG", sig),
            new("Content-Type", "application/json"),
            new("User-Agent", UserAgent),
        };
        if (_c.BasicAuth != "")
        {
            headers.Add(new("Authorization", "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(_c.BasicAuth))));
        }
        return SendAsync(true, body != null ? HttpMethod.Post : HttpMethod.Get, uri, bytes, headers, totalS, 15);
    }

    // ------------------------------------------------------------------
    // Model server (OpenAI style)
    // ------------------------------------------------------------------

    public List<KeyValuePair<string, string>> ModelHeaders()
    {
        var h = new List<KeyValuePair<string, string>> { new("Content-Type", "application/json") };
        if (_c.ModelApiKey != "")
        {
            h.Add(string.Equals(_c.ModelKeyHeader, "Authorization", StringComparison.OrdinalIgnoreCase)
                ? new("Authorization", "Bearer " + _c.ModelApiKey)
                : new(_c.ModelKeyHeader, _c.ModelApiKey));
        }
        return h;
    }

    /// <summary>The chat completions body (modellHandle), byte-identical to the reference.</summary>
    public byte[] ModelBody(string system, string prompt, long maxTokens, IReadOnlyList<string> images, bool stream)
    {
        object content = prompt;
        if (images.Count > 0)
        {
            var list = new List<object?> { new JObj { { "type", "text" }, { "text", prompt } } };
            foreach (string url in images)
            {
                list.Add(new JObj { { "type", "image_url" }, { "image_url", new JObj { { "url", url } } } });
            }
            content = list;
        }
        var o = new JObj
        {
            { "model", _c.Model },
            { "stream", stream },
            { "temperature", _c.Temperature },
            { "max_tokens", maxTokens > 0 ? maxTokens : (long)_c.MaxTokens },
            { "messages", new List<object?>
                {
                    new JObj { { "role", "system" }, { "content", system } },
                    new JObj { { "role", "user" }, { "content", content } },
                }
            },
        };
        return Encoding.UTF8.GetBytes(Php.Encode(o, unescapedUnicode: true));
    }

    public Task<HttpResult> ModelAsync(string system, string prompt, long maxTokens, IReadOnlyList<string> images, StreamState? stream)
    {
        Uri uri;
        try { uri = new Uri(_c.ModelUrl, UriKind.Absolute); }
        catch (Exception e)
        {
            var (s, d) = Describe(e, false, 0);
            return Task.FromResult(new HttpResult { Error = s, Detail = d });
        }
        return SendAsync(false, HttpMethod.Post, uri, ModelBody(system, prompt, maxTokens, images, stream != null),
                         ModelHeaders(), _c.Timeout, 10, stream);
    }

    /// <summary>GET {model_endpoint}/models (5 s, connect 3 s).</summary>
    public Task<HttpResult> ModelsAsync()
        => SendAsync(false, HttpMethod.Get, new Uri(_c.ModelsUrl, UriKind.Absolute), null, ModelHeaders(), 5, 3);

    // ------------------------------------------------------------------
    // Embedding server (OpenAI style /v1/embeddings)
    // ------------------------------------------------------------------

    public Task<HttpResult> EmbedAsync(IReadOnlyList<string> texts, double totalS)
    {
        var body = Php.Encode(new JObj { { "model", _c.EmbedModel }, { "input", texts.Cast<object?>().ToList() } }, unescapedUnicode: true);
        var headers = new List<KeyValuePair<string, string>> { new("Content-Type", "application/json") };
        return SendAsync(false, HttpMethod.Post, new Uri(_c.EmbedUrl, UriKind.Absolute), Encoding.UTF8.GetBytes(body), headers, totalS, 5);
    }
}
