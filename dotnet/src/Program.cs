// rc-node for .NET - the reactive.chat "bring your own model" AI node.
//
// Runs on YOUR machine: fetches the AI jobs of your workspace from reactive.chat, lets
// YOUR language model answer them and delivers the sentences back. The node calls out,
// reactive.chat never connects to it: no public address, no open port, no fixed IP.
//
// Wire behaviour follows the reference node rc-knoten.php v1.3; configuration, command
// line and logging follow ../CONTRACT.md. MIT licence.

using System.Runtime.InteropServices;

namespace RcNode;

internal static class Program
{
    public const string Version = AppInfo.Version;

    private const string Usage =
        "rc-node " + Version + " (.NET) - reactive.chat AI node\n\n"
        + "Usage: rc-node [--config=PATH] [--probe | --once | --one | --daemon]\n\n"
        + "  --probe    check reactive.chat and the model server, take no job\n"
        + "  --once     one fetch cycle, then exit (default)\n"
        + "  --one      like --once with one slot; prints SYSTEM/PROMPT of each job\n"
        + "  --daemon   run until SIGTERM/SIGINT (Ctrl+C), then finish running jobs and exit\n\n"
        + "Configuration: --config=PATH, else $RC_NODE_CONFIG, else ./rc-node.json\n"
        + "Environment:   RC_NODE_SECRET, RC_NODE_MODEL_API_KEY override the file.\n";

    public static async Task<int> Main(string[] args)
    {
        string? configPath = null;
        bool probe = false, one = false, daemon = false;
        foreach (string a in args)
        {
            if (a.StartsWith("--config=", StringComparison.Ordinal)) { configPath = a["--config=".Length..]; }
            else if (a == "--probe") { probe = true; }
            else if (a == "--once") { }
            else if (a == "--one") { one = true; }
            else if (a == "--daemon") { daemon = true; }
            else if (a is "--help" or "-h") { Console.Out.Write(Usage); return 0; }
            else if (a == "--version") { Console.Out.WriteLine("rc-node-dotnet " + Version); return 0; }
            else
            {
                Console.Error.WriteLine("rc-node: unknown option '" + a + "' (see --help).");
                return 2;
            }
        }

        Config c;
        string path = Config.ResolvePath(configPath);
        try { c = Config.Load(path); }
        catch (ConfigException e)
        {
            Console.Error.WriteLine("rc-node: " + e.Message);
            return 2;
        }

        var zone = Config.FindZone(c.Timezone);
        Log.Configure(zone, c.LogFile);
        if (c.Timezone != "" && zone == null)
        {
            Log.Say("Unknown time zone '" + c.Timezone + "' - log times use the system time zone.");
        }

        var net = new Net(c);
        try
        {
            if (probe) { return await Probe.RunAsync(c, net); }

            var worker = new Worker(c, net, one);
            if (!daemon)
            {
                int n = await worker.RunAsync(once: true);
                return n < 0 ? 1 : 0;
            }

            var registrations = new List<PosixSignalRegistration>();
            void OnSignal(PosixSignal signal, string name)
            {
                try
                {
                    registrations.Add(PosixSignalRegistration.Create(signal, ctx =>
                    {
                        ctx.Cancel = true;      // no hard exit: finish the running jobs first
                        worker.Stop(name);
                    }));
                }
                catch (Exception) { /* signal not available on this platform */ }
            }
            OnSignal(PosixSignal.SIGTERM, "SIGTERM");
            OnSignal(PosixSignal.SIGINT, "SIGINT");                                     // Ctrl+C on Windows too
            if (OperatingSystem.IsWindows()) { OnSignal(PosixSignal.SIGQUIT, "Ctrl+Break"); }

            Log.Say("Daemon mode. Node " + c.NodeId + ", model " + c.Model + " at " + c.ModelUrl
                + ", long poll " + c.PollWait + " s, up to " + Math.Max(1, c.Concurrency)
                + " in parallel, fetching: " + string.Join(", ", c.Kinds) + ".");
            await worker.RunAsync(once: false);
            Log.Say("Stopped.");
            GC.KeepAlive(registrations);
            return 0;
        }
        catch (Exception e)
        {
            Log.Say("Fatal error: " + e.GetType().Name + ": " + e.Message);
            return 1;
        }
    }
}
