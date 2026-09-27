import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getIDToken } from '@actions/core';
import { githubPublisherIdentity } from './github-publisher-identity.mjs';

const configuration = JSON.parse(await readFile(new URL('./configuration.json', import.meta.url)));
const identity = await githubPublisherIdentity({ configuration, environment: process.env, tokenProvider: () => getIDToken() });
const workflow = await readFile('.github/workflows/publish.yml');
const report = { ...identity, workflowSha256: createHash('sha256').update(workflow).digest('hex'),
  qualificationScope: 'GitHub release environment and signed job identity only', tokenTransport: '@actions/core@3.0.1',
  registryExchangeVerified: false, packagePublished: false, publishable: false };
await mkdir('sdk-release-results', { recursive: true });
await writeFile('sdk-release-results/identity.json', JSON.stringify(report, null, 2) + '\n');
console.log(`Verified ${identity.repository} release environment, worker ${identity.workerId}. No package upload requested.`);
