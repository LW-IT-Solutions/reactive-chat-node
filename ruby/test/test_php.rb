# frozen_string_literal: true

# PHP-compatibility helpers and configuration handling.
require 'minitest/autorun'
require 'json'
require 'tmpdir'
require_relative '../lib/rc_node'

class TestPhp < Minitest::Test
  P = RcNode::Php

  def test_json_encode_like_php
    uml = [0xFC].pack('U')
    assert_equal "{\"a\":\"x\\/y\",\"b\":\"#{uml}\",\"c\":\"\\u2028\"}",
                 P.json_encode({ 'a' => 'x/y', 'b' => uml, 'c' => [0x2028].pack('U') })
    assert_equal '"\\u00fc\\ud83d\\ude00"', P.json_encode("\u00fc\u{1F600}", unescaped_unicode: false)
    assert_equal '"a/b"', P.json_encode('a/b', unescaped_slashes: true)
    assert_equal '"\\u0001\\t\\n\\r\\b\\f\\"\\\\"', P.json_encode("\u0001\t\n\r\b\f\"\\")
    assert_equal '[]', P.json_encode([])
    assert_equal "\"#{[0xFFFD].pack('U')}\"", P.json_encode("\xFF".b)
  end

  def test_json_float_like_php
    assert_equal '-0.0', P.json_float(-0.0)
    { 0.2 => '0.2', 1.0 => '1.0', 0.0 => '0.0', 0.7 => '0.7', 100.0 => '100.0',
      1e16 => '10000000000000000.0', 1e17 => '1.0e+17', 0.0001 => '0.0001', 0.00001 => '1.0e-5',
      1.5e-7 => '1.5e-7', 123.456 => '123.456' }.each do |f, want|
      assert_equal want, P.json_float(f), "float #{f}"
    end
  end

  def test_int_cast
    assert_equal 12, P.int('12abc')
    assert_equal 0, P.int('abc')
    assert_equal 1000, P.int('1e3')
    assert_equal 7, P.int(7.9)
    assert_equal 1, P.int(true)
    assert_equal 0, P.int(nil)
  end

  def test_trim_only_php_characters
    assert_equal "\fa", P.trim(" \t\n\r\0\x0B\fa \n")
  end

  def test_rawurlencode
    assert_equal 'chat%2Ceinbettung', P.rawurlencode('chat,einbettung')
    assert_equal 'a-b_c.d~e%20%C3%BC', P.rawurlencode("a-b_c.d~e \u00fc")
  end

  def test_signed_query_is_the_sent_query
    url, path, query = RcNode::Wire.build_url('https://example.test/sub/', 'kn-1', 'hol', '&n=0', 'ab')
    assert_equal 'https://example.test/sub/v1/ki?action=hol&knoten=kn-1&n=0&nonce=ab', url
    assert_equal '/sub/v1/ki', path
    assert_equal 'action=hol&knoten=kn-1&n=0&nonce=ab', query
  end

  def test_chat_body_matches_reference_layout
    body = RcNode::Model.chat_body(model: 'm', temperature: 0.2, default_max_tokens: 300, system: 's',
                                   prompt: "p\u00fc/", max_tokens: 0)
    assert_equal "{\"model\":\"m\",\"stream\":false,\"temperature\":0.2,\"max_tokens\":300,\"messages\":" \
                 "[{\"role\":\"system\",\"content\":\"s\"},{\"role\":\"user\",\"content\":\"p\u00fc\\/\"}]}", body
    img = RcNode::Model.chat_body(model: 'm', temperature: 1, default_max_tokens: 300, system: 's',
                                  prompt: 'p', max_tokens: 5, images: ['data:x'], stream: true)
    assert_includes img, '"stream":true,"temperature":1.0,"max_tokens":5'
    assert_includes img, '"content":[{"type":"text","text":"p"},{"type":"image_url","image_url":{"url":"data:x"}}]'
  end

  def config(extra = {}, env = {})
    base = { 'base_url' => 'https://x.test', 'node_id' => 'kn-1', 'secret' => 'rcn_x', 'model' => 'm',
             'model_endpoint' => 'http://127.0.0.1:1/v1' }
    RcNode::Config.new(base.merge(extra), env)
  end

  def test_config_defaults_and_aliases
    c = config('kinds' => %w[chat translation summary embedding], 'embed_url' => 'u', 'embed_model' => 'e')
    assert_equal %w[chat uebersetzung zusammenfassung einbettung], c.kinds
    assert_equal c.kinds, c.capabilities
    assert_equal 1, c.concurrency
    assert_equal 20, c.poll_wait
    assert_equal true, c.stream
    assert_equal 400, c.stream_ms
    assert_in_delta 0.2, c.temperature
    assert_equal 'http://127.0.0.1:1/v1/chat/completions', c.model_url
  end

  def test_config_errors
    assert_raises(RcNode::ConfigError) { config('node_id' => 'x-1') }
    assert_raises(RcNode::ConfigError) { config('model_endpoint' => '') }
    assert_raises(RcNode::ConfigError) { config('kinds' => ['embedding']) }
    assert_raises(RcNode::ConfigError) { config('secret' => '') }
  end

  def test_env_overrides
    c = config({ 'secret' => '' }, { 'RC_NODE_SECRET' => 'rcn_env', 'RC_NODE_MODEL_API_KEY' => 'k' })
    assert_equal 'rcn_env', c.secret
    assert_equal 'Bearer k', c.model_headers['Authorization']
    c2 = config({ 'model_api_key' => 'z', 'model_key_header' => 'api-key' })
    assert_equal 'z', c2.model_headers['api-key']
  end

  def test_cli_exit_2_on_bad_config
    Dir.mktmpdir do |d|
      path = File.join(d, 'rc-node.json')
      File.write(path, '{"base_url": "https://x"}')
      err = capture_io { assert_equal 2, RcNode::CLI.run(["--config=#{path}", '--once']) }[1]
      assert_equal 1, err.lines.size
      err2 = capture_io { assert_equal 2, RcNode::CLI.run(["--config=#{d}/missing.json"]) }[1]
      assert_match(/not found/, err2)
      err3 = capture_io { assert_equal 2, RcNode::CLI.run(['--bogus']) }[1]
      assert_match(/unknown argument/, err3)
    end
  end
end
