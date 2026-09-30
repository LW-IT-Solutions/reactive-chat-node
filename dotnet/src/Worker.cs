using System.Diagnostics;
using System.Text.Json;

namespace RcNode;

/// <summary>One job from reactive.chat while it runs on this node.</summary>
internal sealed class Job
{
    public long Id;
    public string Kind = "chat";
    public string System = "";
    public string Prompt = "";
    public string Facts = "";
    public long MaxTokens;
    public List<string> Texts = new();
    public List<string> Images = new();
    public int Attempt = 1;
    public long Ms;

    // Streaming: the job asked for it ('strom'), state of the running attempt, parts sent.
    public bool Stream;
    public StreamState? Zs;
    public Task<HttpResult>? ModelTask;
    public int PartN;
    public double PartT = double.NegativeInfinity;
    public string PartText = "";
    public bool PartContinue = true;
}

/// <summary>
/// The loop: fetch, let the model compute, deliver - several at once (schleife()).
///
/// One logical loop owns all state. Every HTTP exchange is a Task running in parallel
/// (the model calls, the long poll, bring and teil); the loop starts them, then waits for
/// the next one to finish or for a short tick, and handles what is done. That gives the
/// observable behaviour of the reference's curl_multi loop: one hol, one bring and one
/// teil in flight at a time, up to 'concurrency' model calls meanwhile.
/// </summary>
internal sealed class Worker
{
    public const string RetrySuffix =
        "\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, "
        + "die nicht in den Quellen steht. Uebernimm Zahlen genau so, "
        + "wie sie dort stehen, oder lass sie weg.";

    /// <summary>Report in even when all slots are busy - otherwise the server thinks the node is dead.</summary>
    private const double PulseS = 45;

    private readonly Config _c;
    private readonly Net _net;
    private readonly bool _one;

    private volatile bool _keepRunning = true;
    private readonly TaskCompletionSource _stopSignal = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>True once reactive.chat rejected 'teil' with 400/404 - no streaming until restart.</summary>
    private bool _streamOff;

    public Worker(Config c, Net net, bool one)
    {
        _c = c;
        _net = net;
        _one = one;
    }

    /// <summary>Graceful stop: fetch nothing more, finish and deliver the running jobs.</summary>
    public void Stop(string signal)
    {
        _keepRunning = false;
        Log.Say(signal + " - stopping after the running jobs.");
        _stopSignal.TrySetResult();
    }

    private sealed class Pending
    {
        public string What = "";
        public long Id;
        public double T0;
        public StreamState? Zs;
        public Task<HttpResult> Task = null!;
    }

    private static double Now() => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;

    private static long MsSince(double t0) => (long)Math.Round((Now() - t0) * 1000, MidpointRounding.AwayFromZero);

    private static string Esc(IEnumerable<string> list) => Uri.EscapeDataString(string.Join(",", list));

