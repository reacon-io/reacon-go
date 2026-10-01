import { fixtureProxyDockerArgs } from './fixed-origin/proxy.mjs';
import { readFile, mkdir, realpath, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRecordingServer } from './replay-server.mjs';
import { startStreamServer, streamScenarios } from './stream-server.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const suite = dirname(fileURLToPath(import.meta.url));
const root = await realpath(resolve(process.env.REACON_SDK_SOURCE ?? '.'));
const output = resolve(process.env.REACON_CI_OUTPUT ?? 'sdk-ci-results');
const manifest = JSON.parse(await readFile(resolve(suite, 'manifest.json')));
const sourceFiles = {};
async function sourceTree(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!prefix && ['.git', '.github', 'sdk-ci-results'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name), name = prefix + entry.name;
    if (path === output) continue;
    if (entry.isDirectory()) await sourceTree(path, name + '/');
    else if (entry.isFile()) sourceFiles[name] = hash(await readFile(path));
    else throw new Error('Source contains an unsupported file type');
  }
}
await sourceTree(root);
const sourceSha256 = hash(JSON.stringify(Object.fromEntries(Object.entries(sourceFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
if (manifest.formatVersion !== 1 || !['php', 'go'].includes(manifest.family) ||
    !/^(composer|golang)@sha256:[a-f0-9]{64}$/.test(manifest.image)) throw new Error('Expected pinned SDK CI bundle');
for (const [name, expected] of Object.entries(manifest.files)) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') ||
      hash(await readFile(resolve(suite, name))) !== expected) throw new Error('SDK CI bundle changed');
}
const cases = JSON.parse(await readFile(resolve(suite, 'cases.json')));
if (cases.length !== manifest.recordedScenarios || new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('Recording inventory mismatch');
await mkdir(output, { recursive: true });
const run = await import('node:fs').then(({ createWriteStream }) => createWriteStream(resolve(output, 'run.log')));
const server = await startRecordingServer(cases), streams = await startStreamServer();
try {
  const family = manifest.family;
  const args = ['run', '--rm', '--network', 'host', ...fixtureProxyDockerArgs(), '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${root}:/sdk:ro`, '-v', `${suite}:/suite:ro`, '-v', `${output}:/results`, '-w', '/results',
    '-e', `REACON_TEST_URL=${server.url}/${family}`, '-e', `REACON_STREAM_TEST_URL=${streams.url}/${family}`,
    '-e', 'REACON_CASES_FILE=/suite/cases.json', '-e', 'REACON_RESULTS_FILE=/results/responses.json',
    '-e', 'COMPOSER_HOME=/results/composer', '-e', 'GOCACHE=/results/go-build', '-e', 'GOPATH=/results/go',
    '-e', 'GOTOOLCHAIN=local', '-e', 'CI=true', manifest.image, 'sh', `/suite/${family}.sh`];
  const exitCode = await new Promise((done, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.stdout.pipe(run, { end: false }); child.stderr.pipe(run, { end: false });
    child.once('error', reject); child.once('close', code => run.end(() => done(code ?? 1)));
  });
  let recordingFailure, streamingFailure, results = [];
  try { server.assertComplete(family); } catch (error) { recordingFailure = error.message; }
  try { await streams.assertComplete(family); } catch (error) { streamingFailure = error.message; }
  try { results = JSON.parse(await readFile(resolve(output, 'responses.json'))); } catch {}
  const passed = exitCode === 0 && !recordingFailure && !streamingFailure && results.length === cases.length && results.every(item => item.passed);
  const report = { formatVersion: 1, kind: 'sdk-repository-source-ci', family, passed, exitCode,
    sourceSha256, ...(manifest.packageVersion ? { packageVersion: manifest.packageVersion } : {}),
    sourceRevision: process.env.REACON_SOURCE_REVISION ?? null, image: manifest.image, contractSha256: manifest.contractSha256,
    recordedResponses: { scenarios: cases.length, results, failure: recordingFailure, requests: server.observations.get(family) },
    streaming: { evidence: 'synthetic-http-streaming-subset', scenarios: streamScenarios, failure: streamingFailure, requests: streams.observations.get(family) },
    suiteManifestSha256: hash(await readFile(resolve(suite, 'manifest.json'))),
    publicRegistryInstallPassed: false, liveApiPassed: false, publishable: false };
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${family}: ${results.filter(item => item.passed).length}/${cases.length} recorded responses; ${streamScenarios.length} streaming scenarios; ${passed ? 'PASS' : 'FAIL'}`);
  if (!passed) process.exitCode = 1;
} finally { await server.close(); await streams.close(); }
