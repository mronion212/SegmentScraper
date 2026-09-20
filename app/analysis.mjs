import { spawn } from 'node:child_process';
import { mkdtemp, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const WIDTH=320, HEIGHT=180, FPS=2, FRAME_BYTES=WIDTH*HEIGHT;
const round=n=>Math.round(n*1000)/1000;
export const ANALYSIS_VERSION='credits-tail/v4';

/**
 * Container duration can include an audio or metadata tail after the video
 * stream has ended. Ending analysis must follow decoded video, otherwise a
 * perfectly valid file can be reported as truncated near EOF.
 */
export function analysisDuration(report) {
  const duration=Number(report?.duration),videoDuration=Number(report?.video_duration);
  if(Number.isFinite(videoDuration)&&videoDuration>0)return Number.isFinite(duration)&&duration>0?Math.min(duration,videoDuration):videoDuration;
  return Number.isFinite(duration)&&duration>0?duration:null;
}

export function analysisStart(duration, scanFraction=.25) {
  if(![.25,.5,1,'last-15-minutes'].includes(scanFraction))throw new Error('Invalid analysis window.');
  return round(scanFraction==='last-15-minutes'?Math.max(0,duration-900):duration*(1-scanFraction));
}

// A deliberately conservative visual heuristic, not semantic recognition.
// Text over a dark background has many small disconnected bright components.
export function frameFeatures(frame, width=WIDTH, height=HEIGHT) {
  let dark=0,bright=0, count=0;
  const mask=new Uint8Array(width*height), visited=new Uint8Array(width*height);
  const rows=new Uint16Array(height), stack=new Int32Array(width*height);
  for(let y=Math.floor(height*.08);y<height*.92;y++)for(let x=Math.floor(width*.08);x<width*.92;x++){
    const i=y*width+x,v=frame[i];count++;if(v<45)dark++;if(v>170){bright++;mask[i]=1;rows[y]++;}
  }
  let glyphs=0,textRows=0;
  for(let y=0;y<height;y++)if(rows[y]>=5&&rows[y]<width*.65)textRows++;
  if(dark/count>.65&&bright/count>.003&&bright/count<.25){
    for(let i=0;i<mask.length;i++)if(mask[i]&&!visited[i]){
      let top=0,size=0,minX=width,maxX=0,minY=height,maxY=0;stack[top++]=i;visited[i]=1;
      while(top){const p=stack[--top],x=p%width,y=Math.floor(p/width);size++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        for(const q of [x>0?p-1:-1,x+1<width?p+1:-1,y>0?p-width:-1,y+1<height?p+width:-1])if(q>=0&&mask[q]&&!visited[q]){visited[q]=1;stack[top++]=q;}
      }
      if(size>=2&&size<=120&&maxX-minX<20&&maxY-minY<20)glyphs++;
    }
  }
  return {darkRatio:dark/count,brightRatio:bright/count,glyphs,creditLike:dark/count>.7&&glyphs>=18&&textRows>=12,black:dark/count>.99&&bright/count<.001};
}

function intervals(samples,predicate,minDuration=0){
  const result=[];let start=null;
  for(let i=0;i<=samples.length;i++){
    const hit=i<samples.length&&predicate(samples[i],i);
    if(hit&&start===null)start=i;
    if(!hit&&start!==null){const end=i<samples.length?samples[i].time:samples.at(-1).time+1/FPS;if(end-samples[start].time>=minDuration)result.push({start_sec:round(samples[start].time),end_sec:round(end)});start=null;}
  }
  return result;
}
function mergeClose(ranges,gap=2){
  const merged=[];for(const r of ranges){const last=merged.at(-1);if(last&&r.start_sec-last.end_sec<=gap)last.end_sec=r.end_sec;else merged.push({...r});}return merged;
}
export function proposeTimeline({duration,start,samples,blackRanges=[],chapters=[]}){
  const warnings=['Visual heuristics cannot prove scene presence or absence. Review the proposed boundaries and the ending overview before upload.'];
  // Smooth a 2-second neighborhood; brief fades must not split a credit roll.
  const smooth=samples.map((s,i)=>({...s,creditLike:samples.slice(Math.max(0,i-2),i+3).filter(v=>v.creditLike).length>=3}));
  const creditRuns=mergeClose(intervals(smooth,s=>s.creditLike,3),3).filter(r=>r.end_sec-r.start_sec>=8);
  const chapterCredits=chapters.filter(c=>c.suggestion==='outro'&&!c.issues.length&&c.start_sec>=start);
  let creditsStart=chapterCredits.length?Math.min(...chapterCredits.map(c=>c.start_sec)):creditRuns[0]?.start_sec??null;
  if(creditsStart!==null&&creditsStart<=start+2)warnings.push('Credits may start before the scanned window. Expand the scan or correct the start.');
  const scenes=[];
  const nonCredit=intervals(smooth,s=>!s.creditLike&&!s.black,4);
  if(creditsStart!==null){
    for(const range of nonCredit){
      if(range.start_sec<creditsStart+5)continue;
      const before=creditRuns.some(r=>r.end_sec<=range.start_sec+2&&range.start_sec-r.end_sec<=8)||blackRanges.some(r=>Math.abs(r.end_sec-range.start_sec)<=3);
      const after=creditRuns.some(r=>Math.abs(r.start_sec-range.end_sec)<=8)||blackRanges.some(r=>Math.abs(r.start_sec-range.end_sec)<=3);
      if(before&&(after||range.end_sec>=duration-2)){
        const startTransition=blackRanges.find(r=>Math.abs(r.end_sec-range.start_sec)<=2);
        const endTransition=blackRanges.find(r=>Math.abs(r.start_sec-range.end_sec)<=2);
        const followsCredits=creditRuns.some(r=>r.start_sec>=range.end_sec-2&&r.end_sec-range.end_sec>=8);
        scenes.push({start_sec:startTransition?.end_sec??range.start_sec,end_sec:endTransition?.start_sec??range.end_sec,kind:followsCredits?'mid-credits':'post-credits',evidence:'Sustained non-credit-like imagery between credit/black transitions',uncertainEnd:range.end_sec>=duration-2&&!after});
      }
    }
  }
  for(const c of chapters.filter(c=>c.suggestion==='post-credits'&&!c.issues.length)){
    if(!scenes.some(s=>s.start_sec<c.end_sec&&s.end_sec>c.start_sec))scenes.push({start_sec:c.start_sec,end_sec:c.end_sec,kind:creditRuns.some(r=>r.start_sec>=c.end_sec)?'mid-credits':'post-credits',evidence:'Explicit chapter label (still requires review)',uncertainEnd:false});
  }
  scenes.sort((a,b)=>a.start_sec-b.start_sec);
  const safeScenes=scenes.filter(s=>s.end_sec>s.start_sec&&s.end_sec<=duration);
  if(creditsStart===null)warnings.push('No reliable credits-start candidate. Black transitions alone are not credits. Use the ending overview to identify a boundary.');
  if(!safeScenes.length)warnings.push('No extra-scene candidate found. This is not proof that there is no extra scene.');
  if(safeScenes.length>1)warnings.push('Multiple scene candidates: IntroDB currently models one scene. Review and reject false positives; if more than one real scene remains, keep the full local report instead of uploading a misleading range.');
  if(safeScenes.some(s=>s.uncertainEnd))warnings.push('A candidate reaches EOF without a confirmed end transition. Its end is unresolved.');
  const finalBlack=blackRanges.find(r=>r.end_sec>=duration-1&&r.start_sec>duration-60);
  const creditsEnd=finalBlack?.start_sec??duration;
  const suggestions=[];
  if(creditsStart!==null&&creditsEnd>creditsStart){
    const firstScene=safeScenes.find(s=>s.start_sec>creditsStart);
    suggestions.push({segment_type:'outro',start_sec:round(creditsStart),end_sec:round(firstScene?.start_sec??creditsEnd)});
    for(const scene of safeScenes)if(!scene.uncertainEnd)suggestions.push({segment_type:'post-credits',start_sec:scene.start_sec,end_sec:scene.end_sec});
  }
  return {version:ANALYSIS_VERSION,status:'needs-review',scanStart:start,scanEnd:duration,sampleInterval:1/FPS,creditsStart,creditsEnd,creditRuns,blackRanges,scenes:safeScenes,suggestions,warnings};
}

function inputArgs(source){
  if(source.remote){const url=new URL(source.input);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Invalid provider analysis URL.');return ['-hwaccel','auto','-rw_timeout','60000000','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','10','-protocol_whitelist','https,http,tls,tcp,crypto'];}
  if(!path.isAbsolute(source.input))throw new Error('Analysis requires an inspected local file.');
  return ['-hwaccel','auto','-protocol_whitelist','file,crypto,data'];
}
function runFfmpeg(args,{signal,onFrame,onProgress,onLine,executable=process.env.FFMPEG_PATH||'ffmpeg',timeout=30*60*1000}={}){
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const proc=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe','pipe']});
    let frames=Buffer.alloc(0),log='',progress='',failed=false,framesSeen=0;
    const abort=()=>{failed=true;proc.kill();};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,timeout);
    proc.stdout.on('data',chunk=>{if(!onFrame)return;frames=Buffer.concat([frames,chunk]);while(frames.length>=FRAME_BYTES){onFrame(frames.subarray(0,FRAME_BYTES),framesSeen++);frames=frames.subarray(FRAME_BYTES);}});
    proc.stderr.on('data',chunk=>{log+=chunk.toString();const lines=log.split(/[\r\n]+/);log=lines.pop().slice(-8192);for(const line of lines)onLine?.(line);});
    proc.stdio[3].on('data',chunk=>{progress+=chunk.toString();const lines=progress.split('\n');progress=lines.pop().slice(-1024);for(const line of lines){const m=line.match(/^out_time_us=(\d+)/);if(m)onProgress?.(Number(m[1])/1e6);}});
    proc.on('error',error=>{failed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new Error(error.code==='ENOENT'?'FFmpeg is missing. Install the complete desktop build.':'Could not start FFmpeg.'));});
    proc.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(log)onLine?.(log);if(signal?.aborted){reject(new Error('Analysis cancelled.'));return;}if(failed||code!==0){reject(new Error('FFmpeg analysis failed or timed out. For provider files, download and retry locally.'));return;}resolve({framesSeen});});
  });
}

