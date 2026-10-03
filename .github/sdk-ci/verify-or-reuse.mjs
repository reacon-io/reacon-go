import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdtemp,rm,rename} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {sha256,inputKey,CACHE_TTL_MS,retainProof,reuseProof} from './verification-cache.mjs';
const exec=promisify(execFile),sha=value=>/^[a-f0-9]{40}$/.test(value??'');
const MAX_ARCHIVE=128*1024**2;

export function trustedRun(run,{repository,head,now=Date.now(),currentRun}) {
  return run?.repository?.full_name===repository&&run.head_repository?.full_name===repository&&
    run.head_sha===head&&run.path==='.github/workflows/ci.yml'&&['push','pull_request','workflow_dispatch'].includes(run.event)&&
    run.status==='completed'&&run.conclusion==='success'&&run.id!==currentRun&&
    Number.isSafeInteger(run.id)&&Number.isSafeInteger(run.run_attempt)&&
    Date.parse(run.created_at)<=now&&Date.parse(run.created_at)>=now-CACHE_TTL_MS;
}
async function bounded(response) {
  if(!response.ok)throw Error('Verification artifact download failed');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>MAX_ARCHIVE)throw Error('Verification artifact exceeds limit');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export async function downloadArtifact({repository,artifact,token,fetchImpl=fetch}) {
  if(!Number.isSafeInteger(artifact.id)||artifact.id<1||!/^sha256:[a-f0-9]{64}$/.test(artifact.digest??'')||
    artifact.expired||artifact.size_in_bytes>MAX_ARCHIVE)throw Error('Invalid verification artifact');
  let response=await fetchImpl(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,{
    headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(response.status===302) {
    const url=new URL(response.headers.get('location'));
    if(url.protocol!=='https:'||url.username||url.password||url.port||
      !(url.hostname.endsWith('.blob.core.windows.net')||url.hostname.endsWith('.actions.githubusercontent.com')))
      throw Error('Unexpected verification artifact destination');
    response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  }
  const bytes=await bounded(response);
  if('sha256:'+sha256(bytes)!==artifact.digest)throw Error('Verification artifact digest differs');
  return bytes;
}
export async function unpackArchive(archive,directory) {
  // Reject unexpected files, links, zip bombs and traversal before extracting.
  await exec('python3',['-c',`
import zipfile,stat,sys,pathlib
with zipfile.ZipFile(sys.argv[1]) as z:
 items=z.infolist(); total=0; names=set()
 for i in items:
  n=i.filename; p=pathlib.PurePosixPath(n)
  if i.is_dir():
   if n!='artifacts/': raise ValueError('Unexpected archive directory')
   continue
  if n in names or p.is_absolute() or '..' in p.parts or stat.S_IFMT(i.external_attr>>16) not in (0,stat.S_IFREG): raise ValueError('Unsafe archive member')
  names.add(n);total+=i.file_size
  import re
  if n not in ['evidence.json','responses.json','run.log','package-manifest.json','verification-cache.json'] and not re.fullmatch(r'artifacts/[A-Za-z0-9][A-Za-z0-9._+\\-]*',n): raise ValueError('Unexpected archive member')
  if i.file_size>128*1024**2 or total>256*1024**2 or len(names)>33: raise ValueError('Oversized archive')
 z.extractall(sys.argv[2])
`,archive,directory],{timeout:15000,maxBuffer:1024*1024});
}

async function main() {
  const suite=dirname(fileURLToPath(import.meta.url)),root=resolve(process.env.REACON_SDK_SOURCE??'.');
  const output=resolve(process.env.REACON_CI_OUTPUT??'sdk-ci-results');
  const repository=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN;
  const git=async(...args)=>(await exec('git',args,{cwd:root})).stdout.trim();
  const revision=await git('rev-parse','HEAD');
  const context={repository,revision,runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT)};
  const suiteBytes=await readFile(join(suite,'manifest.json')),manifest=JSON.parse(suiteBytes);
  // Cache lookup is only allowed in an unmodified checkout. Full tree identity
  // binds source, workflow, generator metadata, suite and fixture server code.
  let input;
  try {
    if(!/^reacon-io\/reacon-(typescript|python|go|php|ruby|java|kotlin|csharp|rust)$/.test(repository??'')||
      !token||process.env.REACON_SOURCE_REVISION!==revision||await git('status','--porcelain','--untracked-files=all'))throw Error('Untrusted or modified CI checkout');
    for(const [name,digest] of Object.entries(manifest.files??{})) {
      if(!/^[A-Za-z0-9_./-]+$/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..')||
        sha256(await readFile(join(suite,name)))!==digest)throw Error('Verification suite changed');
    }
    let approved=null;
    if(process.env.REACON_PREBUILT_DIRECTORY) {
      const directory=resolve(process.env.REACON_PREBUILT_DIRECTORY),bytes=await readFile(join(directory,'manifest.json')),m=JSON.parse(bytes);
      for(const [name,file] of Object.entries(m.files)) {
        if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name))throw Error('Invalid approved filename');
        const b=await readFile(join(directory,'artifacts',name));if(b.length!==file.size||sha256(b)!==file.sha256)throw Error('Approved package changed');
      }
      approved=sha256(bytes);
    }
    input={formatVersion:1,family:manifest.family,tree:await git('rev-parse','HEAD^{tree}'),suiteSha256:sha256(suiteBytes),approvedPackageSha256:approved,
      environmentSha256:sha256(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,imageOS:process.env.ImageOS??null,
        imageVersion:process.env.ImageVersion??null,docker:(await exec('docker',['version','--format','{{.Server.Version}}'])).stdout.trim(),
        cpus:process.env.REACON_BUILD_CPUS??null,memory:process.env.REACON_BUILD_MEMORY_BYTES??null}))};
    inputKey(input);
  }catch {console.log('Verification cache unavailable: running the full suite.');}
  if(input && process.env.REACON_PREBUILT_DIRECTORY && manifest.files['approved-private-verification.mjs'] &&
      process.env.REACON_FORCE_FRESH_TESTS!=='true') {
    const temporary=await mkdtemp(join(tmpdir(),'reacon-approved-proof-'));
    try {
      const {sourceDigest,reuseApprovedPrivateVerification}=await import('./approved-private-verification.mjs');
      const restored=join(temporary,'restored');
      const reused=await reuseApprovedPrivateVerification({directory:resolve(process.env.REACON_PREBUILT_DIRECTORY),
        output:restored,suiteBytes,sourceSha256:await sourceDigest(root),revision});
      // The original private test time, not this attestation time, sets the TTL.
      await retainProof(restored,{input,context,testedAt:reused.testedAt});
      await rename(restored,output);
      console.log(`Approved private verification reused; original tests ${reused.testedAt}; exact package, source, suite and pinned container inputs match.`);
      return;
    }catch {console.log('No matching current approved private proof: checking CI evidence or running fresh tests.');}
    finally {await rm(temporary,{recursive:true,force:true});}
  }
  const lookupDeadline=Date.now()+30000;
  const api=async path=>{
    if(Date.now()>=lookupDeadline)throw Error('Verification lookup deadline exceeded');
    const r=await fetch(`https://api.github.com/repos/${repository}/${path}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(Math.max(1,Math.min(10000,lookupDeadline-Date.now())))});
    if(!r.ok)throw Error('Verification lookup unavailable');return r.json();
  };
  let reused=false;
  if(input&&process.env.REACON_FORCE_FRESH_TESTS!=='true') {
    let temporary;
    try {
      const heads=new Set([revision]);
      if(process.env.GITHUB_EVENT_NAME==='push'&&process.env.GITHUB_REF==='refs/heads/main') {
        const prs=await api(`commits/${revision}/pulls?per_page=10`);
        for(const pr of prs)if(pr.merged_at&&pr.merge_commit_sha===revision&&pr.base?.ref==='main'&&
          pr.base?.repo?.full_name===repository&&pr.head?.repo?.full_name===repository&&sha(pr.head.sha))heads.add(pr.head.sha);
      }
      temporary=await mkdtemp(join(tmpdir(),'reacon-verification-'));
      search:for(const head of heads) {
        if((await api(`git/commits/${head}`)).tree?.sha!==input.tree)continue;
        const {workflow_runs:runs}=await api(`actions/workflows/ci.yml/runs?head_sha=${head}&per_page=10`);
        // Never fall back behind a newer failed attempt on the same head.
        for(const run of runs.filter(r=>r.id!==context.runId).slice(0,1)) {
          if(run.head_sha===head&&run.status==='completed'&&run.conclusion!=='success')
            throw Error('A newer attempt did not pass; fresh verification required');
          if(!trustedRun(run,{repository,head,currentRun:context.runId}))continue;
          const {jobs}=await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
          if(jobs.filter(j=>j.name==='sdk-conformance'&&j.conclusion==='success').length!==1)continue;
          const {artifacts}=await api(`actions/runs/${run.id}/artifacts?per_page=100`);
          const matches=artifacts.filter(a=>a.name===`sdk-conformance-${run.id}-${run.run_attempt}`&&!a.expired);
          if(matches.length!==1)continue;
          const archive=join(temporary,`${run.id}.zip`),directory=join(temporary,String(run.id));
          await writeFile(archive,await downloadArtifact({repository,artifact:matches[0],token}));
          await unpackArchive(archive,directory);
          const proof=JSON.parse(await readFile(join(directory,'verification-cache.json')));
          if(!sha(proof.context?.revision)||(await api(`git/commits/${proof.context.revision}`)).tree?.sha!==input.tree)continue;
          const restored=join(temporary,'restored');
          await reuseProof(directory,restored,{input,context,previousContext:{repository,runId:run.id,runAttempt:run.run_attempt,revision:proof.context.revision}});
          await rename(restored,output);
          console.log(`Verification reused from run ${run.id}; original tests ${proof.testedAt}; exact source, package, fixture and runtime inputs match.`);
          reused=true;break search;
        }
      }
    }catch {console.log('No usable trusted verification proof: running the full suite.');}
    finally {if(temporary)await rm(temporary,{recursive:true,force:true});}
  }
  if(reused)return;
  // Do not expose artifact-read credentials to the native test runner.
  const env={...process.env};delete env.GITHUB_TOKEN;
  const exitCode=await new Promise((done,reject)=>{
    const child=spawn(process.execPath,[join(suite,'run.mjs')],{cwd:root,env,stdio:'inherit'});
    child.once('error',reject);child.once('close',code=>done(code??1));
  });
  if(exitCode){process.exitCode=exitCode;return;}
  if(input)await retainProof(output,{input,context});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
