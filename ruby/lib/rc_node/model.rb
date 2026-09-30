# frozen_string_literal: true

require_relative 'php'

module RcNode
  # The OpenAI-compatible side: request bodies and how answers are read.
  # Reason strings (the "grund" sent to reactive.chat) stay German, exactly
  # as in the reference - the server and dashboards know them.
  module Model
    module_function

    ModelResult = Struct.new(:text, :ms, :error)

    # modellHandle() body. Without images the user content stays a plain
    # string; with images it becomes the OpenAI content list.
    def chat_body(model:, temperature:, default_max_tokens:, system:, prompt:, max_tokens:, images: [], stream: false)
      content = prompt.to_s
      unless images.nil? || images.empty?
        content = [{ 'type' => 'text', 'text' => prompt.to_s }]
        images.each { |url| content << { 'type' => 'image_url', 'image_url' => { 'url' => url.to_s } } }
      end
      Php.json_encode({
                        'model' => model,
                        'stream' => stream,
                        'temperature' => Php.float(temperature),
                        'max_tokens' => max_tokens.positive? ? max_tokens : Php.int(default_max_tokens),
                        'messages' => [
                          { 'role' => 'system', 'content' => system.to_s },
                          { 'role' => 'user', 'content' => content }
                        ]
                      })
    end

    ENGLISH = [
      ['Modell nicht erreichbar: ', 'Model not reachable: '],
      ['Modell HTTP ', 'Model answered HTTP '],
      ['Modell-Strom: ', 'Model stream error: '],
      ['Antwort ohne Text', 'Answer without text'],
      ['Strom ohne Abschluss', 'Stream ended without completion'],
      ['Einbettungsserver nicht erreichbar: ', 'Embedding server not reachable: '],
      ['Einbettung HTTP ', 'Embedding server answered HTTP '],
      ['Einbettung unlesbar', 'Embedding answer unreadable'],
      ['Vektor leer oder ungleich lang', 'Vector empty or of unequal length']
    ].freeze

    # An English rendering of a reason string, for the --probe report only
    # (reasons sent to reactive.chat stay German).
    def english(reason)
      ENGLISH.each { |de, en| return en + reason.delete_prefix(de) if reason.start_with?(de) }
      reason.sub(/\A(\d+) Vektoren fuer (\d+) Texte\z/, '\1 vectors for \2 texts')
    end

    # einbettenHandle() body.
    def embed_body(embed_model, texts)
      Php.json_encode({ 'model' => embed_model, 'input' => texts.to_a })
    end

    # modellLesen(): +stream+ is the StreamState of a streamed call or nil.
    def read(code, raw, error, ms, stream = nil)
      return ModelResult.new(nil, ms, "Modell nicht erreichbar: #{error}") unless error.to_s.empty?
      if code != 200
        return ModelResult.new(nil, ms, "Modell HTTP #{code}: #{Php.mb_substr(raw, 160)}")
      end

      if stream&.sse?
        err = stream.error
        return ModelResult.new(nil, ms, "Modell-Strom: #{Php.mb_substr(err, 160)}") unless err.empty?
        return ModelResult.new(nil, ms, 'Antwort ohne Text') unless stream.has_content?
        return ModelResult.new(nil, ms, 'Strom ohne Abschluss') unless stream.ended?

        return ModelResult.new(stream.text, ms, '')
      end

      value = Php.json_decode(raw)
      ['choices', 0, 'message', 'content'].each do |step|
        return ModelResult.new(nil, ms, 'Antwort ohne Text') unless value.is_a?(Hash) || value.is_a?(Array)

        value = Php.get(value, step)
        return ModelResult.new(nil, ms, 'Antwort ohne Text') if value.nil?
      end
      ModelResult.new(Php.str(value), ms, '')
    end

    FLT_MAX = 3.4028234663852886e38
    # FLT_MAX + half an ulp: from here on a C (float) cast gives infinity.
    FLT_OVERFLOW = 3.4028235677973366e38

    # A double as C's (float) cast rounds it (PHP pack('g')). Ruby's pack
    # turns everything above FLT_MAX into infinity instead of rounding.
    def float32(value)
      return value unless value.finite? && value.abs > FLT_MAX && value.abs < FLT_OVERFLOW

      value.negative? ? -FLT_MAX : FLT_MAX
    end

    # einbettenLesen(): the payload reactive.chat expects,
    # {"vektoren":["<base64 float32 LE>",...],"dims":N,"modell":"..."},
    # sorted by "index". Returns [payload_or_nil, error].
    def embed_result(code, raw, error, count, embed_model)
      return [nil, "Einbettungsserver nicht erreichbar: #{error}"] unless error.to_s.empty?
      return [nil, "Einbettung HTTP #{code}: #{Php.mb_substr(raw, 160)}"] if code != 200

      json = Php.json_decode(raw)
      data = json.is_a?(Hash) ? Php.values(json['data']) : nil
      return [nil, 'Einbettung unlesbar'] if data.nil?

      sorted = data.each_with_index.sort_by { |e, i| [Php.int(Php.get(e, 'index')), i] }.map(&:first)
      vectors = []
      dims = 0
      sorted.each do |entry|
        embedding = Php.get(entry, 'embedding') if entry.is_a?(Hash)
        values = Php.to_list(embedding)
        return [nil, 'Vektor leer oder ungleich lang'] if values.empty? || (dims.positive? && values.size != dims)

        dims = values.size
        vectors << [values.map { |w| float32(Php.float(w)) }.pack('e*')].pack('m0')
      end
      return [nil, "#{vectors.size} Vektoren fuer #{count} Texte"] if vectors.size != count

      [Php.json_encode({ 'vektoren' => vectors, 'dims' => dims, 'modell' => embed_model.to_s },
                       unescaped_unicode: false, unescaped_slashes: true), '']
    end
  end
end
