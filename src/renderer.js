'use strict';
// Camera DateShift v1.0.0 — preview + selective editing UI.
// Metadata extraction, date calculations, validation and save logic live in main.js.
const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const tabs = ['files', 'time', 'save', 'keys'];
const defaults = {
  openFiles:'Mod+O', openFolder:'Mod+Shift+O', nextTab:'Mod+Alt+ArrowRight',
  prevTab:'Mod+Alt+ArrowLeft', apply:'Mod+Enter', search:'Mod+F',
  viewer:'Space', nextFile:'ArrowRight', prevFile:'ArrowLeft'
};
const mac = navigator.platform.toLowerCase().includes('mac');
const state = {
  queue:[],files:[],selected:new Set(),previews:new Map(),
  filter:'all',query:'',page:0,pageSize:4,activePath:'',
  timeFilter:'all',timeQuery:'',timePage:0,timePageSize:4,
  thumbnailCache:new Map(),thumbnailPending:new Map(),
  running:false,outputDir:'',tab:'files',shortcuts:{...defaults},recording:'',
  results:[],hasResult:false,viewerOpen:false,viewerRequest:0,mediaRequest:0
};
const el = (tag,cls='',value) => {
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(value!==undefined)node.textContent=value;
  return node;
};
const size = n => n>=1024**3?(n/1024**3).toFixed(2)+' GB':
  n>=1024**2?(n/1024**2).toFixed(1)+' MB':`${Math.ceil((n||0)/1024)} KB`;
