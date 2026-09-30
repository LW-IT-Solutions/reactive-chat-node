using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RcNode;

/// <summary>
/// The text rules of the reference node, ported regex for regex: clean-up of a model
/// answer, the number check, the stream cut and the image filter.
///
/// Non-ASCII characters are built with (char) casts on purpose, so that no editor or
/// copy step can silently turn an escape sequence into a different character.
/// </summary>
internal static class TextRules
{
    // PHP trim() strips exactly these: " \t\n\r\0\x0B".
    private static readonly char[] PhpTrimChars = { ' ', '\t', '\n', '\r', '\0', '\v' };

    public static string PhpTrim(string s) => s.Trim(PhpTrimChars);

    // ---- clean-up (saeubern) ------------------------------------------------

    // /<think>.*?<\/think>/su
    private static readonly Regex Think = new("<think>.*?</think>", RegexOptions.Singleline | RegexOptions.CultureInvariant);

    // /<[^>]*>/
    private static readonly Regex Tag = new("<[^>]*>", RegexOptions.CultureInvariant);

    // /^\s*(hier (ist|sind)[^:\n]*:|here (is|are)[^:\n]*:|antwort:|answer:)\s*/i  - no /u, so
    // \s is ASCII whitespace only and /i folds ASCII letters only.
    private const string AsciiWs = @"[ \t\n\v\f\r]";
    private static readonly Regex LeadIn = new(
        "^" + AsciiWs + "*(" + Ci("hier ") + "(" + Ci("ist") + "|" + Ci("sind") + @")[^:\n]*:|"
            + Ci("here ") + "(" + Ci("is") + "|" + Ci("are") + @")[^:\n]*:|"
            + Ci("antwort:") + "|" + Ci("answer:") + ")" + AsciiWs + "*",
        RegexOptions.CultureInvariant);

    // /^["\x{201C}\x{201E}\x{00AB}](.*)["\x{201D}\x{201C}\x{00BB}]$/us
    private static readonly Regex Quoted = new(
        "^[\"" + (char)0x201C + (char)0x201E + (char)0x00AB + "](.*)[\"" + (char)0x201D + (char)0x201C + (char)0x00BB + "]$",
        RegexOptions.Singleline | RegexOptions.CultureInvariant);

    // /\s*\R\s*/u  (PHP /u also sets UCP: \s is Unicode whitespace)
    private static readonly Regex LineBreak = new(
        @"\s*(?:\r\n|[\n\v\f\r" + (char)0x85 + (char)0x2028 + (char)0x2029 + @"])\s*",
        RegexOptions.CultureInvariant);

    // /\s{2,}/u
    private static readonly Regex MultiSpace = new(@"\s{2,}", RegexOptions.CultureInvariant);

    /// <summary>ASCII-only case-insensitive literal, like PCRE /i without /u.</summary>
    private static string Ci(string literal)
    {
        var sb = new StringBuilder();
        foreach (char ch in literal)
        {
            if (ch is >= 'a' and <= 'z') { sb.Append('[').Append(ch).Append(char.ToUpperInvariant(ch)).Append(']'); }
            else if (ch == ' ') { sb.Append(' '); }
            else { sb.Append(Regex.Escape(ch.ToString())); }
        }
        return sb.ToString();
    }

    /// <summary>Thinking blocks, markup, Markdown and lead-ins removed (saeubern).</summary>
    public static string Clean(string text)
    {
        string t = text ?? "";
        t = Think.Replace(t, " ");
        t = Tag.Replace(t, " ");
        t = t.Replace("**", "").Replace("__", "").Replace("`", "").Replace("#", "");
        t = PhpTrim(t);
        t = LeadIn.Replace(t, "", 1);
        t = PhpTrim(t);
        var m = Quoted.Match(t);
        if (m.Success) { t = PhpTrim(m.Groups[1].Value); }
        t = LineBreak.Replace(t, " ");
        return PhpTrim(MultiSpace.Replace(t, " "));
    }

