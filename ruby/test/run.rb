# frozen_string_literal: true

# Runs every unit test: ruby test/run.rb
Dir[File.join(__dir__, 'test_*.rb')].sort.each { |f| require f }
