# frozen_string_literal: true

require_relative 'php'

module RcNode
  # State of one streamed (SSE) model call; a new one for every attempt.
  # Fed from the HTTP thread, read by the main loop - hence the mutex.
  class StreamState
    RAW_CAP = 4 * 1024 * 1024

    def initialize
      @mutex = Mutex.new
      @raw = String.new(encoding: Encoding::BINARY)
      @buffer = String.new(encoding: Encoding::BINARY)
      @text = String.new(encoding: Encoding::UTF_8)
      @sse = false
      @has_content = false
      @ended = false
      @error = ''
    end

    def raw = @mutex.synchronize { @raw.dup }
    def text = @mutex.synchronize { @text.dup }
    def sse? = @mutex.synchronize { @sse }
    def has_content? = @mutex.synchronize { @has_content }
    def ended? = @mutex.synchronize { @ended }
    def error = @mutex.synchronize { @error.dup }

    # stromFuettern(): bytes from the model. A line may span two chunks, so
    # buffer up to the line end. The raw bytes are kept (capped) so that a
    # non-SSE answer can still be read like a normal response.
    def feed(data)
      @mutex.synchronize do
        d = data.b
        @raw << d if @raw.bytesize < RAW_CAP
        @buffer << d
        while (pos = @buffer.index("\n"))
          handle_line(@buffer.byteslice(0, pos).sub(/\r+\z/n, ''))
          @buffer = @buffer.byteslice(pos + 1, @buffer.bytesize - pos - 1)
        end
      end
    end

    # stromSchluss(): whatever is left after the last line end.
    def finish
      @mutex.synchronize do
        unless @buffer.empty?
          handle_line(@buffer.sub(/\r+\z/n, ''))
          @buffer = String.new(encoding: Encoding::BINARY)
        end
      end
    end

    private

    # stromZeile(): only "data: {...}" and "data: [DONE]" count.
    def handle_line(line)
      return unless line.start_with?('data:')

      @sse = true
      payload = Php.trim(line.byteslice(5, line.bytesize - 5))
      if payload == '[DONE]'
        @ended = true
        return
      end
      json = Php.json_decode(payload)
      return unless json.is_a?(Hash) || json.is_a?(Array)

      # vLLM reports an error mid-stream as an event of its own.
      if !Php.get(json, 'error').nil? || Php.get(json, 'object') == 'error'
        err = Php.get(json, 'error')
        err = json if err.nil?
        @error = if err.is_a?(Hash) || err.is_a?(Array)
                   msg = Php.get(err, 'message')
                   msg.nil? ? 'Fehler ohne Text' : Php.str(msg)
                 else
                   Php.str(err)
                 end
        return
      end
      choice = Php.get(Php.get(json, 'choices'), 0)
      return unless choice.is_a?(Hash) || choice.is_a?(Array)

      content = Php.get(Php.get(choice, 'delta'), 'content')
      if content.is_a?(String)
        @text << content
        @has_content = true
      end
      @ended = true if Php.truthy?(Php.get(choice, 'finish_reason'))
    end
  end
end
