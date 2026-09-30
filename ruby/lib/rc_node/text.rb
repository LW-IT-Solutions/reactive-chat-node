# frozen_string_literal: true

require_relative 'php'

module RcNode
  # Text rules shared with the reference: clean-up of model output, the
  # number check, the stream cut and the image filter.
  #
  # Regex note: the PHP reference uses PCRE. A pattern WITH /u there is
  # Unicode-aware (\s, \d, \b, \R follow Unicode properties); a pattern
  # WITHOUT /u is byte/ASCII based. Byte-based steps therefore run on a
  # binary copy of the string here, Unicode steps use explicit properties.
  module Text
    module_function

    # PCRE (UCP) \s: Unicode separators (Z) plus \t \n \v \f \r.
    USPACE = '[\t\n\x0B\f\r\p{Z}]'
    THINK        = %r{<think>.*?</think>}m.freeze
    TAG          = /<[^>]*>/n.freeze
    LEAD_IN      = /\A[ \t\n\x0B\f\r]*(hier (ist|sind)[^:\n]*:|here (is|are)[^:\n]*:|antwort:|answer:)[ \t\n\x0B\f\r]*/ni.freeze
    QUOTED       = /\A["\u201C\u201E\u00AB](.*)["\u201D\u201C\u00BB]\z/m.freeze
    LINE_BREAK   = /#{USPACE}*\R#{USPACE}*/.freeze
    SPACE_RUN    = /#{USPACE}{2,}/.freeze

    # saeubern(): think blocks, tags, markdown and lead-ins removed, one line.
    def clean(text)
      t = Php.str(text).dup.force_encoding(Encoding::UTF_8)
      # preg_replace(/u) on invalid UTF-8 yields null in PHP -> ''.
      return '' unless t.valid_encoding?

      t = t.gsub(THINK, ' ')
      t = t.b.gsub(TAG, ' ')
      t = t.gsub('**', '').gsub('__', '').delete('`').delete('#')
      t = Php.trim(t)
      t = t.sub(LEAD_IN, '')
      t = Php.trim(t).force_encoding(Encoding::UTF_8)
      if (m = QUOTED.match(t))
        t = Php.trim(m[1])
      end
      t = t.gsub(LINE_BREAK, ' ')
      Php.trim(t.gsub(SPACE_RUN, ' '))
    end

    # PCRE (UCP) \w: letters, numbers, non-spacing marks, connector punctuation.
    THOUSANDS = /(\p{Nd})[ .,\u00A0\u202F\u2009](?=\p{Nd}{3}(?![\p{L}\p{N}\p{Mn}\p{Pc}]))/.freeze

    def digit_runs(value)
      s = Php.str(value).dup.force_encoding(Encoding::UTF_8)
      return [] unless s.valid_encoding?

      s.gsub(THOUSANDS, '\1').b.scan(/[0-9]+/n)
    end

    # zahlenPruefen(): the first digit run of +text+ that does not occur in
    # +facts+ (thousands separators ignored), or nil.
    def check_numbers(text, facts)
      allowed = {}
      digit_runs(facts).each { |d| allowed[d] = true }
      digit_runs(text).find { |d| !allowed[d] }&.force_encoding(Encoding::UTF_8)
    end

    # stromSchnitt(): the text up to and including the last whitespace, but
    # never cut at a space between two digits (or after a digit at the end).
    def stream_cut(text)
      b = text.b
      i = b.bytesize - 1
      while i >= 0
        c = b.getbyte(i)
        if c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09
          protected_space = c == 0x20 && i.positive? && digit?(b.getbyte(i - 1)) &&
                            (i + 1 == b.bytesize || digit?(b.getbyte(i + 1)))
          return text.byteslice(0, i + 1) unless protected_space
        end
        i -= 1
      end
      text.byteslice(0, 0)
    end

    def digit?(byte)
      byte && byte >= 0x30 && byte <= 0x39
    end

    IMAGE_MAX_BYTES = 4 * 1024 * 1024
    # PCRE "$" also matches before one final "\n".
    IMAGE_URL = %r{\Adata:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*\n?\z}n.freeze

    # bilderAusAuftrag(): the job's images, validated and capped. Always
    # empty unless images are enabled in the configuration.
    def images_from_job(raw, enabled, max)
      return [] unless Php.truthy?(enabled)

      list = Php.values(raw)
      return [] unless list

      limit = [0, Php.int(max)].max
      out = []
      list.each do |url|
        break if out.size >= limit
        next unless url.is_a?(String) && url.bytesize <= IMAGE_MAX_BYTES
        next unless IMAGE_URL.match?(url.b)

        out << url
      end
      out
    end
  end
end
