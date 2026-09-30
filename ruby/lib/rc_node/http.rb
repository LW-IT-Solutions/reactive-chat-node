# frozen_string_literal: true

require 'net/http'
require 'openssl'
require 'timeout'
require 'uri'
require_relative 'version'

module RcNode
  # One HTTP exchange = one call. Blocking; the node runs each call in a
  # thread of its own. Errors never raise: they come back as a curl-like
  # message in Response#error (code 0), like curl_error() in the reference.
  class HttpClient
    Response = Struct.new(:code, :body, :error)

    class TotalTimeout < StandardError; end

    # +resolve+    "host:port:ip" - connect to ip, keep Host header and TLS
    #              name (curl --resolve); only for requests to host:port.
    # +tls_verify+ false = accept any certificate.
    def initialize(resolve: '', tls_verify: true)
      @resolve = parse_resolve(resolve.to_s)
      @tls_verify = tls_verify
    end

    # +on_data+ receives every body chunk as it arrives (streaming); the
    # body is then not collected in Response#body.
    def request(method, url, headers: {}, body: nil, timeout: 60, connect_timeout: 15,
                basic_auth: '', on_data: nil)
      uri = URI.parse(url)
      raise URI::InvalidURIError, "unsupported URL #{url}" unless uri.is_a?(URI::HTTP) && uri.hostname

      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      code = 0
      collected = String.new(encoding: Encoding::BINARY)
      Timeout.timeout(timeout.positive? ? timeout : nil, TotalTimeout) do
        http = build(uri, timeout, connect_timeout)
        req = build_request(method, uri, headers, body, basic_auth)
        http.start do |conn|
          conn.request(req) do |res|
            code = res.code.to_i
            res.read_body do |chunk|
              if on_data
                on_data.call(chunk)
              else
                collected << chunk
              end
            end
          end
        end
      end
      Response.new(code, collected, '')
    rescue TotalTimeout
      ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round
      Response.new(0, String.new, "Operation timed out after #{ms} milliseconds")
    rescue StandardError, Timeout::Error => e
      Response.new(0, String.new, describe(e, uri))
    end

    private

    def build(uri, timeout, connect_timeout)
      http = Net::HTTP.new(uri.hostname, uri.port)
      if (ip = resolved_ip(uri))
        http.ipaddr = ip
      end
      http.open_timeout = connect_timeout
      limit = timeout.positive? ? timeout : nil
      http.read_timeout = limit
      http.write_timeout = limit if http.respond_to?(:write_timeout=)
      http.max_retries = 0 if http.respond_to?(:max_retries=)
      if uri.scheme == 'https'
        http.use_ssl = true
        http.verify_mode = @tls_verify ? OpenSSL::SSL::VERIFY_PEER : OpenSSL::SSL::VERIFY_NONE
      end
      http
    end

    def build_request(method, uri, headers, body, basic_auth)
      target = uri.request_uri
      req = method == 'POST' ? Net::HTTP::Post.new(target) : Net::HTTP::Get.new(target)
      # Like curl: no Accept-Encoding, so bodies (and SSE) arrive unmodified.
      req.delete('Accept-Encoding')
      req['User-Agent'] = USER_AGENT
      headers.each { |k, v| req[k] = v }
      unless basic_auth.to_s.empty?
        user, pass = basic_auth.to_s.split(':', 2)
        req.basic_auth(user.to_s, pass.to_s)
      end
      req.body = body.to_s.b if method == 'POST'
      req
    end

    def parse_resolve(spec)
      return nil if spec.empty?

      host, port, addr = spec.split(':', 3)
      return nil unless host && port && addr

      addr = addr.split(',').first.to_s.delete_prefix('[').delete_suffix(']')
      { host: host.downcase, port: port.to_i, addr: addr }
    end

    def resolved_ip(uri)
      return nil unless @resolve
      return nil unless @resolve[:port] == uri.port
      return nil unless @resolve[:host] == '*' || @resolve[:host] == uri.hostname.downcase

      @resolve[:addr]
    end

    # A message in the spirit of curl_error().
    def describe(err, uri)
      host = uri&.hostname
      port = uri&.port
      case err
      when Net::OpenTimeout
        "Connection timed out (connecting to #{host} port #{port})"
      when Net::ReadTimeout, Net::WriteTimeout, Timeout::Error
        'Operation timed out'
      when Errno::ECONNREFUSED
        "Failed to connect to #{host} port #{port}: Connection refused"
      when Errno::EHOSTUNREACH, Errno::ENETUNREACH
        "Failed to connect to #{host} port #{port}: No route to host"
      when SocketError
        "Could not resolve host: #{host}"
      when Errno::ECONNRESET
        'Recv failure: Connection reset by peer'
      when EOFError
        'Empty reply from server'
      when OpenSSL::SSL::SSLError
        "SSL error: #{err.message}"
      when URI::InvalidURIError
        "URL rejected: #{err.message}"
      else
        "#{err.class}: #{err.message}"
      end
    end
  end
end
