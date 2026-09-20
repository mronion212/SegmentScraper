import { createCore } from './shared-core.mjs';
const { compareVersions } = createCore({ request: () => {} });
export const RELEASES = 'https://github.com/mronion212/SegmentScraper/releases';
export function createUpdateChecker({ version, fetcher = fetch, requiredVersion = '' }) {
  let state = { currentVersion:version, latestVersion:requiredVersion || version, required:compareVersions(requiredVersion,version)===1, status:'idle', url:RELEASES };
  let pending;
  async function check() {
    if(pending) return pending;
    state.status='checking';
    pending=(async()=>{
      try {
        const response=await fetcher('https://api.github.com/repos/mronion212/SegmentScraper/releases?per_page=100',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(10000),redirect:'error'});
        if(!response.ok) throw new Error();
        const releases=await response.json();
        if(!Array.isArray(releases)) throw new Error();
        const valid=releases.filter(r=>!r.draft&&!r.prerelease&&compareVersions(r.tag_name,version)!==null&&r.assets?.some(a=>a.name===`SegmentScraper-Desktop-${String(r.tag_name).replace(/^v/,'')}-x64-Setup.exe`&&a.size>0));
        valid.sort((a,b)=>compareVersions(b.tag_name,a.tag_name));
        const latest=valid[0];
        if(latest && compareVersions(latest.tag_name,state.latestVersion)===1) state.latestVersion=latest.tag_name.replace(/^v/,'');
        state.required=compareVersions(state.latestVersion,version)===1;
        state.status='checked';state.checkedAt=Date.now();
      }catch{state.status='unavailable';}
      return {...state};
    })().finally(()=>{pending=null;});
    return pending;
  }
  return { check, get:()=>({...state}) };
}
