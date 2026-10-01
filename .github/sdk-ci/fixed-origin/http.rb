# Test-only proxy configuration; public SDK URLs remain fixed.
require 'uri'
require 'base64'
require 'tempfile'
def fixture_proxy(target)
  fixture = URI(target)
  raise 'Loopback fixtures only' unless %w[127.0.0.1 localhost].include?(fixture.hostname)
  proxy = URI(ENV.fetch('REACON_FIXTURE_PROXY_ENDPOINT'))
  proxy.userinfo = Base64.urlsafe_encode64(target, padding: false) + ':' + proxy.password
  proxy
end
def fixture_ca
  @fixture_ca ||= begin
    file = Tempfile.new('reacon-fixture-ca')
    file.write(ENV.fetch('REACON_FIXTURE_CA_PEM')); file.flush
    at_exit { file.close! }
    file
  end
  @fixture_ca.path
end
def route_configuration(config, target)
  config.proxy = fixture_proxy(target).to_s
  config.ssl_ca_file = fixture_ca if URI(target).scheme == 'http'
  config
end
