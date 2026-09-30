using System.Diagnostics;
using System.Text.Json;

namespace RcNode;

/// <summary>--probe: look at both sides, take nothing (n=0).</summary>
internal static class Probe
{
    public static async Task<int> RunAsync(Config c, Net net)
    {
        Log.Say("Probe, rc-node-dotnet " + AppInfo.Version + ".");

        // reactive.chat: a hol that takes nothing (n=0, warte=0).
        Log.Say("  reactive.chat: " + c.BaseUrl);
        string extra = "&n=0&warte=0&arten=" + Uri.EscapeDataString(string.Join(",", c.Kinds))
                     + "&kann=" + Uri.EscapeDataString(string.Join(",", c.EffectiveCapabilities));
        var hr = await net.RcAsync("hol", null, extra, 20);
        bool rcOk;
        using (var a = RcAnswer.From(hr))
        {
            rcOk = a.Code == 200 && a.Data is JsonElement;
            if (rcOk)
            {
                long open = a.Data is JsonElement d ? Php.ToInt(Php.Get(d, "offen")) : 0;
                Log.Say("    HTTP 200 - signed in, " + open + " job(s) open.");
            }
            else if (a.Code == 401)
            {
                Log.Say("    HTTP 401 - rejected. Are node ID and secret right? Is this machine's clock right (NTP)?"
                      + " Has the node been revoked in the customer area?");
            }
            else
            {
                Log.Say("    No connection: " + (hr.Error != "" ? hr.Detail
                        : "HTTP " + a.Code + " " + TextRules.Substr(a.Raw, 200)));
            }
        }

        // The model: one short test completion.
        Log.Say("  Model: " + c.ModelUrl + " (" + c.Model + ")");
        var sw = Stopwatch.StartNew();
        var mr = await net.ModelAsync("Antworte mit genau einem Wort.", "Sag: Bereit", 20, Array.Empty<string>(), null);
        var m = Answers.ReadModel(mr, (long)Math.Round(sw.Elapsed.TotalMilliseconds, MidpointRounding.AwayFromZero), null, detailed: true);
        Log.Say(m.Text == null
            ? "    " + Capital(Answers.English(m.Error))
            : "    Answer in " + m.Ms + " ms: " + TextRules.Clean(m.Text));

        // The embedding server, if there is one.
        if (c.EmbedUrl != "")
        {
            Log.Say("  Embedding: " + c.EmbedUrl + " (" + c.EmbedModel + ")");
            var esw = Stopwatch.StartNew();
            var er = await net.EmbedAsync(new[] { "Bereit" }, c.EmbedTimeout);
            var (payload, error, dims) = Answers.ReadEmbedding(er, 1, c.EmbedModel, detailed: true);
            Log.Say(payload == null
                ? "    " + Capital(Answers.English(error))
                : "    " + dims + " dimensions in " + (long)Math.Round(esw.Elapsed.TotalMilliseconds, MidpointRounding.AwayFromZero) + " ms");
        }

        Log.Say("  Node: " + c.NodeId + ", fetches: " + string.Join(", ", c.Kinds)
            + ", can: " + string.Join(", ", c.EffectiveCapabilities)
            + ", images: " + (c.Images ? "yes (at most " + c.ImagesMax + ")" : "no"));

        bool ok = hr.Error == "" && hr.Code == 200 && m.Text != null;
        if (ok)
        {
            Log.Say("Result: OK - reactive.chat accepted the node and the model answered.");
        }
        else
        {
            var problems = new List<string>();
            if (!(hr.Error == "" && hr.Code == 200)) { problems.Add("reactive.chat did not answer with HTTP 200"); }
            if (m.Text == null) { problems.Add("the model did not answer"); }
            Log.Say("Result: FAILED - " + string.Join("; ", problems) + ".");
        }
        return ok ? 0 : 1;
    }

    private static string Capital(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
}
