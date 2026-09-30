# frozen_string_literal: true

require 'json'

module RcNode
  # Small helpers that reproduce the PHP semantics the reference node relies
  # on (type juggling, trim(), json_encode(), json_decode(), mb_substr()).
  # The wire format has to be byte-compatible with the PHP reference, so
  # these are deliberately literal rather than "idiomatic".
  module Php
    module_function

    TRIM_LEFT  = /\A[ \t\n\r\x00\x0B]+/n.freeze
    TRIM_RIGHT = /[ \t\n\r\x00\x0B]+\z/n.freeze

    # PHP trim(): strips only " \t\n\r\0\x0B" (not \f, not Unicode spaces).
    def trim(str)
      enc = str.encoding
      str.b.sub(TRIM_LEFT, '').sub(TRIM_RIGHT, '').force_encoding(enc)
    end

    # PHP empty() / truthiness.
    def truthy?(value)
      case value
      when nil, false then false
      when Integer, Float then !value.zero?
      when String then !(value.empty? || value == '0')
      when Array, Hash then !value.empty?
      else true
      end
    end

    NUMERIC_PREFIX = /\A[ \t\n\r\x0B\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.freeze

    # PHP (int) cast.
    def int(value)
      case value
      when Integer then value
      when Float then value.finite? ? value.truncate : 0
      when true then 1
      when nil, false then 0
      when String
        m = NUMERIC_PREFIX.match(value.b)
        return 0 unless m
        num = m[1]
        num.match?(/[.eE]/) ? int(Float(num)) : Integer(num, 10)
      when Array, Hash then value.empty? ? 0 : 1
      else 0
      end
    rescue ArgumentError, FloatDomainError
      0
    end

    # PHP (float) cast.
    def float(value)
      case value
      when Float then value
      when Integer then value.to_f
      when true then 1.0
      when nil, false then 0.0
      when String
        m = NUMERIC_PREFIX.match(value.b)
        m ? Float(m[1]) : 0.0
      when Array, Hash then value.empty? ? 0.0 : 1.0
      else 0.0
      end
    rescue ArgumentError
      0.0
    end

    # PHP (string) cast (floats in the "precision=14" style of echo).
    def str(value)
      case value
      when String then value
      when nil, false then ''
      when true then '1'
      when Integer then value.to_s
      when Float
        if value.finite? && value == value.truncate && value.abs < 1e15
          value.truncate.to_s
        else
          format('%.14G', value).sub(/\.?0+(?=E|\z)/, '')
        end
      when Array, Hash then 'Array'
      else value.to_s
      end
    end

    # PHP array access with isset()-semantics on a json_decode()d value:
    # returns nil where PHP's `$v[$key] ?? null` would be null.
    def get(value, key)
      case value
      when Hash
        value[key.to_s]
      when Array
        if key.is_a?(Integer)
          key >= 0 ? value[key] : nil
        elsif key.to_s.match?(/\A(?:0|[1-9]\d*)\z/)
          value[key.to_i]
        end
      end
    end

    # A PHP array (JSON object or list) as a list of its values.
    def values(value)
      case value
      when Hash then value.values
      when Array then value
      end
    end

    # PHP (array) cast of a decoded JSON value.
    def to_list(value)
      case value
      when nil then []
      when Hash then value.values
      when Array then value
      else [value]
      end
    end

    # PHP json_decode($s, true): nil on any error, including invalid UTF-8.
    def json_decode(raw)
      s = raw.to_s.dup.force_encoding(Encoding::UTF_8)
      return nil unless s.valid_encoding?
      return nil if s.strip.empty?
      JSON.parse(s, max_nesting: 512)
    rescue JSON::ParserError, JSON::NestingError, EncodingError
      nil
    end

    # mb_substr($s, 0, $n) for UTF-8.
    def mb_substr(raw, length)
      s = raw.to_s.dup.force_encoding(Encoding::UTF_8)
      s = s.scrub("\u{FFFD}") unless s.valid_encoding?
      s[0, length] || ''
    end

    # rawurlencode(): RFC 3986, everything except A-Z a-z 0-9 - _ . ~
    def rawurlencode(value)
      value.to_s.b.gsub(/[^A-Za-z0-9\-_.~]/n) { |c| format('%%%02X', c.ord) }
    end

    JSON_SHORT = {
      '"' => '\\"', '\\' => '\\\\', '/' => '\\/',
      "\b" => '\\b', "\f" => '\\f', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t'
    }.freeze

    # json_encode() with the flags the reference uses:
    #   unescaped_unicode  JSON_UNESCAPED_UNICODE (U+2028/U+2029 stay escaped,
    #                      as in PHP without JSON_UNESCAPED_LINE_TERMINATORS)
    #   unescaped_slashes  JSON_UNESCAPED_SLASHES
    # Invalid UTF-8 is replaced by U+FFFD (JSON_INVALID_UTF8_SUBSTITUTE).
    def json_encode(value, unescaped_unicode: true, unescaped_slashes: false)
      out = +''
      encode_value(value, out, unescaped_unicode, unescaped_slashes)
      out
    end

    def encode_value(value, out, uni, slashes)
      case value
      when nil then out << 'null'
      when true then out << 'true'
      when false then out << 'false'
      when Integer then out << value.to_s
      when Float then out << json_float(value)
      when String then encode_string(value, out, uni, slashes)
      when Symbol then encode_string(value.to_s, out, uni, slashes)
      when Array
        out << '['
        value.each_with_index do |v, i|
          out << ',' if i.positive?
          encode_value(v, out, uni, slashes)
        end
        out << ']'
      when Hash
        out << '{'
        value.each_with_index do |(k, v), i|
          out << ',' if i.positive?
          encode_string(k.to_s, out, uni, slashes)
          out << ':'
          encode_value(v, out, uni, slashes)
        end
        out << '}'
      else
        encode_string(value.to_s, out, uni, slashes)
      end
    end

    def encode_string(value, out, uni, slashes)
      s = value.dup.force_encoding(Encoding::UTF_8)
      s = s.scrub("\u{FFFD}") unless s.valid_encoding?
      pattern =
        if uni
          slashes ? /["\\\x00-\x1F\u2028\u2029]/ : %r{["\\/\x00-\x1F\u2028\u2029]}
        else
          slashes ? /["\\\x00-\x1F[^\x00-\x7F]]/ : %r{["\\/\x00-\x1F[^\x00-\x7F]]}
        end
      out << '"'
      out << s.gsub(pattern) { |c| JSON_SHORT[c] || unicode_escape(c.ord) }
      out << '"'
    end

    def unicode_escape(cp)
      return format('\\u%04x', cp) if cp < 0x10000
      cp -= 0x10000
      format('\\u%04x\\u%04x', 0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF))
    end

    # A float as PHP's json_encode() writes it (serialize_precision = -1).
    def json_float(value)
      return '0' unless value.finite?
      neg = value.negative? || (value.zero? && (1.0 / value).negative?)
      digits, decpt = shortest_digits(value.abs)
      body =
        if digits == '0'
          '0.0'
        elsif decpt < -3 || decpt > 17
          exp = decpt - 1
          mant = digits[0] + '.' + (digits.length > 1 ? digits[1..] : '0')
          mant + 'e' + (exp.negative? ? '-' : '+') + exp.abs.to_s
        elsif decpt <= 0
          '0.' + ('0' * -decpt) + digits
        elsif decpt >= digits.length
          digits + ('0' * (decpt - digits.length)) + '.0'
        else
          digits[0, decpt] + '.' + digits[decpt..]
        end
      (neg ? '-' : '') + body
    end

    # Shortest round-trip digits of a non-negative float and the position of
    # the decimal point (as dtoa mode 0 returns them).
    def shortest_digits(value)
      return ['0', 1] if value.zero?
      s = value.to_s
      if (m = s.match(/\A(\d)(?:\.(\d+))?e([+-]\d+)\z/))
        digits = (m[1] + (m[2] || '')).sub(/0+\z/, '')
        return [digits.empty? ? '0' : digits, m[3].to_i + 1]
      end
      int, frac = s.split('.', 2)
      frac ||= ''
      all = int + frac
      decpt = int.length
      stripped = all.sub(/\A0+/, '')
      decpt -= all.length - stripped.length
      stripped = stripped.sub(/0+\z/, '')
      [stripped.empty? ? '0' : stripped, decpt]
    end
  end
end
