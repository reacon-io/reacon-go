import { existsSync } from 'node:fs';
const { acquireFixtureProxy } = await import(existsSync(new URL('../fixed-origin/proxy.mjs', import.meta.url)) ? '../fixed-origin/proxy.mjs' : './fixed-origin/proxy.mjs');
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
      const scenario = byId.get(caseId); assert.ok(scenario, 'Unknown recording case');
      const offset=observations.get(language).filter(value=>value.caseId===caseId).length-1;
      const item=scenario.sequence?scenario.sequence[offset]:scenario;
      assert.ok(item,'Unexpected extra page request');
      seen.recordCaseId=item.id;
      const record = item.record;
      // Compare parameter values without treating equivalent percent encodings
      // as different routes. Split first so encoded slashes cannot add segments.
      assert.deepEqual(seen.path.split('/').map(decodeURIComponent), record.request.path.split('/').map(decodeURIComponent), 'SDK path differs from recorded request');
      assert.equal(request.method, record.request.method, 'SDK HTTP method');
      assert.equal(request.headers['x-api-key'], record.request.authentication === 'none' ? undefined : `recording-${language}`, 'SDK authentication');
      assert.equal(request.headers.cookie, undefined, 'Unexpected ambient cookie');
      if(record.request.accept)assert.equal(request.headers.accept,record.request.accept,'SDK streaming negotiation');
      assert.deepEqual([...url.searchParams].sort(), Object.entries(record.request.query).map(([k,v])=>[k,String(v)]).sort(), 'SDK query serialization');
      let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 2*1024*1024); }
      assert.deepEqual(canonicalRequest(body ? JSON.parse(body) : undefined, item.requestEquivalence), canonicalRequest(record.request.body, item.requestEquivalence), 'SDK request body serialization');
      response.writeHead(record.response.status, record.response.headers);
      response.end(record.response.status===204 ? undefined : typeof record.response.body === 'string' ? record.response.body : JSON.stringify(record.response.body));
      seen.passed = true;
    } catch (error) {
      seen.passed = false; seen.error = error.message;
      if (process.env.REACON_REPLAY_DIAGNOSTICS === '1') console.error(JSON.stringify({kind:'sdk-replay-mismatch',language,...seen}));
      response.writeHead(599, { 'content-type': 'application/json' }); response.end(JSON.stringify({error:'Replay request mismatch'}));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const releaseProxy = await acquireFixtureProxy();
  return {
    url: `http://127.0.0.1:${server.address().port}`, observations,
    assertComplete(language) {
      const values = observations.get(language) ?? [];
      assert.equal(values.length, cases.reduce((count,item)=>count+(item.sequence?.length??1),0), 'Expected exactly one SDK request per recorded page');
      assert.equal(new Set(values.map(v=>v.caseId)).size,cases.length,'Duplicate/missing recording requests');
      for(const item of cases)assert.deepEqual(values.filter(value=>value.caseId===item.id).map(value=>value.recordCaseId),
        (item.sequence??[item]).map(page=>page.id),'Recorded page order differs');
      assert.ok(values.every(v=>v.passed), JSON.stringify(values.filter(v=>!v.passed)));
    },
    async close() { await releaseProxy(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); },
  };
}
