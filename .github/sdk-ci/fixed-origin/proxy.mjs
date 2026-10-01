// Test-only CONNECT proxy. Public SDK origins and retained package bytes stay intact.
import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, timingSafeEqual } from 'node:crypto';
const exec = promisify(execFile);
export async function startFixtureProxy() {
  const directory = await mkdtemp(join(tmpdir(), 'reacon-fixture-tls-'));
  const sockets = new Set(), token = randomBytes(24).toString('hex');
  let outer, inner;
  const agents = new Set();
  try {
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=Reacon fixture CA', '-keyout', join(directory, 'ca-key.pem'), '-out', join(directory, 'ca.pem')], { timeout: 10000 });
    await exec('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.reacon.io',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'leaf.csr')], { timeout: 10000 });
    await writeFile(join(directory, 'extensions.txt'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.reacon.io\n');
    await exec('openssl', ['x509', '-req', '-in', join(directory, 'leaf.csr'), '-CA', join(directory, 'ca.pem'),
      '-CAkey', join(directory, 'ca-key.pem'), '-CAcreateserial', '-days', '1', '-extfile', join(directory, 'extensions.txt'),
      '-out', join(directory, 'leaf.pem')], { timeout: 10000 });
    const ca = await readFile(join(directory, 'ca.pem'), 'utf8');
    const context = createSecureContext({ cert: await readFile(join(directory, 'leaf.pem')), key: await readFile(join(directory, 'key.pem')) });
    const targets = new WeakMap();
    const track = socket => { socket.setNoDelay(true); sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); return socket; };
    inner = createServer((req, res) => {
      const route = targets.get(req.socket);
      if (!route || !req.url.startsWith('/')) return req.socket.destroy();
      const { target, agent } = route;
      const headers = { ...req.headers, host: target.host }; delete headers['proxy-authorization'];
      const backend = httpRequest({ hostname: target.hostname, port: target.port, method: req.method,
        agent, path: target.pathname.replace(/\/$/, '') + req.url, headers }, response => {
        res.writeHead(response.statusCode, response.headers); res.flushHeaders(); response.pipe(res);
        response.on('aborted', () => res.destroy()); response.on('error', () => res.destroy());
      });
      backend.on('error', () => res.destroy());
      res.on('close', () => backend.destroy()); req.on('aborted', () => backend.destroy()); req.pipe(backend);
    });
    outer = createServer((req, res) => { res.writeHead(405); res.end(); });
    outer.on('connection', track);
    outer.on('connect', (req, socket, head) => {
      try {
        if (req.url !== 'api.reacon.io:443' || head.length) throw Error('Fixed origin required');
        const authorization = req.headers['proxy-authorization'];
        if (!authorization?.startsWith('Basic ')) throw Error('Fixture authorization required');
        const [encoded, password] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
        if (password?.length !== token.length || !timingSafeEqual(Buffer.from(password), Buffer.from(token))) throw Error('Invalid fixture authorization');
        const target = new URL(Buffer.from(encoded, 'base64url').toString());
        if (target.hostname !== '127.0.0.1' || !target.port || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw Error('Loopback fixtures only');
        if (target.protocol === 'https:') {
          // Preserve the client's own CA and hostname checks for dedicated TLS tests.
          const backend = track(connect(Number(target.port), target.hostname, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(backend); backend.pipe(socket);
          }));
          backend.on('error', () => socket.destroy()); socket.on('close', () => backend.destroy()); backend.on('close', () => socket.destroy());
        } else {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const secure = track(new TLSSocket(socket, { isServer: true, secureContext: context }));
          const agent = new Agent({ keepAlive: true }); agents.add(agent);
          secure.on('close', () => { agent.destroy(); agents.delete(agent); });
          secure.on('error', () => secure.destroy()); targets.set(secure, { target, agent }); inner.emit('connection', secure);
        }
      } catch (error) { if (process.env.REACON_FIXTURE_PROXY_DEBUG === '1') console.error('Fixture proxy rejected CONNECT:', error.message); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
    });
    await new Promise(resolve => outer.listen(0, '127.0.0.1', resolve));
    return { ca, proxyURL(target) {
      const url = new URL(`http://127.0.0.1:${outer.address().port}`);
      url.username = Buffer.from(target).toString('base64url'); url.password = token; return url.toString();
    }, async close() { for (const agent of agents) agent.destroy(); for (const socket of sockets) socket.destroy(); inner.closeAllConnections(); await new Promise(resolve => outer.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { for (const agent of agents) agent.destroy(); for (const socket of sockets) socket.destroy(); outer?.close(); inner?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
let shared, users = 0;
export async function acquireFixtureProxy() {
  users++;
  shared ??= startFixtureProxy();
  let proxy;
  try { proxy = await shared; } catch (error) { users--; if (!users) shared = undefined; throw error; }
  process.env.REACON_FIXTURE_PROXY_ENDPOINT = proxy.proxyURL('http://127.0.0.1:1');
  process.env.REACON_FIXTURE_CA_PEM = proxy.ca;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      shared = undefined;
      delete process.env.REACON_FIXTURE_PROXY_ENDPOINT; delete process.env.REACON_FIXTURE_CA_PEM;
      await proxy.close();
    }
  };
}
export function fixtureProxyDockerArgs() {
  if (!process.env.REACON_FIXTURE_PROXY_ENDPOINT || !process.env.REACON_FIXTURE_CA_PEM) throw Error('Fixture proxy is not running');
  return ['--env', 'REACON_FIXTURE_PROXY_ENDPOINT', '--env', 'REACON_FIXTURE_CA_PEM'];
}
