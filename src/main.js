'use strict';
const {app, BrowserWindow, ipcMain, dialog, nativeImage, protocol, shell} = require('electron');
const {Readable} = require('node:stream');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const {supported, kind, dateFields, makeWritePlan, PHOTO, VIDEO} = require('./metadata');
const {parseDate, formatDate, dateToUTC} = require('./time');
const {findSonyXML, shiftSonyXML, analyzeCapture, utcInstant,hostOffsetMinutes} = require('./capture');
const {defaults:DEFAULT_KEYS,keyCombo} = require('./keybindings');
const {buildEvidence} = require('./evidence');
let win, exif, busy=false, cancelled=false;
let scanRows=new Map(), lastReport=[];
let activeShortcuts={...DEFAULT_KEYS},shortcutRecording=false;
// Preview URLs only serve videos that were explicitly opened and analyzed by this app.
const mediaTokens = new Map();
const mediaTokenForPath = new Map();
const thumbnailCache = new Map();
protocol.registerSchemesAsPrivileged([{scheme:'camera-media',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
function mediaToken(file){
  if(!mediaTokenForPath.has(file)){
    const token=randomUUID();mediaTokenForPath.set(file,token);mediaTokens.set(token,file);
  }
  return mediaTokenForPath.get(file);
}

const LIMIT=10000;
function send(ch,data) {if(win&&!win.isDestroyed())win.webContents.send(ch,data);}
const fail=(msg)=>({ok:false,error:msg});
const err=(e)=>e?.message||String(e);
async function getExif(){
  if(exif)return exif;
  const {ExifTool}=await import('exiftool-vendored');
  // Never silently add assumed time zones when reading camera files.
  exif=new ExifTool({maxProcs:2,backfillTimezones:false,defaultVideosToUTC:false});
  return exif;
}
async function readTags(file){
  const tool=await getExif();
  const tags=await tool.readRaw(file,{readArgs:['-G1','-a','-api','LargeFileSupport=1']});
  if(tags.errors?.length)throw Error(tags.errors.join('; '));
  return tags;
}
function makeWindow(){
  win=new BrowserWindow({width:1360,height:880,minWidth:1160,minHeight:740,
    backgroundColor:'#f5f7fb',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.setMenuBarVisibility(false);
  // macOS menu accelerators can consume Command+1...4 before renderer keydown.
  // Intercept modifier shortcuts in the main process and forward to the app.
  win.webContents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown'||shortcutRecording)return;
    const combo=keyCombo(input,process.platform==='darwin');
    if(!combo.startsWith('Mod+'))return; // Space/arrows handled by renderer to respect typing focus.
    const name=Object.keys(activeShortcuts).find(id=>activeShortcuts[id]===combo);
    if(!name)return;
    event.preventDefault();
    if(!input.isAutoRepeat)send('app-shortcut',name);
  });
  win.loadFile(path.join(__dirname,'index.html'));
}
// Muted video autoplay is permitted without waiting for a second click.
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.whenReady().then(()=>{
  protocol.handle('camera-media', async request => {
    try {
      const url=new URL(request.url);
      if(url.host!=='asset' || !['GET','HEAD'].includes(request.method))return new Response('Not found',{status:404});
      const token=url.pathname.slice(1),file=mediaTokens.get(token);
      if(!file || !scanRows.has(file) || scanRows.get(file)?.type!=='video')return new Response('Not found',{status:404});
      const stat=await fs.stat(file);
      if(!stat.isFile() || !stat.size)return new Response('Not found',{status:404});
      // Video players request byte ranges. Stream only the requested section,
      // never read an entire gigabyte-sized video into renderer memory.
      let start=0,end=stat.size-1,partial=false;
      const range=request.headers.get('range');
      if(range){
        const matched=/^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if(!matched || (!matched[1]&&!matched[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});
        if(matched[1]){
          start=Number(matched[1]);
          end=matched[2]?Number(matched[2]):stat.size-1;
        }else{
          const suffix=Number(matched[2]);
          start=Math.max(0,stat.size-suffix);
        }
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=stat.size||start<0||end<start){
          return new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});
        }
        end=Math.min(end,stat.size-1);partial=true;
      }
      const mime=path.extname(file).toLowerCase()==='.mov'?'video/quicktime': 'video/mp4';
      const headers={
        'Content-Type':mime,'Accept-Ranges':'bytes',
        'Content-Length':String(end-start+1),'Cache-Control':'no-store'
      };
      if(partial)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      const body=request.method==='HEAD'?null:Readable.toWeb(fssync.createReadStream(file,{start,end}));
      return new Response(body,{status:partial?206:200,headers});
    }catch{return new Response('Unavailable',{status:404});}
  });
  makeWindow();app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)makeWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{cancelled=true;if(exif)void exif.end().catch(()=>{});});
const dialogExtensions=[...PHOTO,...VIDEO].map(x=>x.slice(1));
ipcMain.on('shortcut-settings',(_event,settings)=>{
  if(typeof settings?.recording==='boolean')shortcutRecording=settings.recording;
  if(settings?.shortcuts && typeof settings.shortcuts==='object'){
    const keys={...DEFAULT_KEYS};
    for(const id of Object.keys(DEFAULT_KEYS)){
      const v=settings.shortcuts[id];
      if(typeof v==='string'&&v.length<65)keys[id]=v;
    }
    if(new Set(Object.values(keys)).size===Object.keys(keys).length)activeShortcuts=keys;
  }
});
ipcMain.handle('pick-files',async()=>{
  const r=await dialog.showOpenDialog(win,{properties:['openFile','multiSelections'],filters:[{name:'카메라 사진·영상',extensions:dialogExtensions}]});
  return r.canceled?[]:r.filePaths.map(p=>({path:p,base:''}));
});
ipcMain.handle('pick-folder',async()=>{
  const r=await dialog.showOpenDialog(win,{properties:['openDirectory']});
  if(r.canceled)return [];
  const root=r.filePaths[0],results=[];
  async function visit(dir){
    const children=await fs.readdir(dir,{withFileTypes:true});
    for(const child of children){
      if(results.length>=LIMIT)break;
      if(child.isSymbolicLink())continue;
      const full=path.join(dir,child.name);
      if(child.isDirectory()&&!child.name.startsWith('.'))await visit(full);
      else if(child.isFile()&&supported(full))results.push({path:full,base:root});
    }
  }
  await visit(root);return results;
});
ipcMain.handle('pick-destination',async()=>{
  const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});
  return r.canceled?'':r.filePaths[0];
});
async function inspect(file,base,settings={}){
  try{
    const stat=await fs.stat(file);
    if(!stat.isFile())throw Error('일반 파일이 아닙니다.');
    const tags=await readTags(file);
    const sidecar=kind(file)==='video'?await findSonyXML(file):null;
    const capture=analyzeCapture(tags,kind(file),sidecar,settings);
    const dim=(name)=>Object.entries(tags).find(([key,value])=>key.split(':').at(-1)===name && Number.isFinite(Number(value)))?.[1];
    const rawSize=Object.entries(tags).find(([k,v])=>k.split(':').at(-1)==='ImageSize'&&/^\d+\s*x\s*\d+$/i.test(String(v)))?.[1]||'';
    const ratioWidth=Number(dim('SourceImageWidth')||dim('ImageWidth')||dim('VideoFrameWidth')||rawSize.split(/x/i)[0]);
    const ratioHeight=Number(dim('SourceImageHeight')||dim('ImageHeight')||dim('VideoFrameHeight')||rawSize.split(/x/i)[1]);
    const aspect=ratioWidth>0&&ratioHeight>0&&ratioWidth/ratioHeight<10?ratioWidth/ratioHeight:16/9;
    return {path:file,base,name:path.basename(file),type:kind(file),aspect,bytes:stat.size,mtimeMs:stat.mtimeMs,
      captured:capture.captured,state:capture.state,source:capture.source,note:capture.note||'',
      confidence:capture.confidence,sidecar:sidecar?.path||'', evidence:buildEvidence(tags,kind(file),sidecar,capture), tags,capture, error:''};
  }catch(e){return {path:file,base,name:path.basename(file),type:kind(file),captured:null,state:'error',error:err(e),source:'읽기 실패'};}
}
ipcMain.handle('scan',async(_ev,params)=>{
  if(busy)return fail('현재 다른 작업이 진행 중입니다.');
  const files=params?.files, settings=params?.settings||{};
  if(!Array.isArray(files))return fail('파일 목록이 올바르지 않습니다.');
  const uniq=new Map();
  for(const item of files){
    if(typeof item?.path!=='string'||!supported(item.path))continue;
    const file=path.resolve(item.path);
    if(!uniq.has(file))uniq.set(file,{path:file,base:typeof item.base==='string'?item.base:''});
  }
  if(uniq.size>LIMIT)return fail(`최대 ${LIMIT}개까지만 확인할 수 있습니다.`);
  busy=true;cancelled=false;scanRows=new Map();mediaTokens.clear();mediaTokenForPath.clear();thumbnailCache.clear();let done=0;
  try{
    for(const item of uniq.values()){
      if(cancelled)break;
      const row=await inspect(item.path,item.base,settings);
      scanRows.set(item.path,row);done++;
      const {tags,capture,...safe}=row;
      send('scan-row',{row:safe,done,total:uniq.size});
    }
    return {ok:true,done,total:uniq.size,cancelled};
  } finally {busy=false;cancelled=false;}
});
// Native system thumbnails support many camera RAW formats and movie poster frames.
// When the OS has no decoder for a newer RAW/HEVC file, return no thumbnail
// instead of manufacturing a misleading "current image".
ipcMain.handle('get-media-preview',async(_ev,params)=>{
  const file=params?.file;
  const large=params?.large===true;
  if(typeof file!=='string' || !scanRows.has(file))return fail('먼저 파일을 불러와 주세요.');
  const row=scanRows.get(file);
  const cacheKey=file+'|'+(large?'L':'S');
  const mediaUrl=row.type==='video'?`camera-media://asset/${mediaToken(file)}`:'';
  if(thumbnailCache.has(cacheKey))return {ok:true,thumbnail:thumbnailCache.get(cacheKey),mediaUrl};
  let thumbnail='';
  try {
    const maxWidth=large&&row.type==='photo'?1800:360;
    if(process.platform==='darwin' || process.platform==='win32'){
      const img=await nativeImage.createThumbnailFromPath(file,{width:maxWidth,height:large?1200:240});
      if(img&&!img.isEmpty())thumbnail=img.resize({width:Math.min(maxWidth,img.getSize().width)}).toDataURL();
    }
    if(!thumbnail){
      const img=nativeImage.createFromPath(file);
      if(img&&!img.isEmpty())thumbnail=img.resize({width:Math.min(maxWidth,img.getSize().width)}).toDataURL();
    }
  }catch { /* Unsupported camera/codec thumbnail: preview playback may still work. */ }
  if(thumbnailCache.size>=48)thumbnailCache.delete(thumbnailCache.keys().next().value);
  thumbnailCache.set(cacheKey,thumbnail);
  return {ok:true,thumbnail,mediaUrl};
});
// Stream URL token only: opening a video never waits for costly native thumbnail generation.
ipcMain.handle('get-video-url',(_event,file)=>{
  if(typeof file!=='string'||!scanRows.has(file)||scanRows.get(file)?.type!=='video')return fail('불러온 영상이 아닙니다.');
  return {ok:true,mediaUrl:`camera-media://asset/${mediaToken(file)}`};
});
// Optional fallback for Sony XAVC/HEVC formats not playable in Electron's video engine.
// Only explicitly loaded local media files can be opened with the OS player.
ipcMain.handle('open-media-external',async(_ev,file)=>{
  if(typeof file!=='string' || !scanRows.has(file) || scanRows.get(file)?.type!=='video')return fail('불러온 영상만 열 수 있습니다.');
  try{
    const message=await shell.openPath(file);
    return message?fail(message):{ok:true};
  }catch(e){return fail(err(e));}
});
function firstAnchor(paths){
  for(const file of paths||[]){const row=scanRows.get(file);if(['ready','review'].includes(row?.state) && row.capture?.parts)return formatDate(row.capture.parts);}
  return null;
}
ipcMain.handle('preview',(_ev,params)=>{
  try{
    const options=params?.options||{};
    const anchor=firstAnchor(params?.selected||[])||firstAnchor(params?.paths||[]);
    const effective=options.action==='absolute'?{...options,absoluteAnchor:anchor}:options;
    const previews=[];
    for(const file of (params.paths||[]).slice(0,LIMIT)){
      const row=scanRows.get(file);
      if(!['ready','review'].includes(row?.state) || !row.capture?.parts)continue;
      const plan=makeWritePlan(row.tags,row.type,effective,row.capture);
      if(plan)previews.push({path:file,after:plan.after,tagCount:Object.keys(plan.tags).length});
    }
    return {ok:true,previews};
  }catch(e){return fail(err(e));}
});
async function isExists(file){try{await fs.access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function uniqueOutput(root,row,hasSidecar){
  let relative=row.name;
  if(row.base&&path.isAbsolute(row.base)){
    const rel=path.relative(row.base,row.path);
    if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))relative=rel;
  }
  const desired=path.resolve(root,relative), parsed=path.parse(desired);
  for(let n=0;n<100000;n++){
    const stem=parsed.name+(n?'_'+n:'');
    const output=path.join(parsed.dir,stem+parsed.ext);
    const xml=path.join(parsed.dir,stem+'M01.XML');
    if(!(await isExists(output)) && (!hasSidecar||!(await isExists(xml))))return {output,xml};
  }
  throw Error('저장 파일 이름을 생성할 수 없습니다.');
}
function sameInstant(a,b){
  const ua=utcInstant(a),ub=utcInstant(b);
  if(ua!==null&&ub!==null)return ua===ub;
  return dateToUTC(a)===dateToUTC(b);
}
async function writeFilesystemTimes(file,parts){
  const tool=await getExif();
  const local=`${String(parts.y).padStart(4,'0')}:${String(parts.mo).padStart(2,'0')}:${String(parts.d).padStart(2,'0')} ${String(parts.h).padStart(2,'0')}:${String(parts.mi).padStart(2,'0')}:${String(parts.se).padStart(2,'0')}${parts.tz||''}`;
  // Birth time is OS/filesystem-dependent; report the error instead of pretending success.
  await tool.write(file,{FileModifyDate:local,FileCreateDate:local},{writeArgs:['-api','LargeFileSupport=1','-overwrite_original_in_place']});
}
ipcMain.handle('apply',async(_ev,params)=>{
  if(busy)return fail('다른 작업이 진행 중입니다.');
  const {paths,options={},mode,outputDir,reviewApprovedPaths=[]}=params||{};
  const approved=new Set(Array.isArray(reviewApprovedPaths)?reviewApprovedPaths:[]);
  if(!Array.isArray(paths)||!paths.length||paths.length>LIMIT)return fail('적용할 파일을 선택하세요.');
  if(!['copy','original'].includes(mode))return fail('저장 방식을 선택하세요.');
  if(mode==='copy'&&(!outputDir||!path.isAbsolute(outputDir)))return fail('복사본 저장 폴더를 선택하세요.');
  if(mode==='original'){
    const c=await dialog.showMessageBox(win,{type:'warning',title:'원본 파일 직접 수정',
      message:'원본 파일과 Sony XML까지 직접 수정하시겠습니까?',
      detail:'원본 변경은 취소해도 이전 상태로 자동 복구되지 않습니다. 복사본으로 먼저 검증하는 것을 권장합니다.',
      buttons:['취소','원본 직접 수정'],defaultId:0,cancelId:0,noLink:true});
    if(c.response!==1)return fail('작업을 취소했습니다.');
  }
  const selected=[...new Set(paths)];
  const anchor=firstAnchor(selected);
  const effective=options.action==='absolute'?{...options,absoluteAnchor:anchor}:options;
  busy=true;cancelled=false;lastReport=[];
  let success=0,skipped=0,failure=0,completed=0;
  try{
    for(const file of selected){
      if(cancelled)break;
      const row=scanRows.get(file);
      const outcome={file,output:'',before:row?.captured||'',after:'',source:row?.source||'',status:'실패',message:''};
      let dest='',destXml='',copied=false,xmlCopied=false;
      try{
        if(!row)throw Error('파일을 다시 불러오세요.');
        if(row.state!=='ready'&&!(row.state==='review'&&approved.has(file)&&row.capture?.parts)){
          skipped++;outcome.status='건너뜀';outcome.message=row.state==='review'?'시간대 확인 후 수동 선택 필요':row.state==='missing'?'촬영일 미확인':row.error;
        }else{
          const stat=await fs.stat(file);
          if(stat.size!==row.bytes||Math.abs(stat.mtimeMs-row.mtimeMs)>5)throw Error('읽기 이후 파일이 변경됐습니다. 다시 불러오세요.');
          const fresh=await readTags(file);
          const sidecar=row.type==='video'?await findSonyXML(file):null;
          const current=analyzeCapture(fresh,row.type,sidecar,options);
          if(current.state!=='ready'&&!(current.state==='review'&&approved.has(file)&&current.parts))throw Error('촬영 시간대 확인이 필요합니다. 날짜 변경 탭에서 파일별로 승인해 주세요.');
          const plan=makeWritePlan(fresh,row.type,effective,current);
          if(!plan||!Object.keys(plan.tags).length){skipped++;outcome.status='건너뜀';outcome.message='수정할 메타데이터 날짜가 없습니다.';}
          else{
            if(mode==='copy'){
              const destPair=await uniqueOutput(outputDir,row,!!sidecar);
              dest=destPair.output;
              await fs.mkdir(path.dirname(dest),{recursive:true});
              await fs.copyFile(file,dest,fssync.constants.COPYFILE_EXCL);copied=true;
              if(sidecar){destXml=destPair.xml;await fs.copyFile(sidecar.path,destXml,fssync.constants.COPYFILE_EXCL);xmlCopied=true;}
            }else{dest=file;destXml=sidecar?.path||'';}
            const tool=await getExif();
            await tool.write(dest,plan.tags,{writeArgs:['-api','LargeFileSupport=1','-P','-overwrite_original_in_place','-wm','w']});
            if(sidecar && destXml){
              const xmlNew=shiftSonyXML(sidecar.text,effective,parseDate(anchor)||current.parts);
              // Keep the Sony recording relationship intact: modify only CreationDate, not camera IDs/UMID.
              await fs.writeFile(destXml,xmlNew,'utf8');
            }
            const warnings=[];
            if(options.filesystemDates){
              try{await writeFilesystemTimes(dest,plan.afterParts);}catch(e){warnings.push('파일 생성/수정일 변경 제한: '+err(e));}
            }
            const verifiedTags=await readTags(dest);
            const verifiedXML=destXml?await findSonyXML(dest):null;
            const actual=analyzeCapture(verifiedTags,row.type,verifiedXML,options);
            if(!actual.parts||!sameInstant(actual.parts,plan.afterParts))throw Error(`수정 후 촬영일 불일치: 예상 ${plan.after} / 실제 ${actual.captured||'미확인'}`);
            const afterFields=dateFields(verifiedTags,row.type);
            for(const [tag,expected] of Object.entries(plan.tags)){
              const changed=afterFields.find(x=>x.writeTag===tag);
              if(!changed||dateToUTC(changed.parts)!==dateToUTC(parseDate(expected)))throw Error(`변경 후 내부 날짜 필드 확인 실패: ${tag}`);
            }
            outcome.status='완료';outcome.output=dest;outcome.after=actual.captured;
            outcome.message=`날짜 필드 ${Object.keys(plan.tags).length}개, XML ${sidecar?'함께 변경':'없음'}${warnings.length?'; '+warnings.join('; '):''}`;
            success++;
            if(mode==='original')scanRows.set(file,await inspect(file,row.base,options));
          }
        }
      }catch(e){failure++;outcome.status='실패';outcome.message=err(e);
        if(mode==='copy'){
          if(copied&&dest)try{await fs.unlink(dest);}catch{}
          if(xmlCopied&&destXml)try{await fs.unlink(destXml);}catch{}
        }
      }
      lastReport.push(outcome);completed++;
      send('apply-row',{...outcome,done:completed,total:selected.length});
    }
    return {ok:true,success,skipped,failure,completed,total:selected.length,cancelled};
  }catch(e){return fail(err(e));}
  finally{busy=false;cancelled=false;}
});
ipcMain.on('cancel',()=>{cancelled=true;});
ipcMain.handle('save-csv',async()=>{
  if(!lastReport.length)return fail('내보낼 기록이 없습니다.');
  const r=await dialog.showSaveDialog(win,{title:'처리 결과 저장',defaultPath:'Camera-DateShift-결과.csv',filters:[{name:'CSV',extensions:['csv']}]});
  if(r.canceled)return fail('취소되었습니다.');
  const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const headers=['원본 경로','저장 경로','원래 촬영일시','변경 촬영일시','판정 근거','상태','메시지'];
  const keys=['file','output','before','after','source','status','message'];
  await fs.writeFile(r.filePath,'\ufeff'+[headers.map(quote).join(','),...lastReport.map(x=>keys.map(k=>quote(x[k])).join(','))].join('\r\n'),'utf8');
  return {ok:true,path:r.filePath};
});
