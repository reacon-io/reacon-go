import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const updatedAt = '2026-09-27T10:00:00.000Z';
const stage = { stage: 'DNS', updatedAt, label: 'hé🚀' };
const final = { result: { status: 'future-status', catchAll: false, disposable: false, acceptsAll: null }, updatedAt };
export const streamScenarios = ['success', 'error', 'pre402', 'pre429', 'proxy', 'redirect', 'wrongtype', 'malformed', 'invalidresult', 'eof', 'disconnect', 'idle', 'total', 'headers', 'cancel', 'early', 'isolated'];
const heldOpen = ['success', 'error', 'malformed', 'invalidresult', 'idle', 'total', 'headers', 'cancel', 'early', 'isolated'];

// Fault-injection transport fixtures. Never label these as actual API recordings.
export async function startStreamServer() {
  const observations = new Map();
  const failures = [];
  const liveClosureChecks = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const [, language, ...parts] = url.pathname.split('/');
    // The consumer must prove closure while its SDK and process are still alive.
    // Process exit or closing the entire connection pool cannot satisfy this.
    if (parts.join('/') === '_assert_closed') {
      const deadline = Date.now() + 1500;
      while (heldOpen.some(scenario => !observations.get(language)?.[scenario]?.closed) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      const closed = heldOpen.every(scenario => observations.get(language)?.[scenario]?.closed);
      if (closed) liveClosureChecks.add(language);
      response.writeHead(closed ? 200 : 409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ closed })); return;
    }
    const scenario = url.searchParams.get('email')?.split('@')[0];
    const records = observations.get(language) ?? {};
    observations.set(language, records);
    const record = records[scenario] ?? { requests: 0, closed: false };
    records[scenario] = record; record.requests++;
    let interval;
    response.on('close', () => { record.closed = true; clearInterval(interval); });
    try {
      assert.equal(parts.join('/'), 'v1/verify');
      assert.ok(streamScenarios.includes(scenario));
      assert.equal(request.headers['x-api-key'], `${scenario === 'isolated' ? 'isolated' : 'synthetic'}-${language}`);
      assert.equal(request.headers.accept, 'text/event-stream');
      assert.equal(request.headers['last-event-id'], undefined, 'No implicit resume');
      assert.equal(url.searchParams.get('onlyIfFree'), 'true');
      if (scenario === 'pre402' || scenario === 'pre429') {
        const status = Number(scenario.slice(3));
        response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req-stream', 'retry-after': '0' });
        response.end(JSON.stringify({ error: 'synthetic', code: 'FIXTURE_ERROR', remainingCredits: 0 })); return;
      }
      if (scenario === 'proxy') { response.writeHead(502, { 'content-type': 'text/html' }); response.end('<html>proxy failure</html>'); return; }
      if (scenario === 'redirect') { response.writeHead(307, { location: `${url.pathname}?email=redirected@example.test` }); response.end(); return; }
      if (scenario === 'wrongtype') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
      if (scenario === 'headers') return;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'req-stream' });
      response.flushHeaders();
      const write = data => response.write(`data: ${JSON.stringify(data)}\n\n`);
      if (scenario === 'idle') return;
      if (scenario === 'total') { interval = setInterval(() => response.write(': keepalive\n\n'), 15); return; }
      if (scenario === 'error') { write({ error: 'Synthetic credit error', code: 'INSUFFICIENT_CREDITS', remainingCredits: 0, updatedAt }); return; }
      if (scenario === 'malformed') { response.write('data: {broken\n\n'); return; }
      if (scenario === 'invalidresult') { write({ result: { status: 'bad' }, updatedAt }); return; }
      if (['early', 'cancel', 'eof', 'disconnect'].includes(scenario)) {
        write(stage);
        if (scenario === 'eof') response.end();
        if (scenario === 'disconnect') setTimeout(() => response.destroy(), 25);
        return;
      }
      const frames = ': comment\r\nretry: 1\r\nid: transient\r\n' +
        `data: {"stage":"DNS",\r\ndata: "updatedAt":"${updatedAt}","label":"hé🚀"}\r\n\r\n` +
        'event: future-event\r\ndata: {"future":{"value":"hé🚀"}}\r\n\r\n' +
        `data: ${JSON.stringify({ state: 'queued', requestId: 'work-fixture', updatedAt })}\r\n\r\n` +
        `data: ${JSON.stringify(final)}\r\n\r\n`;
      const bytes = Buffer.from(frames);
      // One-byte writes deliberately split UTF-8 and CRLF boundaries.
      for (let offset = 0; offset < bytes.length && !response.destroyed; offset++) {
        response.write(bytes.subarray(offset, offset + 1));
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      // Keep terminal streams open: clients must terminate on the event itself.
    } catch (error) {
      failures.push({ language, scenario, message: error.message });
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture_assertion_failed' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, observations,
    async assertComplete(language) {
      const deadline = Date.now() + 2000;
      while (heldOpen.some(scenario => !observations.get(language)?.[scenario]?.closed) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(failures.filter(failure => failure.language === language), []);
      assert.ok(liveClosureChecks.has(language), 'Consumer must verify closure before closing its SDK or exiting');
      const records = observations.get(language);
      assert.deepEqual(Object.keys(records ?? {}).sort(), [...streamScenarios].sort());
      for (const scenario of streamScenarios) {
        assert.equal(records[scenario].requests, 1, `${scenario}: no retry or reconnect`);
        assert.equal(records[scenario].closed, true, `${scenario}: response connection closed`);
      }
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