const labels={ready:'수정 가능',review:'시간대 확인',missing:'촬영일 없음',error:'읽기 오류'};
function statusPill(row){
  const node=el('span','pill '+(row.state==='ready'?'':row.state),labels[row.state]||row.state);
  node.title=row.note||row.error||'';
  return node;
}
function settings(){
  return {
    action:$('input[name="action"]:checked').value,
    direction:$('input[name="direction"]:checked').value,
    amount:Object.fromEntries($$('[data-unit]').map(x=>[x.dataset.unit,Number(x.value)])),
    absolute:$('#absoluteInput').value,
    filesystemDates:$('#filesystemDates').checked,
    timeMode:$('#timeMode').value
  };
}
function chosenRows(){return state.files.filter(r=>r.state==='ready'&&state.selected.has(r.path));}
function filteredFiles(){return state.files.filter(r=>(state.filter==='all'||r.state===state.filter)&&(!state.query||r.path.toLowerCase().includes(state.query.toLowerCase())));}
function filteredTime(){return state.files.filter(r=>{
  const meets=state.timeFilter==='all'||r.state===state.timeFilter||
    (state.timeFilter==='needs-check'&&['review','missing'].includes(r.state));
  return meets&&(!state.timeQuery||r.path.toLowerCase().includes(state.timeQuery.toLowerCase()));
});}
function openTab(tab){
  if(!tabs.includes(tab))return;
  if(state.viewerOpen)closeViewer();
  state.tab=tab;
  $$('.stage').forEach(btn=>{
    const active=btn.dataset.tab===tab;
    btn.classList.toggle('active',active);btn.setAttribute('aria-selected',String(active));
  });
  $$('.tab-panel').forEach(panel=>{
    const active=panel.id===`panel-${tab}`;
    panel.hidden=!active;panel.classList.toggle('is-active',active);
  });
  updateStats();
  if(tab==='files')requestAnimationFrame(()=>{adjustPageSize();showSidePreview();});
  if(tab==='time')requestAnimationFrame(()=>{adjustTimePageSize();renderTimeRows();});
}
function setRunning(running){
  state.running=running;
  for(const id of ['pickFiles','pickFolder','clearAll','pickDestination','timeMode','resetKeys','selectAllReady','deselectAll'])$('#'+id).disabled=running;
  $('#cancel').hidden=!running;
  updateApply();renderTimeRows();
}
function updateApply(){
  const mode=$('input[name="saveMode"]:checked').value;
  $('#destinationRow').hidden=mode!=='copy';
  const count=chosenRows().length;
  $('#countChecked').textContent=String(count);
  $('#timeSelection').textContent=`${count}개 파일 선택`;
  $('#saveSelection').textContent=`${count}개 파일 선택됨`;
  $('#saveSummaryCount').textContent=`${count}개`;
  $('#timeCount').textContent=`수정 가능 ${state.files.filter(x=>x.state==='ready').length}개 · 선택 ${count}개`;
  const opt=settings();
  const formatted=Object.entries({년:opt.amount.years,월:opt.amount.months,일:opt.amount.days,시:opt.amount.hours,분:opt.amount.minutes,초:opt.amount.seconds})
    .filter(([,n])=>n>0).map(([u,n])=>`${n}${u}`).join(' ');
  $('#saveSummaryMode').textContent=opt.action==='absolute'?'기준 날짜에 맞춰 이동':
    (formatted?`${opt.direction==='earlier'?'과거':'미래'}로 ${formatted}`:'이동 없음');
  $('#apply').disabled=state.running||!count||(mode==='copy'&&!state.outputDir);
}
function updateStats(){
  $('#countAll').textContent=String(state.files.length);
  for(const status of ['ready','review','missing','error'])$('#count'+status[0].toUpperCase()+status.slice(1)).textContent=String(state.files.filter(x=>x.state===status).length);
  updateApply();
}
function parseDisplayDate(raw){
  if(!raw||raw==='계산 중…')return {day:raw||'—',clock:'—'};
  const text=String(raw).trim().replace(/^(\d{4}):(\d{2}):(\d{2}) /,'$1-$2-$3 ').replace('T',' ');
  const match=text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if(!match)return {day:text,clock:''};
  return {day:match[1],clock:match[2]+(match[3]?' '+match[3]:'')};
}
function dateCell(value,after=false){
  const parts=parseDisplayDate(value);
  const node=el('div','date-value'+(after?' after':''));
  node.append(el('span','day',parts.day),el('span','clock',parts.clock));
  node.title=value||'';
  return node;
}
function ensureActive(){
  const arr=filteredFiles();
  if(!arr.some(r=>r.path===state.activePath))state.activePath=arr[0]?.path||'';
  return arr.find(r=>r.path===state.activePath)||null;
}
function activeRow(){return state.files.find(r=>r.path===state.activePath)||null;}
async function loadThumbnail(path,large=false){
  const key=path+'|'+(large?'L':'S');
  if(state.thumbnailCache.has(key))return state.thumbnailCache.get(key);
  if(state.thumbnailPending.has(key))return state.thumbnailPending.get(key);
  const promise=window.dateshift.getMediaPreview(path,large).catch(e=>({ok:false,error:e.message})).then(result=>{
    state.thumbnailPending.delete(key);
    if(state.files.some(r=>r.path===path)){
      if(state.thumbnailCache.size>200)state.thumbnailCache.delete(state.thumbnailCache.keys().next().value);
      state.thumbnailCache.set(key,result);
    }
    return result;
  });
  state.thumbnailPending.set(key,promise);
  return promise;
}
function imageFor(row,className){
  const wrap=el('span',className);
  wrap.append(el('span','media-fallback',row.type==='video'?'▶':'▧'));
  void loadThumbnail(row.path).then(result=>{
    if(!wrap.isConnected||!result?.thumbnail)return;
    const img=el('img');img.alt=row.name+' 썸네일';img.src=result.thumbnail;
    wrap.replaceChildren(img);
  });
  return wrap;
}
function renderFileRows(){
  const all=filteredFiles();
  ensureActive();
  const pages=Math.max(1,Math.ceil(all.length/state.pageSize));
  state.page=Math.max(0,Math.min(state.page,pages-1));
  const start=state.page*state.pageSize;
  const list=$('#fileRows');list.replaceChildren();
  if(!all.length)list.append(el('div','file-empty',state.files.length?'조건에 맞는 파일이 없습니다.':'파일을 불러오면 목록과 현재 모습이 나타납니다.'));
  for(const row of all.slice(start,start+state.pageSize)){
    const button=el('button','file-item'+(row.path===state.activePath?' active':''));
    button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected',String(row.path===state.activePath));
    button.append(imageFor(row,'file-thumb'));
    const caption=el('span','file-item-caption');
    caption.append(el('strong','file-name',row.name),el('small','file-secondary',`${row.type==='photo'?'사진':'영상'} · ${size(row.bytes)} · ${row.source||'근거 없음'}`));
    const meta=el('span','file-item-meta');meta.append(dateCell(row.captured||'—'),statusPill(row));
    button.append(caption,meta);
    button.title=row.path+'\n'+(row.note||row.error||'');
    button.addEventListener('click',()=>setActiveFile(row.path));
    button.addEventListener('dblclick',()=>openViewer());
    list.append(button);
  }
  $('#shownCount').textContent=all.length?`${all.length}개 중 ${start+1}–${Math.min(start+state.pageSize,all.length)}개 표시`:'표시할 파일이 없습니다.';
  $('#pageLabel').textContent=`${state.page+1} / ${pages}`;
  $('#prevPage').disabled=state.page===0;
  $('#nextPage').disabled=state.page>=pages-1;
}
function renderTimeRows(){
  const all=filteredTime();
  const pages=Math.max(1,Math.ceil(all.length/state.timePageSize));
  state.timePage=Math.max(0,Math.min(state.timePage,pages-1));
  const start=state.timePage*state.timePageSize;
  const tbody=$('#timeRows');tbody.replaceChildren();
  if(!all.length){const tr=el('tr'),td=el('td','empty',state.files.length?'조건에 맞는 파일이 없습니다.':'파일 확인 탭에서 촬영 파일을 불러오세요.');td.colSpan=5;tr.append(td);tbody.append(tr);}
  for(const row of all.slice(start,start+state.timePageSize)){
    const tr=el('tr','time-row'+(state.selected.has(row.path)?' chosen':''));
    const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=state.selected.has(row.path);
    checkbox.disabled=state.running||row.state!=='ready';checkbox.setAttribute('aria-label',`${row.name} 변경 대상 선택`);
    checkbox.addEventListener('change',()=>{
      if(checkbox.checked)state.selected.add(row.path);else state.selected.delete(row.path);
      updateApply();renderTimeRows();
      if(settings().action==='absolute')schedulePreview();
    });
    let td=el('td');td.append(checkbox);tr.append(td);
    td=el('td');
    const nameWrap=el('div','time-name-wrap');nameWrap.append(imageFor(row,'time-thumb'));
    const infos=el('div','time-name-caption');infos.append(el('strong','file-name',row.name),el('small','file-secondary',`${row.type==='photo'?'사진':'영상'} · ${row.source||'촬영 근거 없음'}`));
    nameWrap.append(infos);td.append(nameWrap);td.title=row.path;tr.append(td);
    td=el('td');td.append(dateCell(row.captured||'—'));tr.append(td);
    td=el('td');td.append(dateCell(row.state==='ready'?(state.previews.get(row.path)||'계산 중…'):'—',true));tr.append(td);
    td=el('td');td.append(statusPill(row));tr.append(td);
    tbody.append(tr);
  }
  $('#timeShownCount').textContent=all.length?`${all.length}개 중 ${start+1}–${Math.min(start+state.timePageSize,all.length)}개 표시`:'표시할 파일이 없습니다.';
  $('#timePageLabel').textContent=`${state.timePage+1} / ${pages}`;
  $('#timePrev').disabled=state.timePage===0;$('#timeNext').disabled=state.timePage>=pages-1;
}
function adjustPageSize(){
  if(state.tab!=='files')return;
  const area=$('#tableSpace');if(!area.clientHeight)return;
  const n=Math.max(1,Math.min(28,Math.floor((area.clientHeight-6)/74)));
  if(n!==state.pageSize){state.pageSize=n;state.page=0;renderFileRows();}
}
function adjustTimePageSize(){
  if(state.tab!=='time')return;
  const area=$('#timeTableSpace');if(!area.clientHeight)return;
  const n=Math.max(1,Math.min(28,Math.floor((area.clientHeight-45)/75)));
  if(n!==state.timePageSize){state.timePageSize=n;state.timePage=0;renderTimeRows();}
}
function setActiveFile(path){
  if(!state.files.some(r=>r.path===path))return;
  state.activePath=path;
  const all=filteredFiles();const index=all.findIndex(r=>r.path===path);
  if(index>=0)state.page=Math.floor(index/state.pageSize);
  renderFileRows();showSidePreview();
  if(state.viewerOpen)void showViewerContent();
}
function moveFile(step){
  const all=filteredFiles();if(!all.length)return;
  const index=all.findIndex(r=>r.path===state.activePath);
  const next=index<0?0:Math.max(0,Math.min(all.length-1,index+step));
  setActiveFile(all[next].path);
}
function fillMediaArea(container,row,result,large=false){
  container.replaceChildren();
  if(result?.thumbnail){const img=el('img','media-image');img.src=result.thumbnail;img.alt=row.name+' 미리보기';container.append(img);return;}
  container.append(el('div','media-placeholder',row.type==='video'?
    '이 영상의 썸네일을 만들 수 없습니다. Space를 눌러 재생을 시도하세요.':
    '미리보기 이미지를 사용할 수 없습니다. OS의 RAW 코덱/썸네일 지원을 확인하세요.'));
}
async function showSidePreview(){
  const row=ensureActive(),seq=++state.mediaRequest;
  $('#fileMediaName').textContent=row?.name||'선택된 파일 없음';
  $('#fileMediaDetails').textContent=row?`${row.type==='photo'?'사진':'영상'} · ${size(row.bytes)}`:'목록에서 파일 하나를 클릭하세요.';
  $('#fileMediaDate').textContent=row?.captured||'촬영일 미확인';
  $('#fileMediaSource').textContent=row?(row.source||'근거 없음')+(row.note?' · '+row.note:''):'파일의 내장 촬영 정보와 동반 XML을 확인합니다.';
  $('#openViewer').disabled=!row;
  $('#previousMedia').disabled=!row||filteredFiles()[0]?.path===row.path;
  $('#nextMedia').disabled=!row||filteredFiles().at(-1)?.path===row.path;
  $('#fileMedia').replaceChildren(el('div','media-placeholder',row?'미리보기 준비 중…':'파일을 선택하면 사진·영상의 현재 모습을 보여줍니다.'));
  if(!row)return;
  const result=await loadThumbnail(row.path);
  if(seq!==state.mediaRequest||state.tab!=='files'||state.activePath!==row.path)return;
  fillMediaArea($('#fileMedia'),row,result);
}
function openViewer(){
  const row=ensureActive();if(!row)return;
  state.viewerOpen=true;
  $('#viewerOverlay').hidden=false;
  $('#viewerClose').focus();
  void showViewerContent();
}
function closeViewer(){
  state.viewerOpen=false;state.viewerRequest++;
  $('#viewerOverlay').hidden=true;
  const video=$('#viewerStage video');if(video){video.pause();video.removeAttribute('src');video.load();}
  $('#viewerStage').replaceChildren();
  if(state.tab==='files')$('#openViewer').focus();
}
async function showViewerContent(){
  const row=activeRow();if(!row||!state.viewerOpen)return;
  const request=++state.viewerRequest;
  const all=filteredFiles(),index=all.findIndex(x=>x.path===row.path);
  $('#viewerName').textContent=row.name;
  $('#viewerPosition').textContent=`${index+1} / ${all.length} · ${row.type==='photo'?'사진':'영상'}`;
  $('#viewerCapture').textContent=`원본 촬영일시: ${row.captured||'미확인'} · ${row.source||'근거 없음'}`;
  $('#viewerPrev').disabled=index<=0;$('#viewerNext').disabled=index>=all.length-1;
  const stage=$('#viewerStage');const oldVideo=stage.querySelector('video');if(oldVideo)oldVideo.pause();
  stage.replaceChildren(el('div','media-placeholder','미리보기 준비 중…'));
  const result=await loadThumbnail(row.path,row.type==='photo');
  if(!state.viewerOpen||request!==state.viewerRequest||row.path!==state.activePath)return;
  stage.replaceChildren();
  if(row.type==='video'&&result?.mediaUrl){
    const v=el('video','viewer-video');v.controls=true;v.preload='metadata';v.playsInline=true;
    if(result.thumbnail)v.poster=result.thumbnail;
    v.src=result.mediaUrl;
    v.addEventListener('error',()=>{
      if(!state.viewerOpen||request!==state.viewerRequest)return;
      v.remove();fillMediaArea(stage,row,result,true);
      const note=el('div','video-warning','이 코덱은 프로그램 내부 재생이 제한될 수 있습니다. 원본은 변경되지 않았습니다.');stage.append(note);
      const external=el('button','btn btn-primary viewer-external','기본 영상 앱으로 열기');
      external.type='button';
      external.addEventListener('click',async()=>{
        const response=await window.dateshift.openMediaExternally(row.path);
        if(!response.ok)alert(response.error);
      });
      stage.append(external);
    },{once:true});
    stage.append(v);
  }else if(result?.thumbnail){
    const img=el('img','viewer-image');img.src=result.thumbnail;img.alt=row.name+' 크게 보기';stage.append(img);
  }else fillMediaArea(stage,row,result,true);
}
let paintTimer;
function paint(){
  if(paintTimer)return;
  paintTimer=setTimeout(()=>{
    paintTimer=null;updateStats();renderFileRows();renderTimeRows();
    if(state.tab==='files')showSidePreview();
  },90);
}
let previewTimer,previewSeq=0;
function schedulePreview(){
  clearTimeout(previewTimer);
  const seq=++previewSeq;
  previewTimer=setTimeout(async()=>{
    if(state.running)return;
    const paths=state.files.filter(r=>r.state==='ready').map(r=>r.path);
    if(!paths.length){state.previews.clear();renderTimeRows();return;}
    try{
      const result=await window.dateshift.preview(paths,chosenRows().map(r=>r.path),settings());
      if(seq!==previewSeq)return;
      if(!result.ok)throw Error(result.error);
      state.previews=new Map(result.previews.map(x=>[x.path,x.after]));
      renderTimeRows();updateApply();
      $('#scanStatus').textContent=`${state.files.length}개 분석됨 · ${chosenRows().length}개 선택됨`;
    }catch(e){if(seq===previewSeq)$('#scanStatus').textContent=`날짜 미리보기 오류: ${e.message}`;}
  },170);
}
async function scanFiles(){
  if(state.running||!state.queue.length)return;
  if(state.viewerOpen)closeViewer();
  state.files=[];state.selected.clear();state.previews.clear();state.page=0;state.timePage=0;state.activePath='';
  state.thumbnailCache.clear();state.thumbnailPending.clear();state.mediaRequest++;state.viewerRequest++;
  ++previewSeq;clearTimeout(previewTimer);
  setRunning(true);state.hasResult=false;$('#resultBox').hidden=true;$('#resultEmpty').hidden=false;$('#saveCsv').disabled=true;
  $('#scanStatus').textContent=`메타데이터 분석 중 · 0 / ${state.queue.length}`;
  updateStats();renderFileRows();renderTimeRows();showSidePreview();
  try{
    const result=await window.dateshift.scan(state.queue,{timeMode:$('#timeMode').value});
    if(!result.ok)throw Error(result.error);
    $('#scanStatus').textContent=`분석 완료 ${result.done}개 · 확인 필요 ${state.files.filter(x=>x.state==='review').length}개${result.cancelled?' · 중단됨':''}`;
  }catch(e){$('#scanStatus').textContent='분석 오류: '+e.message;}
  finally{setRunning(false);updateStats();renderFileRows();renderTimeRows();showSidePreview();schedulePreview();}
}
window.dateshift.onScanRow(({row,done,total})=>{
  state.files.push(row);
  if(!state.activePath)state.activePath=row.path;
  // 안전한 기본값: 사용자가 날짜 변경 탭에서 선택하기 전에는 아무 파일도 변경하지 않음.
  $('#scanStatus').textContent=`촬영일시 확인 중 · ${done} / ${total}`;
  paint();
});
window.dateshift.onApplyRow(row=>{
  state.results.push(`[${row.status}] ${row.file.split(/[\\/]/).at(-1)}${row.after?' → '+row.after:''}${row.message?' · '+row.message:''}`);
  $('#resultDetails').textContent=state.results.slice(-4).join('\n');
  $('#resultHeadline').textContent=`작업 중 ${row.done} / ${row.total}`;
  $('#scanStatus').textContent=`촬영일시 변경 중 · ${row.done} / ${row.total}`;
});
async function add(items){
  if(state.running||!items?.length)return;
  state.queue=[...new Map([...state.queue,...items].filter(x=>x?.path).map(x=>[x.path,x])).values()];
  openTab('files');await scanFiles();
}
async function openFiles(){if(state.running)return;try{await add(await window.dateshift.pickFiles());}catch(e){alert(e.message);}}
async function openFolder(){if(state.running)return;try{await add(await window.dateshift.pickFolder());}catch(e){alert(e.message);}}
$('#pickFiles').addEventListener('click',openFiles);
$('#pickFolder').addEventListener('click',openFolder);
$('#clearAll').addEventListener('click',()=>{
  if(state.running)return;
  if(state.viewerOpen)closeViewer();
  state.queue=[];state.files=[];state.selected.clear();state.previews.clear();state.page=0;state.timePage=0;state.activePath='';
  state.thumbnailCache.clear();state.thumbnailPending.clear();
  $('#scanStatus').textContent='촬영 파일을 불러와 주세요.';
  state.hasResult=false;$('#resultBox').hidden=true;$('#resultEmpty').hidden=false;$('#saveCsv').disabled=true;
  updateStats();renderFileRows();renderTimeRows();showSidePreview();
});
$('#pickDestination').addEventListener('click',async()=>{
  const folder=await window.dateshift.pickDestination();
  if(folder){state.outputDir=folder;$('#destination').textContent=folder;$('#destination').title=folder;}
  updateApply();
});
$('#cancel').addEventListener('click',()=>{window.dateshift.cancel();$('#scanStatus').textContent='현재 파일을 마친 뒤 중단합니다.';});
$$('input[name="saveMode"]').forEach(x=>x.addEventListener('change',updateApply));
$$('input[name="action"]').forEach(x=>x.addEventListener('change',()=>{
  $('#shiftControls').hidden=settings().action!=='shift';
  $('#absoluteControls').hidden=settings().action==='shift';updateApply();schedulePreview();
}));
$$('input[name="direction"], [data-unit]').forEach(x=>x.addEventListener('input',()=>{updateApply();schedulePreview();}));
$('#absoluteInput').addEventListener('input',()=>{updateApply();schedulePreview();});
$('#timeMode').addEventListener('change',()=>{if(state.queue.length)void scanFiles();});
$$('.file-filter').forEach(btn=>btn.addEventListener('click',()=>{
  state.filter=btn.dataset.filter;state.page=0;
  $$('.file-filter').forEach(b=>b.classList.toggle('active',b===btn));
  renderFileRows();showSidePreview();
}));
$$('.time-filter').forEach(btn=>btn.addEventListener('click',()=>{
  state.timeFilter=btn.dataset.filter;state.timePage=0;
  $$('.time-filter').forEach(b=>b.classList.toggle('active',b===btn));renderTimeRows();
}));
$('#search').addEventListener('input',e=>{state.query=e.target.value;state.page=0;renderFileRows();showSidePreview();});
$('#timeSearch').addEventListener('input',e=>{state.timeQuery=e.target.value;state.timePage=0;renderTimeRows();});
$('#prevPage').addEventListener('click',()=>{state.page=Math.max(0,state.page-1);renderFileRows();});
$('#nextPage').addEventListener('click',()=>{state.page++;renderFileRows();});
$('#timePrev').addEventListener('click',()=>{state.timePage=Math.max(0,state.timePage-1);renderTimeRows();});
$('#timeNext').addEventListener('click',()=>{state.timePage++;renderTimeRows();});
$('#selectAllReady').addEventListener('click',()=>{
  for(const row of state.files)if(row.state==='ready')state.selected.add(row.path);
  updateApply();renderTimeRows();if(settings().action==='absolute')schedulePreview();
});
$('#deselectAll').addEventListener('click',()=>{
  state.selected.clear();updateApply();renderTimeRows();if(settings().action==='absolute')schedulePreview();
});
$('#previousMedia').addEventListener('click',()=>moveFile(-1));
$('#nextMedia').addEventListener('click',()=>moveFile(1));
$('#openViewer').addEventListener('click',openViewer);
$('#viewerClose').addEventListener('click',closeViewer);
$('#viewerPrev').addEventListener('click',()=>moveFile(-1));
$('#viewerNext').addEventListener('click',()=>moveFile(1));
$('#dropzone').addEventListener('dragover',e=>{e.preventDefault();$('#dropzone').classList.add('dragover');});
$('#dropzone').addEventListener('dragleave',()=>$('#dropzone').classList.remove('dragover'));
$('#dropzone').addEventListener('drop',async e=>{
  e.preventDefault();$('#dropzone').classList.remove('dragover');
  try{await add(window.dateshift.fromDroppedFiles([...e.dataTransfer.files]));}catch(err){alert(err.message);}
});
$('#dropzone').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();void openFiles();}});
async function applyChanges(){
  if(state.running)return;
  const chosen=chosenRows().map(r=>r.path);
  if(!chosen.length){openTab('time');alert('날짜 변경 탭에서 수정할 파일을 체크하세요.');return;}
  const options=settings();
  if(options.action==='shift'&&!Object.values(options.amount).some(n=>Number.isInteger(n)&&n>0)){
    openTab('time');alert('시간 이동 값을 입력해 주세요.');return;
  }
  if(options.action==='shift'&&Object.values(options.amount).some(n=>!Number.isSafeInteger(n)||n<0||n>9999)){
    openTab('time');alert('각 이동 값은 0~9999 사이의 정수여야 합니다.');return;
  }
  const mode=$('input[name="saveMode"]:checked').value;
  if(mode==='copy'&&!state.outputDir){openTab('save');alert('복사본 저장 폴더를 선택하세요.');return;}
  openTab('save');setRunning(true);state.results=[];state.hasResult=true;
  $('#resultBox').hidden=false;$('#resultEmpty').hidden=true;
  $('#resultHeadline').textContent='작업 처리 중';$('#resultDetails').textContent='파일별 적용 결과를 확인하고 있습니다.';
  try{
    const result=await window.dateshift.apply(chosen,options,mode,state.outputDir);
    if(!result.ok){$('#resultHeadline').textContent='적용하지 않음';$('#resultDetails').textContent=result.error;return;}
    $('#resultHeadline').textContent=`완료 ${result.success} · 건너뜀 ${result.skipped} · 실패 ${result.failure}`;
    $('#scanStatus').textContent=`작업 종료 · ${result.completed} / ${result.total}개${result.cancelled?' · 중단됨':''}`;
    $('#saveCsv').disabled=!result.completed;
    if(mode==='original'&&result.success)$('#resultDetails').textContent+='\n원본 파일이 변경되었습니다. 다시 불러와 확인하세요.';
  }catch(e){$('#resultHeadline').textContent='작업 실패';$('#resultDetails').textContent=e.message;}
  finally{setRunning(false);}
}
$('#apply').addEventListener('click',applyChanges);
$('#saveCsv').addEventListener('click',async()=>{
  try{const result=await window.dateshift.saveCsv();
    if(result.ok)$('#scanStatus').textContent='CSV 저장 완료: '+result.path;
    else if(result.error!=='취소되었습니다.')alert(result.error);
  }catch(e){alert(e.message);}
});
$$('.stage').forEach(btn=>btn.addEventListener('click',()=>openTab(btn.dataset.tab)));
$('#goTime').addEventListener('click',()=>openTab('time'));
$('#goSave').addEventListener('click',()=>openTab('save'));
$('#goFiles').addEventListener('click',()=>openTab('files'));
$('#goHome').addEventListener('click',()=>openTab('files'));
// Local, editable shortcuts. Space/arrow keys work only when not typing and app is focused.
function friendlyShortcut(value){
  return (value||'설정 안 됨').split('+').map(key=>{
    if(key==='Mod')return mac?'⌘':'Ctrl';
    if(key==='Alt')return mac?'⌥':'Alt';
    if(key==='Shift')return mac?'⇧':'Shift';
    if(key==='Space')return 'Space';
    return {ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓'}[key]||key;
  }).join(' + ');
}
function shortcutFromEvent(e){
  const parts=[];
  if(mac?e.metaKey:e.ctrlKey)parts.push('Mod');
  if(e.altKey)parts.push('Alt');if(e.shiftKey)parts.push('Shift');
  let key='';
  if(/^Key[A-Z]$/.test(e.code))key=e.code.slice(3);
  else if(/^Digit[0-9]$/.test(e.code))key=e.code.slice(5);
  else if(['Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(e.code))key=e.code;
  if(!key)return '';
  if(!parts.length&&!['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return '';
  return [...parts,key].join('+');
}
function paintShortcuts(){
  $$('.key-button').forEach(btn=>{
    btn.classList.toggle('recording',state.recording===btn.dataset.shortcut);
    btn.textContent=state.recording===btn.dataset.shortcut?'새 키 입력…':friendlyShortcut(state.shortcuts[btn.dataset.shortcut]);
  });
}
function saveShortcuts(){
  try{localStorage.setItem('camera-dateshift-shortcuts-v1',JSON.stringify(state.shortcuts));}
  catch{$('#shortcutHelp').textContent='저장이 제한된 환경입니다. 현재 실행 중에는 단축키가 적용됩니다.';}
}
function loadShortcuts(){
  try{
    const saved=JSON.parse(localStorage.getItem('camera-dateshift-shortcuts-v1')||'null');
    if(saved&&typeof saved==='object'){
      const values={...defaults};
      for(const id of Object.keys(defaults))if(typeof saved[id]==='string'&&saved[id].length<60)values[id]=saved[id];
      if(new Set(Object.values(values)).size===Object.values(values).length)state.shortcuts=values;
    }
  }catch{/* 손상된 단축키 설정은 기본값 사용 */}
  paintShortcuts();
}
function shortcutAction(id){
  if(id==='openFiles')void openFiles();
  else if(id==='openFolder')void openFolder();
  else if(id==='nextTab')openTab(tabs[(tabs.indexOf(state.tab)+1)%tabs.length]);
  else if(id==='prevTab')openTab(tabs[(tabs.indexOf(state.tab)+tabs.length-1)%tabs.length]);
  else if(id==='search'){openTab('files');$('#search').focus();$('#search').select();}
  else if(id==='viewer'){
    if(state.viewerOpen)closeViewer();else if(state.tab==='files')openViewer();
  }else if(id==='nextFile'){
    if(state.tab==='files'||state.viewerOpen)moveFile(1);
  }else if(id==='prevFile'){
    if(state.tab==='files'||state.viewerOpen)moveFile(-1);
  }else if(id==='apply'){
    if(state.tab!=='save'){openTab('save');$('#scanStatus').textContent='저장 설정을 확인한 후 실행하세요.';}
    else if(!$('#apply').disabled)void applyChanges();
  }
}
$$('.key-button').forEach(btn=>btn.addEventListener('click',()=>{
  state.recording=btn.dataset.shortcut;
  $('#shortcutHelp').textContent='원하는 키를 누르세요. Space/방향키는 단독으로도 지정할 수 있습니다. Esc는 취소합니다.';
  paintShortcuts();btn.blur();
}));
$('#resetKeys').addEventListener('click',()=>{
  state.shortcuts={...defaults};state.recording='';saveShortcuts();paintShortcuts();
  $('#shortcutHelp').textContent='단축키를 기본값으로 복원했습니다.';
});
window.addEventListener('keydown',e=>{
  if(state.recording){
    e.preventDefault();e.stopPropagation();
    if(e.key==='Escape'){state.recording='';$('#shortcutHelp').textContent='단축키 변경을 취소했습니다.';paintShortcuts();return;}
    const combo=shortcutFromEvent(e);if(!combo)return;
    const blocked=new Set(['Mod+Q','Mod+W','Mod+R','Mod+H','Mod+M','Mod+Tab','Mod+Space']);
    if(blocked.has(combo)){$('#shortcutHelp').textContent='시스템 또는 앱 기본 단축키와 충돌할 수 있습니다. 다른 조합을 선택하세요.';return;}
    if(Object.entries(state.shortcuts).some(([id,value])=>id!==state.recording&&value===combo)){
      $('#shortcutHelp').textContent='이미 사용 중인 단축키입니다. 다른 키를 누르세요.';return;
    }
    state.shortcuts[state.recording]=combo;state.recording='';saveShortcuts();paintShortcuts();
    $('#shortcutHelp').textContent=`단축키 ${friendlyShortcut(combo)}를 저장했습니다.`;
    return;
  }
  const focused=document.activeElement;
  const typing=focused&&(['INPUT','TEXTAREA','SELECT'].includes(focused.tagName)||focused.isContentEditable);
  if(state.viewerOpen){
    if(e.key==='Escape'){e.preventDefault();closeViewer();return;}
    if(typing)return;
    if(e.code==='ArrowDown'){e.preventDefault();moveFile(1);return;}
    if(e.code==='ArrowUp'){e.preventDefault();moveFile(-1);return;}
  }
  const combo=shortcutFromEvent(e);
  const match=Object.entries(state.shortcuts).find(([,value])=>value===combo);
  if(match){
    if(state.running&&!['nextTab','prevTab','viewer','nextFile','prevFile'].includes(match[0]))return;
    if(typing&&match[0]!=='search')return;
    if(e.repeat&&!['nextFile','prevFile'].includes(match[0]))return;
    e.preventDefault();e.stopPropagation();shortcutAction(match[0]);return;
  }
  if(!typing&&state.tab==='files'&&!state.viewerOpen){
    if(e.code==='ArrowDown'){e.preventDefault();moveFile(1);}
    else if(e.code==='ArrowUp'){e.preventDefault();moveFile(-1);}
  }
},true);
loadShortcuts();
if(typeof ResizeObserver!=='undefined'){
  new ResizeObserver(adjustPageSize).observe($('#tableSpace'));
  new ResizeObserver(adjustTimePageSize).observe($('#timeTableSpace'));
}
window.addEventListener('resize',()=>{adjustPageSize();adjustTimePageSize();});
openTab('files');updateStats();renderFileRows();renderTimeRows();showSidePreview();
requestAnimationFrame(adjustPageSize);