export async function analyzeCredits(source,report,{signal,onProgress=()=>{},scanFraction=.25,executable,artifactRoot}={}){
  const duration=analysisDuration(report);
  if(!Number.isFinite(duration)||duration<=0)throw new Error('Inspect the video duration before analyzing credits.');
  const start=analysisStart(duration,scanFraction),length=duration-start;
  const samples=[],blackRanges=[];
  const input=inputArgs(source);
  const directory=await mkdtemp(path.join(artifactRoot||os.tmpdir(),'segmentscraper-analysis-'));
  const artifacts=[];
  try{
  const overview={id:randomUUID(),kind:'overview',file:path.join(directory,'overview.webm'),sourceStart:start,sourceEnd:duration,speed:12};
  artifacts.push(overview);
  const graph=`[0:v:0]split=2[scan][overview];[scan]fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,blackdetect=d=2:pix_th=0.1:pic_th=0.98,format=gray[frames];[overview]fps=0.5,settb=AVTB,setpts=(PTS-STARTPTS)/12,fps=6,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p[quick]`;
  onProgress({phase:'scanning',percent:0,scannedSeconds:0,totalSeconds:length,startedAt:Date.now()});
  await runFfmpeg(['-hide_banner','-nostdin','-loglevel','info',...input,'-ss',String(start),'-i',source.input,'-filter_complex',graph,'-map','[frames]','-an','-c:v','rawvideo','-progress','pipe:3','-f','rawvideo','pipe:1','-map','[quick]','-an','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-b:v','500k','-y',overview.file],{
    signal,executable,onFrame:(frame,index)=>{if(index/FPS<=length+.5)samples.push({time:round(start+index/FPS),...frameFeatures(frame)});},
    onLine:line=>{const m=line.match(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/);if(m)blackRanges.push({start_sec:round(start+Number(m[1])),end_sec:round(Math.min(duration,start+Number(m[2])))});},
    onProgress:seconds=>onProgress({phase:'scanning',percent:Math.min(98,Math.round(seconds/length*98)),scannedSeconds:Math.min(length,seconds),totalSeconds:length}),
  });
  if(!samples.length)throw new Error('No decodable video frames found.');
  // Decoder failures/truncation must not masquerade as a complete ending scan.
  if(samples.at(-1).time<duration-2)throw new Error('The ending scan stopped before the end of the video. Download and retry locally.');
  const analysis=proposeTimeline({duration,start,samples,blackRanges,chapters:report.chapters});
    if(Number.isFinite(Number(report.duration))&&Number(report.duration)-duration>2)analysis.warnings.push(`The container reports ${round(Number(report.duration)-duration)} extra seconds after the video stream. Analysis follows the video stream and does not infer a scene from that tail.`);
    // Generate boundary clips on demand: remote seeks can be expensive.
    analysis.warnings.push('Black transitions and visual candidates are sampled every 0.5 seconds. Refine boundaries using the original-speed clips.');
    if(start>0)analysis.warnings.push(`Only the final ${Math.round(length)} seconds were scanned. Earlier scenes are not checked; expand the window if credits begin before it.`);
    for(const a of artifacts){if((await stat(a.file)).size===0)throw new Error('An analysis preview is empty.');}
    onProgress({phase:'ready-for-review',percent:100});
    return {analysis,artifacts,directory};
  }catch(error){await disposeAnalysis({directory,artifacts});throw error;}
}
export async function disposeAnalysis(result){
  if(!result?.directory)return;
  // Only remove our explicit generated files, never source media or recursive paths.
  for(const a of result.artifacts||[])if(path.dirname(a.file)===result.directory)await rm(a.file,{force:true}).catch(()=>{});
  await rmdir(result.directory).catch(()=>{});
}

export async function createReviewClip(source,duration,boundary,directory,{signal,executable}={}){
  if(!Number.isFinite(boundary)||boundary<0||boundary>duration)throw new Error('Choose a time within the video.');
  const from=Math.max(0,boundary-6),to=Math.min(duration,boundary+6),id=randomUUID();
  const clip={id,kind:'boundary',boundary,sourceStart:from,sourceEnd:to,speed:1,file:path.join(directory,`${id}.webm`)};
  try{
    await runFfmpeg(['-hide_banner','-nostdin','-loglevel','error',...inputArgs(source),'-ss',String(from),'-i',source.input,'-t',String(to-from),'-map','0:v:0','-map','0:a:0?','-sn','-dn','-vf','scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-b:v','800k','-c:a','libopus','-ac','2','-b:a','96k','-y',clip.file],{signal,executable,timeout:5*60000});
    return clip;
  }catch(error){await rm(clip.file,{force:true}).catch(()=>{});throw error;}
}
