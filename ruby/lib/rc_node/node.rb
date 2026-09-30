# frozen_string_literal: true

require_relative 'php'
require_relative 'text'
require_relative 'stream'
require_relative 'model'
require_relative 'http'
require_relative 'wire'
require_relative 'version'

module RcNode
  # The node: fetch jobs from reactive.chat, let the model answer, deliver.
  #
  # Concurrency: every HTTP call (long-poll, bring, teil, model, embedding)
  # runs in a thread of its own and reports back through an event queue.
  # Only the main loop touches the job table, so the bookkeeping is the one
  # of the reference (curl_multi) - one hol, one bring, one teil in flight,
  # up to +concurrency+ model calls in parallel.
  class Node
    HEARTBEAT_S = 45
    TEIL_MAX_ENTRIES = 8
    TEIL_MAX_BYTES = 16_000
    RETRY_SUFFIX = "\n\nWICHTIG: Dein vorheriger Versuch enthielt eine Zahl, " \
                   'die nicht in den Quellen steht. Uebernimm Zahlen genau so, ' \
                   'wie sie dort stehen, oder lass sie weg.'
    PROBE_SYSTEM = 'Antworte mit genau einem Wort.'
    PROBE_PROMPT = 'Sag: Bereit'

    Event = Struct.new(:kind, :id, :response, :stream, :ms)
    Job = Struct.new(:id, :art, :system, :prompt, :facts, :max_tokens, :texts, :images,
                     :attempt, :ms, :stream, :state, :part_n, :part_t, :part_text, :part_more,
                     keyword_init: true)

    # A tiny event queue whose wait can time out (Ruby 3.0 compatible).
    class Events
      def initialize
        @mutex = Mutex.new
        @cond = ConditionVariable.new
        @items = []
      end

      def push(event)
        @mutex.synchronize do
          @items << event
          @cond.signal
        end
      end

      def drain
        @mutex.synchronize do
          items = @items
          @items = []
          items
        end
      end

      def wait(seconds)
        @mutex.synchronize { @cond.wait(@mutex, seconds) if @items.empty? }
      end
    end

    attr_reader :running

    def initialize(config, logger, one: false)
      @c = config
      @log = logger
      @one = one
      @running = true
      # true once reactive.chat rejects 'teil' with 400/404: no streaming
      # until the process restarts.
      @stream_off = false
      @rc_http = HttpClient.new(resolve: config.resolve, tls_verify: config.tls_verify)
      @model_http = HttpClient.new
      @rc = Wire::Client.new(config, @rc_http)
    end

    # Called from a signal handler: stop fetching, finish, deliver.
    def stop(signal_name)
      @running = false
      Thread.new { @log.log("SIG#{signal_name} - stopping after the running jobs.") }
    end

    def kinds_csv = @c.kinds.join(',')
    def caps_csv = @c.capabilities.join(',')

    # ---------------------------------------------------------------- probe
    def probe
      @log.log("Probe, #{USER_AGENT}.")
      @log.log("  reactive.chat: #{@c.base_url}")
      a = @rc.call('hol', nil,
                   "&n=0&warte=0&arten=#{Php.rawurlencode(kinds_csv)}&kann=#{Php.rawurlencode(caps_csv)}", 20)
      if a.code == 200 && a.data
        open_jobs = Php.int(Php.get(a.data, 'offen'))
        @log.log("    HTTP 200 - signed in, #{open_jobs} job(s) waiting.")
      elsif a.code == 401
        @log.log('    HTTP 401 - rejected. Are node id and secret correct? Is the clock right (NTP)? ' \
                 'Has the node been revoked in the customer area?')
      else
        detail = a.error.empty? ? "HTTP #{a.code} #{Php.mb_substr(a.raw, 200)}" : a.error
        @log.log("    No connection: #{detail}")
      end

      @log.log("  Model: #{@c.model_url} (#{@c.model})")
      m = ask_model(PROBE_SYSTEM, PROBE_PROMPT)
      @log.log(m.text.nil? ? "    #{Model.english(m.error)}" :"    Answer in #{m.ms} ms: #{Text.clean(m.text)}")

      unless @c.embed_url.empty?
        @log.log("  Embedding: #{@c.embed_url} (#{@c.embed_model})")
        t0 = now
        r = embed_call(['Bereit'], @c.embed_timeout)
        payload, err = Model.embed_result(r.code, r.body, r.error, 1, @c.embed_model)
        if payload.nil?
          @log.log("    #{Model.english(err)}")
        else
          dims = Php.get(Php.json_decode(payload), 'dims')
          @log.log("    #{Php.int(dims)} dimensions in #{elapsed_ms(t0)} ms")
        end
      end

      images = @c.images ? "yes (at most #{@c.images_max})" : 'no'
      @log.log("  Node: #{@c.node_id}, takes: #{@c.kinds.join(', ')}, can: #{@c.capabilities.join(', ')}, " \
               "images: #{images}")
      a.code == 200 && !m.text.nil? ? 0 : 1
    end

    # ------------------------------------------------------------- daemon
    def daemon
      @log.log("Running as daemon. Node #{@c.node_id}, model #{@c.model} at #{@c.model_url}, " \
               "long-poll #{@c.poll_wait} s, up to #{[1, @c.concurrency].max} in parallel, " \
               "takes: #{@c.kinds.join(', ')}.")
      run_loop(false)
      @log.log('Stopped.')
      0
    end

    # One cycle (--once / --one): exit code 1 when nothing was done because
    # of a connection problem, else 0.
    def once
      run_loop(true).negative? ? 1 : 0
    end

    # ----------------------------------------------------------- the loop
    # schleife(): returns the number of finished jobs, or -1 (once mode:
    # model not ready, or a connection error and nothing done).
    def run_loop(once_mode)
      slots = @one ? 1 : [1, @c.concurrency].max
      wait_s = @c.poll_wait.clamp(0, 60)
      hol_timeout = wait_s + 20
      kinds_query = "#{Php.rawurlencode(kinds_csv)}&kann=#{Php.rawurlencode(caps_csv)}" \
                    "#{@c.images ? '&bilder=1' : ''}"
      stream_ms = [100, @c.stream_ms].max

      events = Events.new
      jobs = {} # id => Job, in fetch order
      finished = []
      in_bring = []
      inflight = 0
      hol_open = false
      bring_open = false
      teil_open = false
      fetched = false
      done = 0
      line_error = false
      failures = 0
      quiet_until = 0.0
      last_call = now
      model_waits = 0

      start = lambda do |kind, id, stream = nil, &blk|
        inflight += 1
        t0 = now
        Thread.new do
          response = begin
            blk.call
          rescue StandardError => e
            HttpClient::Response.new(0, String.new, "#{e.class}: #{e.message}")
          end
          events.push(Event.new(kind, id, response, stream, elapsed_ms(t0)))
        end
      end

      launch = lambda do |id|
        job = jobs[id]
        prompt = job.attempt == 1 ? job.prompt : job.prompt + RETRY_SUFFIX
        # Streaming only with 'strom' in the job AND in the config, and not
        # after reactive.chat rejected 'teil'. Every attempt starts empty.
        state = job.stream && @c.stream && !@stream_off ? StreamState.new : nil
        job.state = state
        job.part_text = ''
        body = Model.chat_body(model: @c.model, temperature: @c.temperature,
                               default_max_tokens: @c.max_tokens, system: job.system, prompt: prompt,
                               max_tokens: job.max_tokens, images: job.images, stream: !state.nil?)
        start.call(:model, id, state) do
          @model_http.request('POST', @c.model_url, headers: @c.model_headers, body: body,
                                                    timeout: @c.timeout, connect_timeout: 10,
                                                    on_data: state ? ->(chunk) { state.feed(chunk) } : nil)
        end
      end

      finish = lambda do |id, sentence, reason|
        job = jobs.delete(id)
        done += 1
        line = "  ##{id}"
        line += if sentence.empty?
                  " discarded: #{reason}"
                elsif job.art == 'einbettung'
                  " #{job.ms} ms: #{job.texts.size} text(s) embedded"
                else
                  " #{job.ms} ms: #{Php.mb_substr(sentence, 100)}"
                end
        line += "  parts #{job.part_n}#{job.part_more ? '' : ' (stopped)'}" if job.stream
        line += "  [#{jobs.size}/#{slots}]"
        @log.log(line)
        # Failures are delivered too: someone is waiting in the chat.
        finished << { 'id' => id, 'text' => sentence, 'grund' => sentence.empty? ? reason : '',
                      'modell' => @c.model, 'ms' => job.ms, 'knoten' => @c.node_id }
      end

      loop do
        free = slots - jobs.size
        idle = !hol_open && !bring_open && jobs.empty? && !teil_open
        fetch_allowed = @running && !(once_mode && fetched) && now >= quiet_until

        break if idle && finished.empty? && (!@running || (once_mode && fetched))

        # Is the model there? Otherwise the node would take jobs it cannot do.
        if idle && finished.empty? && fetch_allowed
          unless model_ready?
            @log.log('Model server not reachable, waiting.') if (model_waits % 6).zero?
            model_waits += 1
            return -1 if once_mode

            10.times do
              break unless @running

              sleep 1
            end
            next
          end
          if model_waits.positive?
            @log.log('Model server is back.')
            model_waits = 0
          end
        end

        if fetch_allowed && !hol_open && free.positive?
          extra = "&n=#{[free, slots].min}&warte=#{wait_s}&arten=#{kinds_query}"
          start.call(:hol, 0) { @rc.call('hol', nil, extra, hol_timeout) }
          hol_open = true
          fetched = true
          last_call = now
        elsif @running && !hol_open && free <= 0 && now - last_call >= HEARTBEAT_S
          # 'kann' in the heartbeat too, or a pure embedder would lose its kind.
          extra = "&n=0&warte=0&kann=#{Php.rawurlencode(caps_csv)}"
          start.call(:heartbeat, 0) { @rc.call('hol', nil, extra, 20) }
          hol_open = true
          last_call = now
        end

        if !bring_open && !finished.empty?
          body = Php.json_encode({ 'ergebnisse' => finished })
          start.call(:bring, 0) { @rc.call('bring', body) }
          in_bring = finished
          finished = []
          bring_open = true
        end

        batch = events.drain
        batch.each do |ev|
          inflight -= 1
          res = ev.response
          case ev.kind
          when :heartbeat
            hol_open = false
          when :hol
            hol_open = false
            a = res
            jobs_list = a.data.nil? ? nil : Php.get(a.data, 'auftraege')
            if a.code != 200 || jobs_list.nil?
              detail = a.error.empty? ? Php.mb_substr(a.raw, 160) : a.error
              @log.log("Fetching jobs failed: HTTP #{a.code} #{detail}")
              line_error = true
              failures += 1
              quiet_until = now + [300, 5 * failures].min
              next
            end
            failures = 0
            fresh = 0
            Php.to_list(jobs_list).each do |raw|
              next unless raw.is_a?(Hash)

              id = Php.int(raw['id'])
              next if id <= 0 || jobs.key?(id)

              job = Job.new(
                id: id,
                art: raw['art'].nil? ? 'chat' : Php.str(raw['art']),
                system: Php.str(raw['system']),
                prompt: Php.str(raw['prompt']),
                facts: Php.str(raw['fakten']),
                max_tokens: Php.int(raw['max_tokens']),
                texts: Php.to_list(raw['texte']).map { |x| Php.str(x) },
                images: Text.images_from_job(raw['bilder'], @c.images, @c.images_max),
                attempt: 1, ms: 0,
                stream: Php.truthy?(raw['strom']), state: nil,
                part_n: 0, part_t: 0.0, part_text: '', part_more: true
              )
              jobs[id] = job
              if job.art == 'einbettung'
                if @c.embed_url.empty? || job.texts.empty?
                  finish.call(id, '', @c.embed_url.empty? ? 'kein Einbettungsserver' : 'Einbettung ohne Texte')
                  next
                end
                texts = job.texts
                start.call(:embed, id) { embed_call(texts, @c.embed_timeout) }
                fresh += 1
                next
              end
              if job.prompt.empty?
                finish.call(id, '', 'Auftrag ohne Text')
                next
              end
              if @one
                imgs = job.images.empty? ? '' : "\n\nIMAGES: #{job.images.size}"
                @log.print("\n--- Job ##{id} (#{job.art}) ---\nSYSTEM:\n#{job.system}\n\n" \
                           "PROMPT:\n#{job.prompt}#{imgs}\n\n")
              end
              launch.call(id)
              fresh += 1
            end
            @log.log("#{fresh} job(s) fetched [#{jobs.size}/#{slots}].") if fresh.positive?
          when :teil
            teil_open = false
            a = res
            # 400/404: this server does not know 'teil' - streaming off until
            # restart. Anything else: never mind, the next part comes anyway.
            if a.code == 400 || a.code == 404
              @stream_off = true
              @log.log("Streaming off until restart: teil answered HTTP #{a.code} #{Php.mb_substr(a.raw, 120)}")
              next
            end
            parts = a.data.nil? ? nil : Php.get(a.data, 'teile')
            if a.code == 200 && (parts.is_a?(Array) || parts.is_a?(Hash))
              Php.values(parts).each do |e|
                next unless e.is_a?(Hash) || e.is_a?(Array)

                pid = Php.int(Php.get(e, 'id'))
                next unless jobs.key?(pid)
                # weiter:false - no more parts for this job.
                next unless e.is_a?(Hash) && e.key?('weiter') && !Php.truthy?(e['weiter'])

                jobs[pid].part_more = false
              end
            end
          when :bring
            bring_open = false
            b = res
            results = b.data.nil? ? nil : Php.get(b.data, 'ergebnisse')
            if b.code != 200 || results.nil?
              detail = b.error.empty? ? Php.mb_substr(b.raw, 160) : b.error
              @log.log("Delivery failed: HTTP #{b.code} #{detail}")
              line_error = true
              in_bring = []
              next
            end
            accepted = 0
            Php.to_list(results).each do |e|
              if Php.truthy?(Php.get(e, 'angenommen'))
                accepted += 1
              elsif Php.truthy?(Php.get(e, 'grund'))
                @log.log("  ##{Php.int(Php.get(e, 'id'))} rejected: #{Php.str(Php.get(e, 'grund'))}")
              end
            end
            @log.log("#{accepted} of #{in_bring.size} accepted.")
            in_bring = []
          when :embed
            job = jobs[ev.id]
            next unless job

            job.ms += ev.ms
            payload, err = Model.embed_result(res.code, res.body, res.error, job.texts.size, @c.embed_model)
            finish.call(ev.id, payload || '', err)
          when :model
            job = jobs[ev.id]
            next unless job

            raw = res.body
            if ev.stream
              ev.stream.finish
              raw = ev.stream.raw
            end
            m = Model.read(res.code, raw, res.error, ev.ms, ev.stream)
            job.ms += m.ms
            if m.text.nil?
              finish.call(ev.id, '', m.error)
              next
            end
            candidate = Text.clean(m.text)
            # KEINE_ANTWORT = "not in the sources": passed on unchanged.
            if candidate.b.downcase.include?('keine_antwort')
              finish.call(ev.id, 'KEINE_ANTWORT', '')
              next
            end
            bad = Text.check_numbers(candidate, job.facts)
            if bad.nil? && !candidate.empty?
              finish.call(ev.id, candidate, '')
              next
            end
            if job.attempt < 2
              job.attempt += 1
              launch.call(ev.id)
              next
            end
            finish.call(ev.id, '', candidate.empty? ? 'leer nach dem Saeubern' : "erfundene Zahl: #{bad}")
          end
        end

        # Completions are read first (as curl_multi_info_read does right after
        # the transfer), so a finished answer is not sent again as a part.
        # Parts while the model is still writing: one teil call at a time for
        # all jobs, at most 8 entries, per job at most every stream_ms, only
        # grown text cut at the last whitespace.
        if !teil_open && !@stream_off
          t = now
          entries = []
          jobs.each_value do |job|
            break if entries.size >= TEIL_MAX_ENTRIES
            next if job.state.nil? || !job.part_more || (t - job.part_t) * 1000 < stream_ms

            text = Text.stream_cut(job.state.text)
            next if text.bytesize <= job.part_text.bytesize

            if text.bytesize > TEIL_MAX_BYTES
              job.part_more = false
              next
            end
            job.part_n += 1
            job.part_t = t
            job.part_text = text
            entries << { 'id' => job.id, 'n' => job.part_n, 'text' => text }
          end
          unless entries.empty?
            body = Php.json_encode({ 'teile' => entries })
            start.call(:teil, 0) { @rc.call('teil', body, '', 10) }
            teil_open = true
          end
        end

        next unless batch.empty?

        if inflight.positive?
          # With a live stream wake up every 0.1 s so a due part does not wait.
          streaming = !@stream_off && jobs.each_value.any? { |j| j.state && j.part_more }
          events.wait(streaming ? 0.1 : 1.0)
        else
          sleep 0.2
        end
      end
      once_mode && line_error && done.zero? ? -1 : done
    end

    # ------------------------------------------------------------ helpers
    def ask_model(system, prompt)
      t0 = now
      body = Model.chat_body(model: @c.model, temperature: @c.temperature, default_max_tokens: @c.max_tokens,
                             system: system, prompt: prompt, max_tokens: 20)
      r = @model_http.request('POST', @c.model_url, headers: @c.model_headers, body: body,
                                                    timeout: @c.timeout, connect_timeout: 10)
      Model.read(r.code, r.body, r.error, elapsed_ms(t0))
    end

    def embed_call(texts, timeout)
      @model_http.request('POST', @c.embed_url, headers: { 'Content-Type' => 'application/json' },
                                                body: Model.embed_body(@c.embed_model, texts),
                                                timeout: timeout, connect_timeout: 5)
    end

    # modellBereit(): embedding server (if this process embeds), then
    # GET {endpoint}/models - unless only embedding or chat_url (Azure).
    def model_ready?
      if @c.kinds.include?('einbettung')
        r = embed_call(['Bereit'], 30)
        return false unless r.error.empty? && r.code == 200
      end
      return true if (@c.kinds - ['einbettung']).empty?
      return true unless @c.chat_url.empty?

      r = @model_http.request('GET', @c.models_url, headers: @c.model_headers, timeout: 5, connect_timeout: 3)
      r.error.empty? && r.code == 200
    end

    def now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def elapsed_ms(t0)
      ((now - t0) * 1000).round
    end
  end
end
