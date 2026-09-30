# frozen_string_literal: true

require 'json'
require_relative 'php'

module RcNode
  class ConfigError < StandardError; end

  # rc-node.json - flat JSON object with English keys (see ../CONTRACT.md).
  # Unknown keys are ignored. RC_NODE_SECRET and RC_NODE_MODEL_API_KEY
  # override the file.
  class Config
    KIND_ALIASES = {
      'translation' => 'uebersetzung',
      'summary' => 'zusammenfassung',
      'embedding' => 'einbettung'
    }.freeze

    attr_reader :base_url, :node_id, :secret, :model, :model_endpoint, :chat_url,
                :model_api_key, :model_key_header, :kinds, :capabilities,
                :embed_url, :embed_model, :embed_timeout, :images, :images_max,
                :stream, :stream_ms, :concurrency, :poll_wait, :timeout,
                :temperature, :max_tokens, :basic_auth, :resolve, :tls_verify,
                :log_file, :timezone, :path

    def self.resolve_path(cli_path, env = ENV)
      return cli_path if cli_path && !cli_path.empty?
      return env['RC_NODE_CONFIG'] if env['RC_NODE_CONFIG'] && !env['RC_NODE_CONFIG'].empty?

      File.join(Dir.pwd, 'rc-node.json')
    end

    def self.load(path, env = ENV)
      unless File.file?(path) && File.readable?(path)
        raise ConfigError, "config file #{path} not found or not readable " \
                           '(copy rc-node.example.json, fill it in, chmod 600)'
      end
      raw = File.binread(path).force_encoding(Encoding::UTF_8)
      raw = raw.delete_prefix("\uFEFF")
      data = begin
        JSON.parse(raw)
      rescue JSON::ParserError, EncodingError => e
        raise ConfigError, "config file #{path} is not valid JSON: #{e.message.lines.first.to_s.strip}"
      end
      raise ConfigError, "config file #{path} must contain a JSON object" unless data.is_a?(Hash)

      new(data, env, path)
    end

    def initialize(data, env = ENV, path = nil)
      @path = path
      d = data.dup
      d['secret'] = env['RC_NODE_SECRET'] if env['RC_NODE_SECRET'] && !env['RC_NODE_SECRET'].empty?
      if env['RC_NODE_MODEL_API_KEY'] && !env['RC_NODE_MODEL_API_KEY'].empty?
        d['model_api_key'] = env['RC_NODE_MODEL_API_KEY']
      end

      %w[base_url node_id secret model].each do |key|
        raise ConfigError, "missing '#{key}' in the configuration" unless Php.truthy?(d[key])
      end
      unless Php.truthy?(d['model_endpoint']) || Php.truthy?(d['chat_url'])
        raise ConfigError, "missing 'model_endpoint' in the configuration (or 'chat_url' for Azure)"
      end

      @base_url = string(d, 'base_url')
      @node_id = string(d, 'node_id')
      unless @node_id.start_with?('kn-')
        raise ConfigError, "'node_id' must start with kn- (as shown in the customer area)"
      end

      @secret = string(d, 'secret')
      @model = string(d, 'model')
      @model_endpoint = string(d, 'model_endpoint')
      @chat_url = string(d, 'chat_url')
      @model_api_key = string(d, 'model_api_key')
      @model_key_header = string(d, 'model_key_header', 'Authorization')
      @kinds = kind_list(d.key?('kinds') ? d['kinds'] : ['chat'])
      caps = kind_list(d['capabilities'])
      @capabilities = caps.empty? ? @kinds : caps
      @embed_url = string(d, 'embed_url')
      @embed_model = string(d, 'embed_model')
      @embed_timeout = integer(d, 'embed_timeout', 120)
      @images = boolean(d, 'images', false)
      @images_max = integer(d, 'images_max', 1)
      @stream = boolean(d, 'stream', true)
      @stream_ms = integer(d, 'stream_ms', 400)
      @concurrency = integer(d, 'concurrency', 1)
      @poll_wait = integer(d, 'poll_wait', 20)
      @timeout = integer(d, 'timeout', 120)
      @temperature = d.key?('temperature') && !d['temperature'].nil? ? Php.float(d['temperature']) : 0.2
      @max_tokens = integer(d, 'max_tokens', 300)
      @basic_auth = string(d, 'basic_auth')
      @resolve = string(d, 'resolve')
      @tls_verify = boolean(d, 'tls_verify', true)
      @log_file = string(d, 'log_file')
      @timezone = string(d, 'timezone')

      if @kinds.include?('einbettung') && (@embed_url.empty? || @embed_model.empty?)
        raise ConfigError, "'kinds' contains 'einbettung' (embedding) - then 'embed_url' and 'embed_model' are required"
      end
      validate_resolve unless @resolve.empty?
    end

    # URL of the chat completion endpoint (modellUrl()).
    def model_url
      return @chat_url unless @chat_url.empty?

      "#{@model_endpoint.sub(%r{/+\z}, '')}/chat/completions"
    end

    def models_url
      "#{@model_endpoint.sub(%r{/+\z}, '')}/models"
    end

    # modellKopf(): Content-Type plus the key, if any.
    def model_headers
      h = { 'Content-Type' => 'application/json' }
      unless @model_api_key.empty?
        if @model_key_header.casecmp?('Authorization')
          h['Authorization'] = "Bearer #{@model_api_key}"
        else
          h[@model_key_header] = @model_api_key
        end
      end
      h
    end

    private

    def string(d, key, default = '')
      v = d[key]
      v.nil? ? default : Php.str(v)
    end

    def integer(d, key, default)
      v = d[key]
      v.nil? ? default : Php.int(v)
    end

    def boolean(d, key, default)
      v = d[key]
      v.nil? ? default : Php.truthy?(v)
    end

    def kind_list(value)
      list = case value
             when nil then []
             when Array then value
             when String then value.empty? ? [] : [value]
             else raise ConfigError, 'kinds and capabilities must be lists of strings'
             end
      list.map do |k|
        raise ConfigError, 'kinds and capabilities must be lists of strings' unless k.is_a?(String)

        KIND_ALIASES.fetch(k, k)
      end
    end

    def validate_resolve
      host, port, addr = @resolve.split(':', 3)
      return if host && !host.empty? && port.to_s.match?(/\A\d+\z/) && addr && !addr.empty?

      raise ConfigError, "'resolve' must look like host:port:ip"
    end
  end
end
