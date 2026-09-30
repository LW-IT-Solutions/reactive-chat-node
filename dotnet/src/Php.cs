using System.Collections;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace RcNode;

/// <summary>An ordered JSON object for <see cref="Php.Encode"/>.</summary>
internal sealed class JObj : List<KeyValuePair<string, object?>>
{
    public void Add(string key, object? value) => Add(new KeyValuePair<string, object?>(key, value));
}

/// <summary>
/// PHP semantics where the wire depends on them: reading decoded JSON the way
/// <c>json_decode($x, true)</c> plus array access, casts and <c>empty()</c> see it,
/// and writing JSON byte for byte like <c>json_encode</c>.
/// </summary>
internal static class Php
{
    public static readonly JsonDocumentOptions JsonOptions = new() { MaxDepth = 512 };

    // ------------------------------------------------------------------
    // Reading
    // ------------------------------------------------------------------

    /// <summary>is_array() after json_decode(..., true): objects and lists.</summary>
    public static bool IsArray(JsonElement e) => e.ValueKind is JsonValueKind.Object or JsonValueKind.Array;

    /// <summary>array_key_exists($key, $e) on a decoded value.</summary>
    public static bool TryGet(JsonElement e, string key, out JsonElement value)
    {
        value = default;
        if (e.ValueKind == JsonValueKind.Object)
        {
            bool found = false;
            foreach (var p in e.EnumerateObject())
            {
                // Duplicate keys: the last one wins, as in PHP.
                if (p.Name == key) { value = p.Value; found = true; }
            }
            return found;
        }
        if (e.ValueKind == JsonValueKind.Array && IsCanonicalIndex(key, out int idx) && idx < e.GetArrayLength())
        {
            value = e[idx];
            return true;
        }
        return false;
    }

    /// <summary>isset($e[$key]): present and not null.</summary>
    public static bool IsSet(JsonElement e, string key, out JsonElement value)
        => TryGet(e, key, out value) && value.ValueKind != JsonValueKind.Null;

    public static bool IsSet(JsonElement e, string key) => IsSet(e, key, out _);

    /// <summary>$e[$key] ?? null, as an optional element.</summary>
    public static JsonElement? Get(JsonElement e, string key) => IsSet(e, key, out var v) ? v : null;

    private static bool IsCanonicalIndex(string key, out int idx)
    {
        idx = 0;
        if (key.Length == 0 || key.Length > 9 || (key.Length > 1 && key[0] == '0')) { return false; }
        foreach (char ch in key) { if (ch < '0' || ch > '9') { return false; } }
        idx = int.Parse(key, CultureInfo.InvariantCulture);
        return true;
    }

    /// <summary>foreach ((array)$x as $v): list items, object values; null gives nothing, a scalar itself.</summary>
    public static IEnumerable<JsonElement> Values(JsonElement? x)
    {
        if (x is not JsonElement e) { yield break; }
        switch (e.ValueKind)
        {
            case JsonValueKind.Array:
                foreach (var v in e.EnumerateArray()) { yield return v; }
                break;
            case JsonValueKind.Object:
                foreach (var p in e.EnumerateObject()) { yield return p.Value; }
                break;
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                break;
            default:
                yield return e;
                break;
        }
    }

    /// <summary>!empty($x).</summary>
    public static bool Truthy(JsonElement? x)
    {
        if (x is not JsonElement e) { return false; }
        switch (e.ValueKind)
        {
            case JsonValueKind.True: return true;
            case JsonValueKind.String:
                string s = e.GetString() ?? "";
                return s != "" && s != "0";
            case JsonValueKind.Number:
                return e.TryGetDouble(out double d) ? d != 0 : true;
            case JsonValueKind.Array: return e.GetArrayLength() > 0;
            case JsonValueKind.Object:
                foreach (var _ in e.EnumerateObject()) { return true; }
                return false;
            default: return false;
        }
    }

    /// <summary>(string)$x.</summary>
    public static string ToStr(JsonElement? x)
    {
        if (x is not JsonElement e) { return ""; }
        switch (e.ValueKind)
        {
            case JsonValueKind.String: return e.GetString() ?? "";
            case JsonValueKind.True: return "1";
            case JsonValueKind.Number:
                if (e.TryGetInt64(out long l)) { return l.ToString(CultureInfo.InvariantCulture); }
                return FloatToString(e.GetDouble());
            case JsonValueKind.Array:
            case JsonValueKind.Object: return "Array";
            default: return "";
        }
    }

