# frozen_string_literal: true

module RcNode
  # "YYYY-MM-DD HH:MM:SS  <text>" to stdout and, if configured, appended to
  # log_file. Never pass the secret or the model key in here.
  class Logger
    def initialize(log_file: '', timezone: '', out: $stdout)
      @log_file = log_file.to_s
      @out = out
      @mutex = Mutex.new
      apply_timezone(timezone.to_s)
    end

    def log(text)
      line = "#{Time.now.strftime('%Y-%m-%d %H:%M:%S')}  #{text}\n"
      write(line, to_file: true)
    end

    # Plain output (the --one job dump); stdout only.
    def print(text)
      write(text, to_file: false)
    end

    private

    def write(text, to_file:)
      @mutex.synchronize do
        begin
          @out.write(text)
          @out.flush
        rescue IOError, SystemCallError
          nil
        end
        if to_file && !@log_file.empty?
          begin
            File.open(@log_file, 'ab') { |f| f.write(text) }
          rescue IOError, SystemCallError
            nil # like @file_put_contents in the reference: logging never stops the node
          end
        end
      end
    end

    # IANA zone for the timestamps. Unknown names are reported once and the
    # system zone is kept (glibc would silently fall back to UTC).
    def apply_timezone(zone)
      return if zone.empty?

      dirs = [ENV['TZDIR'], '/usr/share/zoneinfo', '/usr/lib/zoneinfo', '/usr/share/lib/zoneinfo'].compact
      known = dirs.any? { |d| File.file?(File.join(d, zone)) }
      have_db = dirs.any? { |d| File.directory?(d) }
      if known || !have_db
        ENV['TZ'] = zone
      else
        warn "rc-node: unknown timezone '#{zone}', using the system time zone"
      end
    end
  end
end
