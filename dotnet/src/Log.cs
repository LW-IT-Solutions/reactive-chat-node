using System.Globalization;
using System.Text;

namespace RcNode;

/// <summary>
/// One line per event: "YYYY-MM-DD HH:MM:SS  text" to stdout and, if configured, appended
/// to the log file. Never pass the secret or the model API key.
/// </summary>
internal static class Log
{
    private static readonly object Gate = new();
    private static readonly UTF8Encoding Utf8 = new(false);
    private static TextWriter _out = new StreamWriter(Console.OpenStandardOutput(), Utf8) { AutoFlush = true, NewLine = "\n" };
    private static TimeZoneInfo? _zone;
    private static string _file = "";

    public static void Configure(TimeZoneInfo? zone, string file)
    {
        _zone = zone;
        _file = file ?? "";
    }

    /// <summary>For tests: capture the output.</summary>
    public static void RedirectForTests(TextWriter w) => _out = w;

    public static string Timestamp()
    {
        DateTime now = _zone == null ? DateTime.Now : TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, _zone);
        return now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
    }

    public static void Say(string line)
    {
        string z = Timestamp() + "  " + line + "\n";
        lock (Gate)
        {
            try { _out.Write(z); _out.Flush(); }
            catch (Exception) { /* stdout gone (closed pipe) - keep working */ }
            if (_file != "")
            {
                try { File.AppendAllText(_file, z, Utf8); }
                catch (Exception) { /* like the reference: a log file problem never stops the node */ }
            }
        }
    }

    /// <summary>Plain text to stdout only (the --one job dump).</summary>
    public static void Raw(string text)
    {
        lock (Gate)
        {
            try { _out.Write(text); _out.Flush(); }
            catch (Exception) { }
        }
    }
}