    /// <summary>(int)$x.</summary>
    public static long ToInt(JsonElement? x)
    {
        if (x is not JsonElement e) { return 0; }
        switch (e.ValueKind)
        {
            case JsonValueKind.Number:
                if (e.TryGetInt64(out long l)) { return l; }
                return DoubleToInt(e.TryGetDouble(out double d) ? d : 0);
            case JsonValueKind.String: return StringToInt(e.GetString() ?? "");
            case JsonValueKind.True: return 1;
            case JsonValueKind.Array: return e.GetArrayLength() > 0 ? 1 : 0;
            case JsonValueKind.Object: return Truthy(e) ? 1 : 0;
            default: return 0;
        }
    }

    /// <summary>(float)$x.</summary>
    public static double ToFloat(JsonElement? x)
    {
        if (x is not JsonElement e) { return 0; }
        switch (e.ValueKind)
        {
            case JsonValueKind.Number:
                if (e.TryGetDouble(out double d)) { return d; }
                return double.Parse(e.GetRawText(), NumberStyles.Float, CultureInfo.InvariantCulture);
            case JsonValueKind.String: return StringToFloat(e.GetString() ?? "");
            case JsonValueKind.True: return 1;
            case JsonValueKind.Array:
            case JsonValueKind.Object: return Truthy(e) ? 1 : 0;
            default: return 0;
        }
    }

