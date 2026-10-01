# frozen_string_literal: true

require_relative 'lib/rc_node/version'

Gem::Specification.new do |spec|
  spec.name          = 'rc-node'
  spec.version       = RcNode::VERSION
  spec.summary       = 'reactive.chat AI node: answer your workspace\'s AI jobs with your own model'
  spec.description   = 'Fetches the AI jobs of your reactive.chat workspace (outbound HTTPS long-poll, ' \
                       'HMAC-signed), lets your own OpenAI-compatible model server (vLLM, Ollama, ' \
                       'LM Studio, llama.cpp, Azure OpenAI) answer them and delivers the results. ' \
                       'No inbound port. Standard library only.'
  spec.authors       = ['Lukas Wójcik (LW IT Solutions)']
  spec.homepage      = 'https://reactive.chat'
  spec.license       = 'MIT'
  spec.required_ruby_version = '>= 3.0'

  spec.files         = Dir['lib/**/*.rb'] + Dir['bin/*'] + ['README.md', 'rc-node.gemspec']
  spec.bindir        = 'bin'
  spec.executables   = ['rc-node']
  spec.require_paths = ['lib']
  spec.metadata      = { 'rubygems_mfa_required' => 'true' }
  # No runtime dependencies (json, net/http, openssl are part of Ruby).
end
