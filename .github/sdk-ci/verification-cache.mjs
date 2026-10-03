import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export const CACHE_TTL_MS=24*60*60*1000;
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const families=['typescript','python','go','php','ruby','java','kotlin','csharp','rust'];
const digest=value=>/^[a-f0-9]{64}$/.test(value??'');
const revision=value=>/^[a-f0-9]{40}$/.test(value??'');
export const cacheFileAllowed=name=>['evidence.json','responses.json','run.log','package-manifest.json'].includes(name)||/^artifacts\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name);
export function inputKey(input) {
  if(input?.formatVersion!==1 || !families.includes(input.family) || !revision(input.tree) ||
      !digest(input.suiteSha256) || !digest(input.environmentSha256) ||
      !(input.approvedPackageSha256===null||digest(input.approvedPackageSha256)))throw Error('Invalid verification cache inputs');
  return sha256(JSON.stringify([input.formatVersion,input.family,input.tree,input.suiteSha256,input.environmentSha256,input.approvedPackageSha256]));
}
function identity(value) {
  return value && /^reacon-io\/reacon-(typescript|python|go|php|ruby|java|kotlin|csharp|rust)$/.test(value.repository??'') &&
    Number.isSafeInteger(value.runId)&&value.runId>0&&Number.isSafeInteger(value.runAttempt)&&value.runAttempt>0&&revision(value.revision);
}
export function validateProof(proof,{input,now=Date.now(),context}) {
  const tested=Date.parse(proof?.testedAt);
  if(proof?.formatVersion!==1||proof.kind!=='sdk-ci-verification-cache'||proof.key!==inputKey(input)||
      !isDeepStrictEqual(proof.input,input)||!Number.isFinite(tested)||tested>now||now-tested>CACHE_TTL_MS||
      !identity(proof.origin)||!identity(proof.context)||proof.origin.repository!==proof.context.repository||
      !isDeepStrictEqual(proof.context,context)||!proof.files||Array.isArray(proof.files)||
      !proof.files['evidence.json']||!proof.files['responses.json']||!proof.files['run.log']||
      Object.keys(proof.files).length>32||Object.entries(proof.files).some(([name,file])=>!cacheFileAllowed(name)||
        !digest(file?.sha256)||!Number.isSafeInteger(file.size)||file.size<0||file.size>128*1024**2)||
      Object.values(proof.files).reduce((sum,f)=>sum+f.size,0)>256*1024**2)
    throw Error('Verification proof is expired or differs from the exact trusted inputs');
  return proof;
}
async function fileMap(directory) {
  const files={};
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(cacheFileAllowed(entry.name))files[entry.name]=entry;
    else if(entry.name==='artifacts'&&entry.isDirectory())
      for(const child of await readdir(join(directory,'artifacts'),{withFileTypes:true})) {
        const name='artifacts/'+child.name;
        if(!cacheFileAllowed(name))throw Error('Unexpected cached package filename');
        files[name]=child;
      }
  }
  const result={};
  for(const name of Object.keys(files).sort()) {
    const stat=await lstat(join(directory,name));
    if(!stat.isFile()||stat.size>128*1024**2)throw Error('Invalid verification cache file');
    const bytes=await readFile(join(directory,name));result[name]={sha256:sha256(bytes),size:bytes.length};
  }
  return result;
}
export async function retainProof(directory,{input,context,origin=context,testedAt=new Date().toISOString()}) {
  const proof={formatVersion:1,kind:'sdk-ci-verification-cache',key:inputKey(input),input,context,origin,testedAt,files:await fileMap(directory)};
  validateProof(proof,{input,context});
  const report=JSON.parse(await readFile(join(directory,'evidence.json')));
  validateReport(report,proof);
  await writeFile(join(directory,'verification-cache.json'),JSON.stringify(proof,null,2)+'\n');
  return proof;
}
function validateReport(report,proof) {
  if(report.passed!==true||report.exitCode!==0||report.family!==proof.input.family||
    report.kind!=='sdk-repository-source-ci'||report.sourceRevision!==proof.context.revision||
    report.suiteManifestSha256!==proof.input.suiteSha256||report.liveApiPassed!==false||
    report.publicRegistryInstallPassed!==false||report.publishable!==false||
    (report.failures!==undefined&&(!Array.isArray(report.failures)||report.failures.length)))throw Error('Only successful deterministic verification can be reused');
}
export async function reuseProof(source,destination,{input,context,previousContext,now=Date.now()}) {
  const proof=validateProof(JSON.parse(await readFile(join(source,'verification-cache.json'))),{input,context:previousContext,now});
  if(!identity(context)||context.repository!==previousContext.repository)throw Error('Verification target repository differs');
  if(!isDeepStrictEqual(await fileMap(source),proof.files))throw Error('Cached verification files changed');
  const report=JSON.parse(await readFile(join(source,'evidence.json')));
  validateReport(report,proof);
  // Rebinding is explicit: the new commit has the identical full Git tree and
  // package bytes. Preserve the original test identity and its non-sliding TTL.
  report.sourceRevision=context.revision;
  report.verificationReuse={kind:'identical-inputs',key:proof.key,testedAt:proof.testedAt,origin:proof.origin,previousContext};
  const bytes={};
  for(const name of Object.keys(proof.files))bytes[name]=await readFile(join(source,name));
  if(bytes['package-manifest.json']) {
    const manifest=JSON.parse(bytes['package-manifest.json']);
    if(manifest.sourceRevision!==previousContext.revision||report.packageArtifacts?.manifestSha256!==sha256(bytes['package-manifest.json']))
      throw Error('Cached package evidence differs');
    manifest.sourceRevision=context.revision;
    bytes['package-manifest.json']=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    report.packageArtifacts.manifestSha256=sha256(bytes['package-manifest.json']);
  }
  bytes['evidence.json']=Buffer.from(JSON.stringify(report,null,2)+'\n');
  await mkdir(destination,{recursive:true});
  for(const [name,value] of Object.entries(bytes)) {
    await mkdir(dirname(join(destination,name)),{recursive:true});await writeFile(join(destination,name),value,{flag:'wx'});
  }
  return retainProof(destination,{input,context,origin:proof.origin,testedAt:proof.testedAt});
}
