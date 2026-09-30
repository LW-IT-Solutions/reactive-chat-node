// Command rc-node is the reactive.chat "bring your own model" AI node.
//
// It runs on YOUR machine: it fetches the AI jobs of your workspace from
// reactive.chat, lets YOUR OpenAI-compatible model answer them and delivers
// the answers back. reactive.chat never connects to your machine - the node
// calls out, so it needs no public address, no open port and no fixed IP.
//
//	rc-node [--config=PATH] [--probe | --once | --one | --daemon]
//
// See README.md and ../CONTRACT.md.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	_ "time/tzdata" // IANA zones for `timezone`, also on Windows
)

const version = "2.0.0"

const userAgent = "rc-node-go/" + version

const usage = `rc-node-go ` + version + ` - reactive.chat AI node (bring your own model)

usage: rc-node [--config=PATH] [--probe | --once | --one | --daemon]

  --probe    check reactive.chat and the model, take no job
  --once     one fetch cycle, then exit (default)
  --one      like --once with one slot; print SYSTEM/PROMPT of each job
  --daemon   run until SIGTERM/SIGINT, then finish running jobs and exit

Config: --config=PATH, else $RC_NODE_CONFIG, else ./rc-node.json.
`

func main() {
	os.Exit(realMain(os.Args[1:]))
}

func realMain(args []string) int {
	var cfgFlag, mode string
	one := false
	for _, a := range args {
		switch {
		case strings.HasPrefix(a, "--config="):
			cfgFlag = strings.TrimPrefix(a, "--config=")
		case a == "--probe":
			mode = "probe"
		case a == "--daemon" || a == "--dauer":
			if mode != "probe" {
				mode = "daemon"
			}
		case a == "--once":
		case a == "--one" || a == "--einer":
			one = true
		case a == "--version":
			fmt.Println("rc-node-go " + version)
			return 0
		case a == "--help" || a == "-h":
			fmt.Print(usage)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "rc-node: unknown argument %q (see --help)\n", a)
			return 2
		}
	}

	cfg, err := loadConfig(configPath(cfgFlag))
	if err != nil {
		fmt.Fprintln(os.Stderr, "rc-node: "+err.Error())
		return 2
	}
	n := newNode(cfg, one)

	switch mode {
	case "probe":
		return n.probe()
	case "daemon":
		sig := make(chan os.Signal, 2)
		signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
		go func() {
			for s := range sig {
				name := "SIGINT"
				if s == syscall.SIGTERM {
					name = "SIGTERM"
				}
				n.stop.Store(true)
				n.say(name + " - stopping after the running jobs.")
				n.poke()
			}
		}()
		slots := cfg.Concurrency
		if slots < 1 {
			slots = 1
		}
		n.say(fmt.Sprintf("Daemon mode. Node %s, model %s at %s, long-poll %d s, up to %d at a time, takes: %s.",
			cfg.NodeID, cfg.Model, n.modelURL(), cfg.PollWait, slots, strings.Join(cfg.Kinds, ", ")))
		n.run(false)
		n.say("Finished.")
		return 0
	default:
		if n.run(true) < 0 {
			return 1
		}
		return 0
	}
}