    /// <summary>stripos($text, 'KEINE_ANTWORT') !== false, ASCII case folding only.</summary>
    public static bool ContainsNoAnswer(string text)
    {
        const string word = "KEINE_ANTWORT";
        for (int i = 0; i + word.Length <= text.Length; i++)
        {
            int k = 0;
            while (k < word.Length)
            {
                char ch = text[i + k];
                if (ch is >= 'a' and <= 'z') { ch = (char)(ch - 32); }
                if (ch != word[k]) { break; }
                k++;
            }
            if (k == word.Length) { return true; }
        }
        return false;
    }

    // ---- number check (zahlenPruefen) ----------------------------------------

    // /(\d)[ .,\x{00A0}\x{202F}\x{2009}](?=\d\d\d\b)/u
    private static readonly Regex ThousandsSep = new(
        @"(\d)[ .," + (char)0x00A0 + (char)0x202F + (char)0x2009 + @"](?=\d\d\d\b)",
        RegexOptions.CultureInvariant);

    // /\d+/  (no /u: ASCII digits)
    private static readonly Regex DigitRun = new("[0-9]+", RegexOptions.CultureInvariant);

    private static IEnumerable<string> DigitRuns(string s)
    {
        string joined = ThousandsSep.Replace(s ?? "", "$1");
        foreach (Match m in DigitRun.Matches(joined)) { yield return m.Value; }
    }

    /// <summary>
    /// Every digit sequence of the answer must occur in the facts. Returns the first one
    /// that does not, or null.
    /// </summary>
    public static string? NumberCheck(string text, string facts)
    {
        var allowed = new HashSet<string>(DigitRuns(facts), StringComparer.Ordinal);
        foreach (string z in DigitRuns(text))
        {
            if (!allowed.Contains(z)) { return z; }
        }
        return null;
    }

    // ---- stream cut (stromSchnitt) -------------------------------------------

    /// <summary>
    /// The text up to and including the last blank or line end - no half word, no half
    /// number. A space after a digit that is followed by a digit or by nothing yet may be
    /// a thousands separator ("1 000"); no cut there.
    /// </summary>
    public static string StreamCut(string text)
    {
        for (int i = text.Length - 1; i >= 0; i--)
        {
            char c = text[i];
            if (c != ' ' && c != '\n' && c != '\r' && c != '\t') { continue; }
            if (c == ' ' && i > 0 && IsAsciiDigit(text[i - 1])
                && (i + 1 == text.Length || IsAsciiDigit(text[i + 1]))) { continue; }
            return text[..(i + 1)];
        }
        return "";
    }

    private static bool IsAsciiDigit(char c) => c >= '0' && c <= '9';

    // ---- images (bilderAusAuftrag) --------------------------------------------

    private static readonly Regex ImageDataUrl = new(@"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$", RegexOptions.CultureInvariant);

    /// <summary>The images of a job, checked and capped. Empty unless images are enabled.</summary>
    public static List<string> ImagesFromJob(JsonElement? raw, bool enabled, int max)
    {
        var result = new List<string>();
        if (!enabled || raw is not JsonElement e || !Php.IsArray(e)) { return result; }
        foreach (var v in Php.Values(e))
        {
            if (result.Count >= Math.Max(0, max)) { break; }
            if (v.ValueKind != JsonValueKind.String) { continue; }
            string url = v.GetString() ?? "";
            if (Utf8Length(url) > 4 * 1024 * 1024) { continue; }
            if (!ImageDataUrl.IsMatch(url)) { continue; }
            result.Add(url);
        }
        return result;
    }

    // ---- helpers ---------------------------------------------------------------

    public static int Utf8Length(string s) => Encoding.UTF8.GetByteCount(s);

    /// <summary>mb_substr($s, 0, $n): the first n code points.</summary>
    public static string Substr(string s, int n)
    {
        int i = 0, count = 0;
        while (i < s.Length && count < n)
        {
            i += char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]) ? 2 : 1;
            count++;
        }
        return s[..i];
    }
}
