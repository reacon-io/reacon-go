import http from 'node:http';
import { canonicalRequest } from './request-equivalence.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
export async function startRecordingServer(cases) {
  const byId = new Map(cases.map(item => [item.id, item]));
  const observations = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const [, language, caseId, ...path] = url.pathname.split('/');
    if (!observations.has(language)) observations.set(language, []);
    const seen = { caseId, method: request.method, path: '/'+path.join('/') };
    observations.get(language).push(seen);
    try {
      const item = byId.get(caseId); assert.ok(item, 'Unknown recording case');
      const record = item.record;
      assert.equal(seen.path, record.request.path, 'SDK path differs from recorded request');
      assert.equal(request.method, record.request.method, 'SDK HTTP method');
      assert.equal(request.headers['x-api-key'], record.request.authentication === 'none' ? undefined : `recording-${language}`, 'SDK authentication');
      assert.equal(request.headers.cookie, undefined, 'Unexpected ambient cookie');
      assert.deepEqual([...url.searchParams].sort(), Object.entries(record.request.query).map(([k,v])=>[k,String(v)]).sort(), 'SDK query serialization');
      let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 2*1024*1024); }
      assert.deepEqual(canonicalRequest(body ? JSON.parse(body) : undefined, item.requestEquivalence), canonicalRequest(record.request.body, item.requestEquivalence), 'SDK request body serialization');
      response.writeHead(record.response.status, record.response.headers);
      response.end(typeof record.response.body === 'string' ? record.response.body : JSON.stringify(record.response.body));
      seen.passed = true;
    } catch (error) {
      seen.passed = false; seen.error = error.message;
      if (process.env.REACON_REPLAY_DIAGNOSTICS === '1') console.error(JSON.stringify({kind:'sdk-replay-mismatch',language,...seen}));
      response.writeHead(599, { 'content-type': 'application/json' }); response.end(JSON.stringify({error:'Replay request mismatch'}));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`, observations,
    assertComplete(language) {
      const values = observations.get(language) ?? [];
      assert.equal(values.length, cases.length, 'Expected exactly one SDK request per recording');
      assert.equal(new Set(values.map(v=>v.caseId)).size,cases.length,'Duplicate/missing recording requests');
      assert.ok(values.every(v=>v.passed), JSON.stringify(values.filter(v=>!v.passed)));
    },
    async close() { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); },
  };
}
