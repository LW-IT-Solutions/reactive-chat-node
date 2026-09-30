# frozen_string_literal: true

require_relative 'version'
require_relative 'config'
require_relative 'logger'
require_relative 'node'

module RcNode
  # rc-node [--config=PATH] [--probe | --once | --one | --daemon]
  module CLI
    module_function

    USAGE = 'usage: rc-node [--config=PATH] [--probe | --once | --one | --daemon]'
    MODES = {
      '--probe' => :probe, '--once' => :once, '--one' => :one, '--daemon' => :daemon,
      # the reference's flag names, accepted as aliases
      '--einer' => :one, '--dauer' => :daemon
    }.freeze

    def run(argv, env = ENV)
      $stdout.sync = true
      config_path = nil
      modes = []
      argv.each do |arg|
        if arg.start_with?('--config=')
          config_path = arg.delete_prefix('--config=')
        elsif MODES.key?(arg)
          modes << MODES[arg]
        elsif %w[--help -h].include?(arg)
          $stdout.puts USAGE
          return 0
        elsif arg == '--version'
          $stdout.puts USER_AGENT
          return 0
        else
          return fail_config("unknown argument '#{arg}' (#{USAGE})")
        end
      end
      modes.uniq!
      return fail_config("use only one of --probe, --once, --one, --daemon (#{USAGE})") if modes.size > 1

      mode = modes.first || :once
      path = Config.resolve_path(config_path, env)
      config = begin
        Config.load(path, env)
      rescue ConfigError => e
        return fail_config(e.message)
      end

      logger = Logger.new(log_file: config.log_file, timezone: config.timezone)
      node = Node.new(config, logger, one: mode == :one)
      case mode
      when :probe
        node.probe
      when :daemon
        %w[TERM INT].each { |sig| Signal.trap(sig) { node.stop(sig) } }
        node.daemon
      else
        Signal.trap('INT') { exit!(130) }
        node.once
      end
    end

    def fail_config(message)
      warn "rc-node: configuration error: #{message}"
      2
    end
  end
end
