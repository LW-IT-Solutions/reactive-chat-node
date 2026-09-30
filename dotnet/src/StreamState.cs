using System.Text;
using System.Text.Json;

namespace RcNode;

/// <summary>
/// State of one streamed (SSE) model call, new for every attempt (stromNeu).
/// Bytes arrive on the HTTP task's thread (<see cref="Feed"/>); the worker loop reads
/// <see cref="Text"/> to send parts. All access goes through one lock.
/// </summary>
internal sealed class StreamState
{
    private const int RawCap = 4 * 1024 * 1024;

    private readonly object _gate = new();
    private readonly MemoryStream _raw = new();
    private byte[] _buffer = new byte[4096];
    private int _bufferLen;
    private readonly StringBuilder _text = new();

    private bool _sse, _content, _end;
    private string _error = "";

    /// <summary>At least one "data:" line was seen.</summary>
    public bool Sse { get { lock (_gate) { return _sse; } } }
    /// <summary>At least one delta.content string was seen.</summary>
    public bool Content { get { lock (_gate) { return _content; } } }
    /// <summary>[DONE] or a finish_reason was seen.</summary>
    public bool End { get { lock (_gate) { return _end; } } }
    /// <summary>Error event inside the stream (vLLM), or "".</summary>
    public string Error { get { lock (_gate) { return _error; } } }
    /// <summary>The text so far.</summary>
    public string Text { get { lock (_gate) { return _text.ToString(); } } }

    /// <summary>The raw body as received (capped at about 4 MB), for non-SSE answers.</summary>
    public byte[] RawBytes { get { lock (_gate) { return _raw.ToArray(); } } }

    public string RawText => Encoding.UTF8.GetString(RawBytes);

    /// <summary>Bytes from the model. A line may span two chunks: buffer up to the line end.</summary>
    public void Feed(ReadOnlySpan<byte> data)
    {
        lock (_gate)
        {
            if (_raw.Length < RawCap) { _raw.Write(data); }
            if (_bufferLen + data.Length > _buffer.Length)
            {
                Array.Resize(ref _buffer, Math.Max(_buffer.Length * 2, _bufferLen + data.Length));
            }
            data.CopyTo(_buffer.AsSpan(_bufferLen));
            _bufferLen += data.Length;

            int start = 0;
            while (true)
            {
                int nl = Array.IndexOf(_buffer, (byte)'\n', start, _bufferLen - start);
                if (nl < 0) { break; }
                Line(_buffer.AsSpan(start, nl - start));
                start = nl + 1;
            }
            if (start > 0)
            {
                Buffer.BlockCopy(_buffer, start, _buffer, 0, _bufferLen - start);
                _bufferLen -= start;
            }
        }
    }

    /// <summary>What is left after the last line end - at the end of the call (stromSchluss).</summary>
    public void Finish()
    {
        lock (_gate)
        {
            if (_bufferLen > 0)
            {
                Line(_buffer.AsSpan(0, _bufferLen));
                _bufferLen = 0;
            }
        }
    }

    private static readonly byte[] DataPrefix = Encoding.ASCII.GetBytes("data:");
    private static readonly byte[] Done = Encoding.ASCII.GetBytes("[DONE]");

    private static bool IsPhpTrimByte(byte b) => b is (byte)' ' or (byte)'\t' or (byte)'\n' or (byte)'\r' or 0 or 0x0B;

    /// <summary>One SSE line. Only "data: {...}" and "data: [DONE]" count.</summary>
    private void Line(ReadOnlySpan<byte> line)
    {
        // rtrim($line, "\r")
        int len = line.Length;
        while (len > 0 && line[len - 1] == (byte)'\r') { len--; }
        line = line[..len];
        if (!line.StartsWith(DataPrefix)) { return; }
        _sse = true;

        var payload = line[DataPrefix.Length..];
        int a = 0, b = payload.Length;
        while (a < b && IsPhpTrimByte(payload[a])) { a++; }
        while (b > a && IsPhpTrimByte(payload[b - 1])) { b--; }
        payload = payload[a..b];

        if (payload.SequenceEqual(Done)) { _end = true; return; }

        JsonDocument doc;
        try { doc = JsonDocument.Parse(payload.ToArray(), Php.JsonOptions); }
        catch (Exception) { return; }
        // A lone UTF-16 surrogate escape makes json_decode fail as a whole: the line is ignored.
        try { ApplyEvent(doc); }
        catch (InvalidOperationException) { }
        finally { doc.Dispose(); }
    }

    private void ApplyEvent(JsonDocument doc)
    {
        {
            var j = doc.RootElement;
            if (!Php.IsArray(j)) { return; }
            // vLLM reports an error in the middle of the stream as an event of its own.
            bool isErrorObject = Php.IsSet(j, "object", out var obj)
                                 && obj.ValueKind == JsonValueKind.String && obj.GetString() == "error";
            if (Php.IsSet(j, "error") || isErrorObject)
            {
                JsonElement f = Php.IsSet(j, "error", out var err) ? err : j;
                _error = Php.IsArray(f)
                    ? (Php.IsSet(f, "message", out var msg) ? Php.ToStr(msg) : "Fehler ohne Text")
                    : Php.ToStr(f);
                return;
            }
            if (!Php.IsSet(j, "choices", out var choices) || !Php.IsSet(choices, "0", out var c) || !Php.IsArray(c)) { return; }
            if (Php.IsSet(c, "delta", out var delta) && Php.IsArray(delta)
                && Php.IsSet(delta, "content", out var content) && content.ValueKind == JsonValueKind.String)
            {
                _text.Append(content.GetString());
                _content = true;
            }
            if (Php.TryGet(c, "finish_reason", out var fr) && Php.Truthy(fr)) { _end = true; }
        }
    }
}
