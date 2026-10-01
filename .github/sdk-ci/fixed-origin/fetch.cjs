const assert = require('node:assert/strict');
// Test transport only. The SDK must emit its fixed service URL before this
// injected Fetch implementation forwards the request to an isolated fixture.
function fixtureFetch(base, transport = fetch) {
  const target = new URL(base);
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.protocol, 'http:');
  return (input, init) => {
    const original = new URL(input);
    assert.equal(original.origin, 'https://api.reacon.io', 'SDK changed its fixed API origin');
    const mapped = new URL(target);
    mapped.pathname = target.pathname.replace(/\/$/, '') + original.pathname;
    mapped.search = original.search;
    return transport(mapped.toString(), init);
  };
}
exports.fixtureFetch = fixtureFetch;
