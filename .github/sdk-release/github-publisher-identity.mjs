import { createHash, createPublicKey, verify } from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'https://github.com/reacon-io';
const OWNER_ID = '334414696';
const FAMILIES = ['typescript', 'python', 'go', 'rust', 'php', 'ruby', 'java', 'kotlin', 'csharp'];
const id = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Obtain and cryptographically verify this job's GitHub identity. Registry
 * credentials use their own audience and exchange; this token is never saved.
 * The returned metadata is not a transferable publication authorization. */
export async function githubPublisherIdentity({ configuration, environment, fetchImpl = fetch, tokenProvider, now = Date.now }) {
  const env = { ...environment }, config = { ...configuration };
  const repository = `reacon-io/reacon-${config.family}`;
  const workflowRef = `${repository}/.github/workflows/publish.yml@refs/heads/main`;
  if (config.formatVersion !== 1 || !FAMILIES.includes(config.family) || !id(String(config.repositoryId)) ||
      config.repository !== repository || !['private', 'public'].includes(config.visibility)) throw new Error('Expected reviewed company publisher configuration');
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_SERVER_URL !== 'https://github.com' || env.GITHUB_API_URL !== 'https://api.github.com' ||
      env.GITHUB_REPOSITORY !== repository || env.GITHUB_REPOSITORY_ID !== String(config.repositoryId) ||
      env.GITHUB_REPOSITORY_OWNER !== 'reacon-io' || env.GITHUB_REPOSITORY_OWNER_ID !== OWNER_ID ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_WORKFLOW_REF !== workflowRef || !sha(env.GITHUB_SHA) || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' || !id(env.GITHUB_RUN_ID) || !id(env.GITHUB_RUN_ATTEMPT) ||
      typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== 'string' || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 32768 || /\s/.test(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) throw new Error('Not the configured company publisher job');
  let endpoint;
  try {
    endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.actions.githubusercontent.com') ||
        endpoint.port || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
  } catch { throw new Error('Unexpected GitHub job identity endpoint'); }
  if (endpoint.searchParams.has('audience')) throw new Error('Unexpected preselected GitHub identity audience');
  // Preserve the runner-provided query bytes, as the official Actions toolkit
  // does. Re-serializing an opaque signed/request URL can change its meaning.
  const requestUrl = `${env.ACTIONS_ID_TOKEN_REQUEST_URL}${endpoint.search ? '&' : '?'}audience=${encodeURIComponent(AUDIENCE)}`;
  async function json(url, headers = {}) {
    let response;
    try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', 'User-Agent': 'reacon-sdk-publisher', ...headers } }); }
    catch { throw new Error('GitHub identity transport failed; details suppressed'); }
    if (response.status !== 200) {
      // Azure/GitHub return useful structured errors for invalid token requests.
      // Keep a bounded, redacted message; never echo a raw body, URL or token.
      let detail = '';
      try {
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > 8192) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let message;
        try { const body = JSON.parse(text); message = body.message ?? body.error_description ?? body.error?.message ?? body.error; }
        catch { message = text.replace(/<[^>]*>/g, ' '); }
        if (typeof message === 'string') detail = message
          .split(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).join('[redacted]')
          .replace(/https?:\/\/\S+/g, '[url]')
          .replace(/[A-Za-z0-9_./+=-]{32,}/g, '[redacted]')
          .replace(/[^A-Za-z0-9 .,;:!?()\[\]'_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      } catch { /* Unstructured or oversized errors remain suppressed. */ }
      throw new Error(`GitHub identity HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 128 * 1024) throw new Error(); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks));
    } catch { throw new Error('Invalid GitHub identity response; details suppressed'); }
  }
  // Production uses the official Actions toolkit for runner-specific HTTP/proxy
  // behavior. Regardless of transport, verify the returned JWT ourselves below.
  let response;
  if (tokenProvider !== undefined) {
    if (typeof tokenProvider !== 'function') throw new Error('Invalid GitHub token provider');
    try { response = { value: await tokenProvider(AUDIENCE) }; }
    catch (error) {
      // Only expose the official client's documented error envelope. Arbitrary
      // provider exceptions may contain secrets and remain fully suppressed.
      const message = typeof error?.message === 'string' ? error.message : '';
      const envelope = message.match(/Failed to get ID Token\.[\s\S]*?Error Code\s*:\s*(\d{3})\s+Error Message:\s*([\s\S]*)/);
      let detail = '';
      if (envelope) {
        const safe = envelope[2].split(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).join('[redacted]')
          .split(env.ACTIONS_ID_TOKEN_REQUEST_URL).join('[url]')
          .replace(/https?:\/\/\S+/g, '[url]')
          .replace(/[A-Za-z0-9_./+=-]{32,}/g, '[redacted]')
          .replace(/[^A-Za-z0-9 .,;:!?()\[\]'_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
        detail = ` HTTP ${envelope[1]}${safe ? `: ${safe}` : ''}`;
      }
      throw new Error(`Official GitHub token request failed${detail || '; details suppressed'}`);
    }
  } else response = await json(requestUrl, { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` });
  let header, claims, parts;
  try {
    if (typeof response.value !== 'string' || response.value.length > 32768) throw new Error();
    parts = response.value.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' || !header.kid ||
        header.crit !== undefined || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error();
  } catch { throw new Error('Malformed GitHub job identity token'); }
  const keySet = await json(`${ISSUER}/.well-known/jwks`);
  try {
    if (!Array.isArray(keySet.keys) || keySet.keys.length > 100) throw new Error();
    const candidates = keySet.keys.filter(key => key.kid === header.kid);
    if (candidates.length !== 1 || candidates[0].kty !== 'RSA' || candidates[0].use !== 'sig' ||
        (candidates[0].alg !== undefined && candidates[0].alg !== 'RS256')) throw new Error();
    const key = createPublicKey({ key: candidates[0], format: 'jwk' });
    if (key.asymmetricKeyDetails.modulusLength < 2048 ||
        !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error();
  } catch { throw new Error('GitHub job identity signature verification failed'); }
  const seconds = now() / 1000;
  if (!Number.isFinite(seconds) || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
      claims.sub !== `repo:reacon-io@${OWNER_ID}/reacon-${config.family}@${config.repositoryId}:environment:release` || claims.environment !== 'release' ||
      claims.repository !== repository || claims.repository_id !== String(config.repositoryId) ||
      claims.repository_owner !== 'reacon-io' || claims.repository_owner_id !== OWNER_ID ||
      claims.repository_visibility !== config.visibility || claims.ref !== 'refs/heads/main' || claims.ref_type !== 'branch' ||
      claims.sha !== env.GITHUB_SHA || claims.workflow_ref !== workflowRef || claims.workflow_sha !== env.GITHUB_WORKFLOW_SHA ||
      claims.event_name !== 'workflow_dispatch' || claims.runner_environment !== 'github-hosted' ||
      claims.run_id !== env.GITHUB_RUN_ID || claims.run_attempt !== env.GITHUB_RUN_ATTEMPT ||
      (claims.job_workflow_ref !== undefined && claims.job_workflow_ref !== workflowRef) ||
      (claims.job_workflow_sha !== undefined && claims.job_workflow_sha !== env.GITHUB_SHA) ||
      !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || !Number.isFinite(claims.nbf) ||
      claims.exp < seconds + 30 || claims.exp > seconds + 900 || claims.iat > seconds + 30 ||
      claims.iat < seconds - 600 || claims.nbf > seconds + 30 || claims.exp <= claims.iat ||
      claims.nbf > claims.exp) throw new Error('GitHub job identity claims do not match this publisher');
  return {
    formatVersion: 1, kind: 'sdk-github-publisher-identity', observedAt: new Date(now()).toISOString(),
    family: config.family, repository, repositoryId: Number(config.repositoryId), visibility: config.visibility,
    workflow: 'publish.yml', workflowRef, workflowCommit: env.GITHUB_WORKFLOW_SHA, sourceCommit: env.GITHUB_SHA,
    environment: 'release', event: 'workflow_dispatch', runnerEnvironment: 'github-hosted',
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    workerId: `gh-${config.repositoryId}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    signatureVerified: true, signingKeyId: header.kid,
    verifiedClaimsSha256: createHash('sha256').update(parts[1]).digest('hex'),
    tokenExpiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