    /// <summary>
    /// Runs the loop. once = one fetch cycle. Returns the number of finished jobs, or -1
    /// (once only) when the model server was not reachable or a connection error left
    /// nothing done.
    /// </summary>
    public async Task<int> RunAsync(bool once)
    {
        int slots = _one ? 1 : Math.Max(1, _c.Concurrency);
        int waitS = Math.Max(0, Math.Min(60, _c.PollWait));
        int deadline = waitS + 20;
        string kinds = Esc(_c.Kinds) + "&kann=" + Esc(_c.EffectiveCapabilities)
                     // Only a node that can take images tells reactive.chat so.
                     + (_c.Images ? "&bilder=1" : "");
        // Streaming: ONE teil call at a time for all running jobs together (at most 8
        // entries - reactive.chat takes no more), per job at most every stream_ms.
        int streamMs = Math.Max(100, _c.StreamMs);

        var pending = new List<Pending>();
        var running = new List<Job>();          // insertion order, like the PHP array
        var finished = new List<JObj>();
        var inBring = new List<JObj>();
        bool fetchOpen = false, bringOpen = false, partOpen = false, fetchedOnce = false;
        bool lineError = false, stopSeen = false;
        int done = 0, failRuns = 0, modelWaits = 0;
        double quietUntil = 0, lastCall = Now();

        Job? Find(long id) => running.Find(j => j.Id == id);

        void Start(string what, long id, StreamState? zs, Task<HttpResult> task)
            => pending.Add(new Pending { What = what, Id = id, T0 = Now(), Zs = zs, Task = task });

        void StartModel(Job j)
        {
            string p = j.Attempt == 1 ? j.Prompt : j.Prompt + RetrySuffix;
            // Stream only with 'strom' in the job AND in the configuration, and no longer
            // once reactive.chat rejected 'teil'. Every attempt starts with empty text.
            StreamState? zs = j.Stream && _c.Stream && !_streamOff ? new StreamState() : null;
            j.Zs = zs;
            j.PartText = "";
            j.ModelTask = _net.ModelAsync(j.System, p, j.MaxTokens, j.Images, zs);
            Start("model", j.Id, zs, j.ModelTask);
        }

        void Finish(Job j, string sentence, string reason)
        {
            running.Remove(j);
            done++;
            string what = sentence == ""
                ? " discarded: " + Answers.English(reason)
                : " " + j.Ms + " ms: " + (j.Kind == "einbettung"
                    ? j.Texts.Count + " text(s) embedded"
                    : TextRules.Substr(sentence, 100));
            Log.Say("  #" + j.Id + what
                + (j.Stream ? "  parts " + j.PartN + (j.PartContinue ? "" : " (stopped)") : "")
                + "  [" + running.Count + "/" + slots + "]");
            // Failures are delivered too: someone is waiting in the chat, and the server can
            // hand over at once instead of waiting for the lease to run out.
            finished.Add(new JObj
            {
                { "id", j.Id },
                { "text", sentence },
                { "grund", sentence == "" ? reason : "" },
                { "modell", _c.Model },
                { "ms", j.Ms },
                { "knoten", _c.NodeId },
            });
        }

        while (true)
        {
            int free = slots - running.Count;
            bool idle = !fetchOpen && !bringOpen && running.Count == 0 && !partOpen;
            bool fetchAllowed = _keepRunning && !(once && fetchedOnce) && Now() >= quietUntil;

            if (idle && finished.Count == 0 && (!_keepRunning || (once && fetchedOnce))) { break; }

            // First check that the model answers - otherwise the node would fetch jobs it
            // cannot do.
            if (idle && finished.Count == 0 && fetchAllowed)
            {
                if (!await ModelReadyAsync().ConfigureAwait(false))
                {
                    if (modelWaits % 6 == 0) { Log.Say("Model server not reachable, waiting."); }
                    modelWaits++;
                    if (once) { return -1; }
                    if (!_stopSignal.Task.IsCompleted)
                    {
                        await Task.WhenAny(_stopSignal.Task, Task.Delay(10_000)).ConfigureAwait(false);
                    }
                    continue;
                }
                if (modelWaits > 0) { Log.Say("Model server is reachable."); modelWaits = 0; }
            }

            if (fetchAllowed && !fetchOpen && free > 0)
            {
                Start("hol", 0, null, _net.RcAsync("hol", null,
                    "&n=" + Math.Min(free, slots) + "&warte=" + waitS + "&arten=" + kinds, deadline));
                fetchOpen = true;
                fetchedOnce = true;
                lastCall = Now();
            }
            else if (_keepRunning && !fetchOpen && free <= 0 && Now() - lastCall >= PulseS)
            {
                // 'kann' in the pulse too: without it the server would assume 'chat', and a
                // pure embedding node would lose its kind with every pulse.
                Start("puls", 0, null, _net.RcAsync("hol", null, "&n=0&warte=0&kann=" + Esc(_c.EffectiveCapabilities), 20));
                fetchOpen = true;
                lastCall = Now();
            }

            if (!bringOpen && finished.Count > 0)
            {
                string body = Php.Encode(new JObj { { "ergebnisse", finished.Cast<object?>().ToList() } }, unescapedUnicode: true);
                Start("bring", 0, null, _net.RcAsync("bring", body, "", 60));
                inBring = finished;
                finished = new List<JObj>();
                bringOpen = true;
            }

            // Parts while the model writes. Never blocking, one teil call at a time: a slow
            // server slows down the parts, not the answers. Only grown text, cut at the last
            // blank, per job at most every stream_ms. n counts up per job, across a retry too.
            if (!partOpen && !_streamOff)
            {
                double now = Now();
                var entries = new List<object?>();
                foreach (var j in running)
                {
                    if (entries.Count >= 8) { break; }
                    if (j.Zs == null || !j.PartContinue || (now - j.PartT) * 1000 < streamMs) { continue; }
                    // A finished call is handled below in this same pass (as curl_multi does in
                    // the reference): its text is the answer now, not a part.
                    if (j.ModelTask is { IsCompleted: true }) { continue; }
                    string text = TextRules.StreamCut(j.Zs.Text);
                    int bytes = TextRules.Utf8Length(text);
                    if (bytes <= TextRules.Utf8Length(j.PartText)) { continue; }
                    // reactive.chat takes no more - then no more parts for this job.
                    if (bytes > 16000) { j.PartContinue = false; continue; }
                    j.PartN++;
                    j.PartT = now;
                    j.PartText = text;
                    entries.Add(new JObj { { "id", j.Id }, { "n", j.PartN }, { "text", text } });
                }
                if (entries.Count > 0)
                {
                    Start("teil", 0, null, _net.RcAsync("teil", Php.Encode(new JObj { { "teile", entries } }, unescapedUnicode: true), "", 10));
                    partOpen = true;
                }
            }

            var completed = pending.Where(p => p.Task.IsCompleted).ToList();
            foreach (var p in completed) { pending.Remove(p); }

            foreach (var p in completed)
            {
                HttpResult res = p.Task.IsCompletedSuccessfully
                    ? p.Task.Result
                    : new HttpResult { Error = "internal error", Detail = p.Task.Exception?.GetBaseException().Message ?? "internal error" };
                // Streaming: the bytes are in the state; the rest after the last line end too.
                p.Zs?.Finish();

                switch (p.What)
                {
                    case "puls":
                        fetchOpen = false;
                        continue;

                    case "hol":
                    {
                        fetchOpen = false;
                        using var a = RcAnswer.From(res);
                        JsonElement jobs = default;
                        if (a.Code != 200 || a.Data is not JsonElement data || !Php.IsSet(data, "auftraege", out jobs))
                        {
                            Log.Say("Fetching jobs failed: HTTP " + a.Code + " "
                                + (a.Error != "" ? a.Error : TextRules.Substr(a.Raw, 160)));
                            lineError = true;
                            failRuns++;
                            quietUntil = Now() + Math.Min(300, 5 * failRuns);
                            continue;
                        }
                        failRuns = 0;
                        int fresh = 0;
                        foreach (var auf in Php.Values(jobs))
                        {
                            if (!Php.IsArray(auf)) { continue; }
                            long id = Php.ToInt(Php.Get(auf, "id"));
                            if (id <= 0 || Find(id) != null) { continue; }
                            var art = Php.Get(auf, "art");
                            var job = new Job
                            {
                                Id = id,
                                Kind = art is JsonElement ae ? Php.ToStr(ae) : "chat",
                                System = Php.ToStr(Php.Get(auf, "system")),
                                Prompt = Php.ToStr(Php.Get(auf, "prompt")),
                                Facts = Php.ToStr(Php.Get(auf, "fakten")),
                                MaxTokens = Php.ToInt(Php.Get(auf, "max_tokens")),
                                Texts = Php.Values(Php.Get(auf, "texte")).Select(t => Php.ToStr(t)).ToList(),
                                Images = TextRules.ImagesFromJob(Php.Get(auf, "bilder"), _c.Images, _c.ImagesMax),
                                Stream = Php.Truthy(Php.Get(auf, "strom")),
                            };
                            running.Add(job);

                            if (job.Kind == "einbettung")
                            {
                                if (_c.EmbedUrl == "" || job.Texts.Count == 0)
                                {
                                    Finish(job, "", _c.EmbedUrl == "" ? "kein Einbettungsserver" : "Einbettung ohne Texte");
                                    continue;
                                }
                                Start("einbettung", id, null, _net.EmbedAsync(job.Texts, _c.EmbedTimeout));
                                fresh++;
                                continue;
                            }
                            if (job.Prompt == "")
                            {
                                Finish(job, "", "Auftrag ohne Text");
                                continue;
                            }
                            if (_one)
                            {
                                Log.Raw("\n--- Job #" + id + " (" + job.Kind + ") ---\nSYSTEM:\n" + job.System
                                    + "\n\nPROMPT:\n" + job.Prompt
                                    + (job.Images.Count > 0 ? "\n\nIMAGES: " + job.Images.Count : "") + "\n\n");
                            }
                            StartModel(job);
                            fresh++;
                        }
                        if (fresh > 0) { Log.Say(fresh + " job(s) fetched [" + running.Count + "/" + slots + "]."); }
                        continue;
                    }

                    case "teil":
                    {
                        partOpen = false;
                        using var t = RcAnswer.From(res);
                        // 400/404: this server does not know 'teil' - streaming off until restart,
                        // said once. Network errors and everything else: the next part comes anyway.
                        if (t.Code == 400 || t.Code == 404)
                        {
                            _streamOff = true;
                            Log.Say("Streaming off until restart: teil answered HTTP " + t.Code + " " + TextRules.Substr(t.Raw, 120));
                            continue;
                        }
                        if (t.Code == 200 && t.Data is JsonElement td && Php.IsSet(td, "teile", out var parts) && Php.IsArray(parts))
                        {
                            foreach (var e in Php.Values(parts))
                            {
                                if (!Php.IsArray(e)) { continue; }
                                var job = Find(Php.ToInt(Php.Get(e, "id")));
                                // weiter:false - no more parts for this job.
                                if (job != null && Php.TryGet(e, "weiter", out var weiter) && !Php.Truthy(weiter))
                                {
                                    job.PartContinue = false;
                                }
                            }
                        }
                        continue;
                    }

                    case "bring":
                    {
                        bringOpen = false;
                        using var b = RcAnswer.From(res);
                        if (b.Code != 200 || b.Data is not JsonElement bd || !Php.IsSet(bd, "ergebnisse", out var results))
                        {
                            Log.Say("Delivering failed: HTTP " + b.Code + " "
                                + (b.Error != "" ? b.Error : TextRules.Substr(b.Raw, 160)));
                            lineError = true;
                            inBring = new List<JObj>();
                            continue;
                        }
                        int accepted = 0;
                        foreach (var e in Php.Values(results))
                        {
                            if (!Php.IsArray(e)) { continue; }
                            if (Php.Truthy(Php.Get(e, "angenommen"))) { accepted++; }
                            else if (Php.Truthy(Php.Get(e, "grund")))
                            {
                                Log.Say("  #" + Php.ToInt(Php.Get(e, "id")) + " rejected: " + Php.ToStr(Php.Get(e, "grund")));
                            }
                        }
                        Log.Say(accepted + " of " + inBring.Count + " accepted.");
                        inBring = new List<JObj>();
                        continue;
                    }
                }

                // A model or embedding call.
                var j = Find(p.Id);
                if (j == null) { continue; }
                if (p.What == "einbettung")
                {
                    j.Ms += MsSince(p.T0);
                    var (payload, error, _) = Answers.ReadEmbedding(res, j.Texts.Count, _c.EmbedModel);
                    Finish(j, payload ?? "", error);
                    continue;
                }
                var m = Answers.ReadModel(res, MsSince(p.T0), p.Zs);
                j.Ms += m.Ms;
                if (m.Text == null) { Finish(j, "", m.Error); continue; }

                string candidate = TextRules.Clean(m.Text);
                // KEINE_ANTWORT is the agreed word for "not in the sources" - passed on
                // unchanged, it leads to a hand-over.
                if (TextRules.ContainsNoAnswer(candidate)) { Finish(j, "KEINE_ANTWORT", ""); continue; }
                string? bad = TextRules.NumberCheck(candidate, j.Facts);
                if (bad == null && candidate != "") { Finish(j, candidate, ""); continue; }
                if (j.Attempt < 2) { j.Attempt++; StartModel(j); continue; }
                Finish(j, "", candidate == "" ? "leer nach dem Saeubern" : "erfundene Zahl: " + bad);
            }

            if (completed.Count == 0)
            {
                var waits = new List<Task>(pending.Count + 2);
                int ms;
                if (pending.Count > 0)
                {
                    foreach (var p in pending) { waits.Add(p.Task); }
                    // With a running stream 0.1 s: a due part should not wait.
                    ms = !_streamOff && running.Any(j => j.Zs != null && j.PartContinue) ? 100 : 1000;
                }
                else
                {
                    ms = 200;
                }
                if (!stopSeen)
                {
                    if (_stopSignal.Task.IsCompleted) { stopSeen = true; } else { waits.Add(_stopSignal.Task); }
                }
                using var tick = new CancellationTokenSource();
                waits.Add(Task.Delay(ms, tick.Token));
                await Task.WhenAny(waits).ConfigureAwait(false);
                tick.Cancel();
            }
        }
        return once && lineError && done == 0 ? -1 : done;
    }

    /// <summary>
    /// Does the model server answer? Embedding kinds need the embedding server; a process
    /// that only embeds does not need the language model. With 'chat_url' (Azure) there is
    /// no /models - then it counts as there.
    /// </summary>
    public async Task<bool> ModelReadyAsync()
    {
        if (_c.Kinds.Contains("einbettung") && !await EmbedReadyAsync().ConfigureAwait(false)) { return false; }
        if (_c.Kinds.All(k => k == "einbettung")) { return true; }
        if (_c.ChatUrl != "") { return true; }
        var r = await _net.ModelsAsync().ConfigureAwait(false);
        return r.Error == "" && r.Code == 200;
    }

    private async Task<bool> EmbedReadyAsync()
    {
        var r = await _net.EmbedAsync(new[] { "Bereit" }, 30).ConfigureAwait(false);
        return r.Error == "" && r.Code == 200;
    }
}
