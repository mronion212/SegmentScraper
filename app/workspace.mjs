import { mkdir, readFile, writeFile, rename, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Atomic snapshots contain reports and drafts, never credentials or provider URLs.
export async function openWorkspace(directory) {
  await mkdir(directory, { recursive:true });
  const file=path.join(directory,'workspace.json');
  let data={version:1,jobs:[],uploads:{accepted:[],history:[]}}, error=null, chain=Promise.resolve();
  try {
    const parsed=JSON.parse(await readFile(file,'utf8'));
    if(parsed.version!==1||!Array.isArray(parsed.jobs))throw new Error('Unsupported workspace format');
    data=parsed;
  } catch(e) { if(e.code!=='ENOENT')throw new Error('Saved workspace could not be read. Your files have been preserved. Restore workspace.json from a backup before continuing.'); }
  return {
    directory,
    get:()=>structuredClone(data),
    status:()=>error?{saved:false,error}:{saved:true},
    save(patch) {
      data={...data,...structuredClone(patch)};
      const snapshot=JSON.stringify(data);
      const operation=chain.catch(()=>{}).then(async()=>{
        const temporary=file+'.tmp';
        await writeFile(temporary,snapshot,{mode:0o600});
        const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
        await rename(temporary,file);error=null;
      }).catch(e=>{error='Could not save your work. Check disk space and folder permissions.';throw e;});
      chain=operation;return operation;
    },
    flush:()=>chain,
  };
}

export async function fingerprint(file) {
  const metadata=await stat(file);
  if(!metadata.isFile())throw new Error('The original video is unavailable.');
  const digest=createHash('sha256'),handle=await open(file,'r');
  try {
    for(const offset of new Set([0,Math.max(0,Math.floor(metadata.size/2)-32768),Math.max(0,metadata.size-65536)])){
      const buffer=Buffer.alloc(Math.min(65536,metadata.size-offset));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);digest.update(buffer.subarray(0,bytesRead));
    }
  } finally { await handle.close(); }
  return `${metadata.size}:${metadata.mtimeMs}:${digest.digest('hex')}`;
}

export function savedJob(job) {
  const keys=['id','name','mode','local','savedPath','downloadDir','remote','providerName','torrentId','fileId','status','report','draft','fingerprint','analysisProgress','analysisError','error','bytes','total'];
  const result=Object.fromEntries(keys.filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
  if(job.analysisResult)result.analysisResult=job.analysisResult;
  return result;
}

export function cleanDraft(input) {
  if(!input||typeof input!=='object')throw new Error('Invalid review draft.');
  const result={};
  for(const key of ['imdb_id','media_type','episodeTitle','query'])result[key]=String(input[key]||'').slice(0,250);
  for(const key of ['season','episode'])result[key]=Number.isFinite(input[key])?input[key]:null;
  result.segments=(Array.isArray(input.segments)?input.segments:[]).slice(0,100).map(s=>({segment_type:String(s.segment_type||'').slice(0,30),start_sec:Number.isFinite(s.start_sec)?s.start_sec:null,end_sec:Number.isFinite(s.end_sec)?s.end_sec:null}));
  result.sceneReview=(Array.isArray(input.sceneReview)?input.sceneReview:[]).slice(0,100).map(v=>['scene','not-scene'].includes(v)?v:'');
  // A restored draft is not a fresh authorization to submit.
  return result;
}