    /// <summary>The leading numeric part of a string, as PHP reads it.</summary>
    private static (bool integer, string text) NumericPrefix(string s)
    {
        int i = 0;
        while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r' || s[i] == '\v' || s[i] == '\f')) { i++; }
        int start = i;
        if (i < s.Length && (s[i] == '+' || s[i] == '-')) { i++; }
        int digits = 0;
        while (i < s.Length && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
        bool integer = true;
        if (i < s.Length && s[i] == '.')
        {
            int j = i + 1, frac = 0;
            while (j < s.Length && s[j] >= '0' && s[j] <= '9') { j++; frac++; }
            if (digits + frac > 0) { i = j; digits += frac; integer = false; }
        }
        if (digits == 0) { return (true, ""); }
        if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
        {
            int j = i + 1;
            if (j < s.Length && (s[j] == '+' || s[j] == '-')) { j++; }
            int exp = 0;
            while (j < s.Length && s[j] >= '0' && s[j] <= '9') { j++; exp++; }
            if (exp > 0) { i = j; integer = false; }
        }
        return (integer, s[start..i]);
    }

    private static long StringToInt(string s)
    {
        var (integer, text) = NumericPrefix(s);
        if (text == "") { return 0; }
        if (integer)
        {
            if (long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long l)) { return l; }
            return text.StartsWith('-') ? long.MinValue : long.MaxValue;
        }
        return DoubleToInt(double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture));
    }

    private static double StringToFloat(string s)
    {
        var (_, text) = NumericPrefix(s);
        return text == "" ? 0 : double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    private static long DoubleToInt(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d) || d >= 9.2233720368547758E18 || d <= -9.2233720368547758E18) { return 0; }
        return (long)Math.Truncate(d);
    }

    private static string FloatToString(double d)
    {
        if (double.IsNaN(d)) { return "NAN"; }
        if (double.IsInfinity(d)) { return d > 0 ? "INF" : "-INF"; }
        if (d == Math.Truncate(d) && Math.Abs(d) < 1e15) { return ((long)d).ToString(CultureInfo.InvariantCulture); }
        string r = d.ToString("R", CultureInfo.InvariantCulture);
        int e = r.IndexOf('E');
        if (e < 0) { return r; }
        string mant = r[..e];
        if (!mant.Contains('.')) { mant += ".0"; }
        string exp = r[(e + 1)..];
        char sign = exp.StartsWith('-') ? '-' : '+';
        string digits = exp.TrimStart('+', '-').TrimStart('0');
        return mant + "E" + sign + (digits == "" ? "0" : digits);
    }

    // ------------------------------------------------------------------
    // Writing: json_encode()
    // ------------------------------------------------------------------

    /// <summary>
    /// json_encode($v, flags). <paramref name="unescapedUnicode"/> = JSON_UNESCAPED_UNICODE,
    /// <paramref name="unescapedSlashes"/> = JSON_UNESCAPED_SLASHES. Invalid UTF-16 is
    /// replaced by U+FFFD (JSON_INVALID_UTF8_SUBSTITUTE).
    /// </summary>
    public static string Encode(object? v, bool unescapedUnicode = true, bool unescapedSlashes = false)
    {
        var sb = new StringBuilder();
        Write(sb, v, unescapedUnicode, unescapedSlashes);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, object? v, bool uu, bool us)
    {
        switch (v)
        {
            case null: sb.Append("null"); break;
            case bool b: sb.Append(b ? "true" : "false"); break;
            case string s: WriteString(sb, s, uu, us); break;
            case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); break;
            case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); break;
            case double d: sb.Append(FormatDouble(d)); break;
            case JObj o:
                sb.Append('{');
                for (int k = 0; k < o.Count; k++)
                {
                    if (k > 0) { sb.Append(','); }
                    WriteString(sb, o[k].Key, uu, us);
                    sb.Append(':');
                    Write(sb, o[k].Value, uu, us);
                }
                sb.Append('}');
                break;
            case IEnumerable list:
                sb.Append('[');
                bool first = true;
                foreach (var item in list)
                {
                    if (!first) { sb.Append(','); }
                    first = false;
                    Write(sb, item, uu, us);
                }
                sb.Append(']');
                break;
            default:
                throw new ArgumentException("cannot encode " + v.GetType().Name);
        }
    }

    private const string Hex = "0123456789abcdef";

    private static void AppendU(StringBuilder sb, int unit)
    {
        sb.Append('\\').Append('u')
          .Append(Hex[(unit >> 12) & 0xF]).Append(Hex[(unit >> 8) & 0xF])
          .Append(Hex[(unit >> 4) & 0xF]).Append(Hex[unit & 0xF]);
    }

    public static void WriteString(StringBuilder sb, string s, bool uu, bool us)
    {
        sb.Append('"');
        foreach (Rune r in s.EnumerateRunes())
        {
            int c = r.Value;
            switch (c)
            {
                case '"': sb.Append("\\\""); continue;
                case '\\': sb.Append("\\\\"); continue;
                case '/': sb.Append(us ? "/" : "\\/"); continue;
                case '\b': sb.Append("\\b"); continue;
                case '\f': sb.Append("\\f"); continue;
                case '\n': sb.Append("\\n"); continue;
                case '\r': sb.Append("\\r"); continue;
                case '\t': sb.Append("\\t"); continue;
            }
            if (c < 0x20) { AppendU(sb, c); continue; }
            if (c < 0x80) { sb.Append((char)c); continue; }
            // JSON_UNESCAPED_UNICODE still escapes U+2028/U+2029 (no JSON_UNESCAPED_LINE_TERMINATORS).
            if (uu && c != 0x2028 && c != 0x2029) { sb.Append(r.ToString()); continue; }
            if (c >= 0x10000)
            {
                // UTF-16 surrogate pair, each half escaped.
                int v = c - 0x10000;
                AppendU(sb, 0xD800 + (v >> 10));
                AppendU(sb, 0xDC00 + (v & 0x3FF));
            }
            else
            {
                AppendU(sb, c);
            }
        }
        sb.Append('"');
    }

    /// <summary>A float as json_encode writes it with serialize_precision = -1.</summary>
    public static string FormatDouble(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) { return "0"; }
        string s = d.ToString("R", CultureInfo.InvariantCulture);
        int e = s.IndexOf('E');
        if (e < 0) { return s.Contains('.') ? s : s + ".0"; }
        string mant = s[..e];
        if (!mant.Contains('.')) { mant += ".0"; }
        string exp = s[(e + 1)..];
        char sign = exp.StartsWith('-') ? '-' : '+';
        string digits = exp.TrimStart('+', '-').TrimStart('0');
        return mant + "e" + sign + (digits == "" ? "0" : digits);
    }
}
