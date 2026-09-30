# frozen_string_literal: true

require 'openssl'
require 'securerandom'
require_relative 'php'
require_relative 'http'

module RcNode
  # The line to reactive.chat: signed calls to /v1/ki (piHandle/piLesen).
  module Wire
    module_function

    SIGNATURE_PREFIX = "RC-KI-v2\n"

    # HMAC-SHA256 over "RC-KI-v2\n" ts "\n" method "\n" path "\n" query "\n" body.
    def sign(secret, ts, method, path, query, body)
      message = String.new(encoding: Encoding::BINARY)
      message << SIGNATURE_PREFIX << ts.to_s.b << "\n" << method.to_s.b << "\n" << path.to_s.b << "\n" \
              << query.to_s.b << "\n" << body.to_s.b
      OpenSSL::HMAC.hexdigest('SHA256', secret.to_s.b, message)
    end

    # The URL as the reference builds it, plus its path and query exactly as
    # PHP's parse_url() would return them (the query is signed byte for byte).
    def build_url(base_url, node_id, action, extra, nonce)
      url = "#{base_url.sub(%r{/+\z}, '')}/v1/ki?action=#{action}&knoten=#{Php.rawurlencode(node_id)}#{extra}&nonce=#{nonce}"
      m = %r{\A[A-Za-z][A-Za-z0-9+.\-]*://[^/?#]*([^?#]*)(?:\?([^#]*))?}.match(url)
      path = m && !m[1].empty? ? m[1] : '/'
      query = m ? m[2].to_s : ''
      [url, path, query]
    end

    # Parsed answer: code (0 on transport error), error, data (Hash/Array
    # from the JSON body or nil), raw body.
    Answer = Struct.new(:code, :error, :data, :raw)

    def read(response)
      return Answer.new(0, response.error, nil, '') unless response.error.empty?

      data = Php.json_decode(response.body)
      data = nil unless data.is_a?(Hash) || data.is_a?(Array)
      Answer.new(response.code, '', data, response.body.to_s)
    end

    # One signed call. GET without body, POST with body.
    class Client
      def initialize(config, http)
        @config = config
        @http = http
      end

      def call(action, body = nil, extra = '', timeout = 60)
        ts = Time.now.to_i.to_s
        nonce = SecureRandom.hex(8)
        url, path, query = Wire.build_url(@config.base_url, @config.node_id, action, extra, nonce)
        method = body.nil? ? 'GET' : 'POST'
        sig = Wire.sign(@config.secret, ts, method, path, query, body)
        headers = {
          'X-RC-KI-TS' => ts,
          'X-RC-KI-SIG' => sig,
          'Content-Type' => 'application/json'
        }
        Wire.read(@http.request(method, url, headers: headers, body: body, timeout: timeout,
                                              connect_timeout: 15, basic_auth: @config.basic_auth))
      end
    end
  end
end
