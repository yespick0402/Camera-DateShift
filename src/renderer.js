'use strict';
// Camera DateShift v1.0.0 — preview + selective editing UI.
// Metadata extraction, date calculations, validation and save logic live in main.js.
const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const tabs = ['files', 'time', 'save', 'keys'];
const defaults={...window.DateShiftKeys.defaults};
const mac = navigator.platform.toLowerCase().includes('mac');
const state = {
  queue:[],files:[],selected:new Set(),reviewApproved:new Set(),previews:new Map(),
  filter:'all',query:'',page:0,pageSize:4,activePath:'',
  timeFilter:'all',timeQuery:'',timePage:0,timePageSize:4,
  thumbnailCache:new Map(),thumbnailPending:new Map(),
  running:false,outputDir:'',tab:'files',shortcuts:{...defaults},recording:'',
  results:[],hasResult:false,viewerOpen:false,viewerRequest:0,mediaRequest:0,
  evidenceOpen:false,evidencePage:0,helpOpen:false,helpPage:0
};
const el = (tag,cls='',value) => {
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(value!==undefined)node.textContent=value;
  return node;
};
const size = n => n>=1024**3?(n/1024**3).toFixed(2)+' GB':
  n>=1024**2?(n/1024**2).toFixed(1)+' MB':`${Math.ceil((n||0)/1024)} KB`;
const labels={ready:'수정 가능',review:'시간대 미확정',missing:'촬영일 없음',error:'읽기 오류'};
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
function canSelect(row){return row && (row.state==='ready'||(row.state==='review'&&Boolean(row.captured)));}
function chosenRows(){return state.files.filter(r=>canSelect(r)&&state.selected.has(r.path)&&
  (r.state!=='review'||state.reviewApproved.has(r.path)));}
function filteredFiles(){return state.files.filter(r=>(state.filter==='all'||r.state===state.filter)&&(!state.query||r.path.toLowerCase().includes(state.query.toLowerCase())));}
function filteredTime(){return state.files.filter(r=>{
  const meets=state.timeFilter==='all'||r.state===state.timeFilter||
    (state.timeFilter==='needs-check'&&['review','missing'].includes(r.state));
  return meets&&(!state.timeQuery||r.path.toLowerCase().includes(state.timeQuery.toLowerCase()));
});}
function visibleRows(){return state.tab==='time'?filteredTime():filteredFiles();}
function ensureTimeActive(){
  const rows=filteredTime();
  if(!rows.some(r=>r.path===state.activePath))state.activePath=rows[0]?.path||'';
  return rows.find(r=>r.path===state.activePath)||null;
}
function openTab(tab){
  if(!tabs.includes(tab))return;
  if(state.viewerOpen)closeViewer();
  if(state.evidenceOpen)closeEvidence();
  if(state.helpOpen)closeHelp();
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
  if(tab==='time')requestAnimationFrame(()=>{adjustTimePageSize();ensureTimeActive();renderTimeRows();});
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
  $('#timeCount').textContent=`수정 가능 ${state.files.filter(x=>x.state==='ready').length} · 확인 필요 ${state.files.filter(x=>x.state==='review').length} · 선택 ${count}`;
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
      if(state.thumbnailCache.size>=40)state.thumbnailCache.delete(state.thumbnailCache.keys().next().value);
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
function changeSelection(row,desired){
  if(state.running||!canSelect(row))return;
  if(desired&&row.state==='review'&&!state.reviewApproved.has(row.path)){
    const ok=window.confirm(`이 파일은 촬영 시간대가 확정되지 않았습니다.\n\n파일: ${row.name}\n현재 표시: ${row.captured}\n근거: ${row.source||'없음'}\n${row.note||''}\n\n이 값을 기준으로 날짜를 변경하시겠습니까?\n틀리게 보이면 왼쪽의 [시간대 정보 없는 영상 해석]에서 UTC 또는 현지 시각을 선택한 후 다시 확인하세요.`);
    if(!ok){renderTimeRows();return;}
    state.reviewApproved.add(row.path);
  }
  if(desired)state.selected.add(row.path);
  else {state.selected.delete(row.path);state.reviewApproved.delete(row.path);}
  updateApply();renderTimeRows();
  if(settings().action==='absolute')schedulePreview();
}
function renderTimeRows(){
  const all=filteredTime();
  ensureTimeActive();
  const pages=Math.max(1,Math.ceil(all.length/state.timePageSize));
  state.timePage=Math.max(0,Math.min(state.timePage,pages-1));
  const start=state.timePage*state.timePageSize;
  const tbody=$('#timeRows');tbody.replaceChildren();
  if(!all.length){const tr=el('tr'),td=el('td','empty',state.files.length?'조건에 맞는 파일이 없습니다.':'파일 확인 탭에서 촬영 파일을 불러오세요.');td.colSpan=5;tr.append(td);tbody.append(tr);}
  for(const row of all.slice(start,start+state.timePageSize)){
    const tr=el('tr','time-row'+(state.selected.has(row.path)?' chosen':'')+
      (state.activePath===row.path?' active':''));
    tr.tabIndex=-1;
    tr.setAttribute('aria-selected',String(state.activePath===row.path));
    tr.addEventListener('click',e=>{if(e.target.closest('input,button'))return;setActiveFile(row.path);});
    tr.addEventListener('dblclick',e=>{if(e.target.closest('input,button'))return;setActiveFile(row.path);openViewer();});
    const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=state.selected.has(row.path);
    checkbox.disabled=state.running||!canSelect(row);checkbox.setAttribute('aria-label',`${row.name} 변경 대상 선택`);
    checkbox.addEventListener('focus',()=>{state.activePath=row.path;});
    checkbox.addEventListener('change',()=>{state.activePath=row.path;changeSelection(row,checkbox.checked);});
    let td=el('td');td.append(checkbox);tr.append(td);
    td=el('td');
    const nameWrap=el('div','time-name-wrap');nameWrap.append(imageFor(row,'time-thumb'));
    const infos=el('div','time-name-caption');
    const titleLine=el('div','time-title-line');titleLine.append(el('strong','file-name',row.name));
    const evidenceButton=el('button','evidence-trigger','ⓘ 근거');evidenceButton.type='button';
    evidenceButton.title=`${row.name} 촬영일시 판정 근거 보기`;
    evidenceButton.addEventListener('click',event=>{event.stopPropagation();setActiveFile(row.path);openEvidence(row);});
    titleLine.append(evidenceButton);
    infos.append(titleLine,el('small','file-secondary',`${row.type==='photo'?'사진':'영상'} · ${row.source||'촬영 근거 없음'}`));
    nameWrap.append(infos);td.append(nameWrap);td.title=row.path;tr.append(td);
    td=el('td');td.append(dateCell(row.captured||'—'));tr.append(td);
    td=el('td');td.append(dateCell(canSelect(row)?(state.previews.get(row.path)||'계산 중…'):'—',true));tr.append(td);
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
  const all=visibleRows(),index=all.findIndex(r=>r.path===path);
  if(state.tab==='time'){
    if(index>=0)state.timePage=Math.floor(index/state.timePageSize);
    renderTimeRows();
  }else{
    if(index>=0)state.page=Math.floor(index/state.pageSize);
    renderFileRows();showSidePreview();
  }
  if(state.viewerOpen)void showViewerContent();
}
function moveFile(step){
  const all=visibleRows();if(!all.length)return;
  const index=all.findIndex(r=>r.path===state.activePath);
  const next=index<0?0:Math.max(0,Math.min(all.length-1,index+step));
  setActiveFile(all[next].path);
}
function fillMediaArea(container,row,result,large=false){
  container.replaceChildren();
  if(result?.thumbnail){
    const img=el('img','media-image');img.src=result.thumbnail;img.alt=row.name+' 미리보기';
    if(row.type==='video'){
      const frame=el('div','video-poster-frame');frame.style.aspectRatio=String(row.aspect||16/9);
      frame.append(img);container.append(frame);
    }else container.append(img);
    return;
  }
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
  $('#fileEvidence').disabled=!row;
  $('#previousMedia').disabled=!row||filteredFiles()[0]?.path===row.path;
  $('#nextMedia').disabled=!row||filteredFiles().at(-1)?.path===row.path;
  $('#fileMedia').replaceChildren(el('div','media-placeholder',row?'미리보기 준비 중…':'파일을 선택하면 사진·영상의 현재 모습을 보여줍니다.'));
  if(!row)return;
  const result=await loadThumbnail(row.path);
  if(seq!==state.mediaRequest||state.tab!=='files'||state.activePath!==row.path)return;
  fillMediaArea($('#fileMedia'),row,result);
}
function openViewer(){
  const row=state.tab==='time'?ensureTimeActive():ensureActive();if(!row)return;
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
  if(state.tab==='time')document.querySelector('#timeRows tr.active')?.focus({preventScroll:true});
}
async function showViewerContent(){
  const row=activeRow();if(!row||!state.viewerOpen)return;
  const request=++state.viewerRequest;
  const all=visibleRows(),index=all.findIndex(x=>x.path===row.path);
  $('#viewerName').textContent=row.name;
  $('#viewerPosition').textContent=`${index+1} / ${all.length} · ${row.type==='photo'?'사진':'영상'}`;
  $('#viewerCapture').textContent=`원본 촬영일시: ${row.captured||'미확인'} · ${row.source||'근거 없음'}`;
  $('#viewerPrev').disabled=index<=0;$('#viewerNext').disabled=index>=all.length-1;
  const stage=$('#viewerStage'),old=stage.querySelector('video');
  if(old){old.pause();old.removeAttribute('src');old.load();}
  stage.replaceChildren(el('div','media-placeholder','미리보기 준비 중…'));
  const current=()=>state.viewerOpen&&request===state.viewerRequest&&state.activePath===row.path;
  if(row.type==='video'){
    // Start streaming immediately; waiting for a video thumbnail unnecessarily delays playback.
    const reply=await window.dateshift.getVideoUrl(row.path);
    if(!current())return;
    if(!reply?.ok){stage.replaceChildren(el('div','media-placeholder',reply?.error||'영상 경로를 열 수 없습니다.'));return;}
    stage.replaceChildren();
    const player=el('video','viewer-video');
    player.controls=true;player.autoplay=true;player.muted=true;player.playsInline=true;
    player.preload='metadata';player.style.aspectRatio=String(row.aspect||16/9);
    player.setAttribute('aria-label',row.name+' 영상 미리보기');
    const notice=el('div','video-loading','영상 여는 중…');stage.append(player,notice);
    const sound=el('button','viewer-sound','🔇 소리 켜기');sound.type='button';
    sound.addEventListener('click',()=>{player.muted=!player.muted;sound.textContent=player.muted?'🔇 소리 켜기':'🔊 소리 끄기';});
    stage.append(sound);
    player.addEventListener('loadedmetadata',()=>{
      if(!current())return;
      if(player.videoWidth>0&&player.videoHeight>0)player.style.aspectRatio=`${player.videoWidth} / ${player.videoHeight}`;
      void player.play().catch(()=>{notice.textContent='재생 버튼을 누르세요. 이 코덱은 기본 영상 앱으로 열어야 할 수도 있습니다.';});
    });
    player.addEventListener('playing',()=>{notice.remove();});
    player.addEventListener('error',async()=>{
      if(!current())return;
      player.pause();player.removeAttribute('src');player.load();
      const thumb=await loadThumbnail(row.path);
      if(!current())return;
      fillMediaArea(stage,row,thumb,true);
      stage.append(el('div','video-warning','지원하지 않는 영상 코덱입니다. 원본을 기본 영상 앱으로 열어 확인할 수 있습니다.'));
      const external=el('button','btn btn-primary viewer-external','기본 영상 앱으로 열기');
      external.type='button';external.addEventListener('click',async()=>{
        const res=await window.dateshift.openMediaExternally(row.path);
        if(!res.ok)alert(res.error);
      });stage.append(external);
    },{once:true});
    player.src=reply.mediaUrl;
    player.load();
    return;
  }
  const result=await loadThumbnail(row.path,true);
  if(!current())return;
  stage.replaceChildren();
  if(result?.thumbnail){
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
    const paths=state.files.filter(canSelect).map(r=>r.path);
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
  if(state.evidenceOpen)closeEvidence();
  if(state.helpOpen)closeHelp();
  state.files=[];state.selected.clear();state.reviewApproved.clear();state.previews.clear();state.page=0;state.timePage=0;state.activePath='';
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
  state.queue=[];state.files=[];state.selected.clear();state.reviewApproved.clear();state.previews.clear();state.page=0;state.timePage=0;state.activePath='';
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
  state.selected.clear();state.reviewApproved.clear();updateApply();renderTimeRows();if(settings().action==='absolute')schedulePreview();
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
    const result=await window.dateshift.apply(chosen,options,mode,state.outputDir,[...state.reviewApproved]);
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
// Read-only audit overlays. All date evidence is collected from the metadata at scan time.
const helpTopics=[
  {title:'판정 순서',description:'파일 날짜가 아닌 카메라 기록을 먼저 살펴봅니다.',items:[
    ['근거를 보는 방법','파일 확인 탭에서 사진·영상을 선택하고 “ⓘ 촬영일시 근거 자세히 보기”를 누르세요. 날짜 변경 목록에도 파일별 “ⓘ 근거” 버튼이 있습니다.'],
    ['여러 날짜가 다르면','XML·원본 촬영일·QuickTime 시각의 시간대와 원본 파일의 기록을 비교합니다. 서로 일치하지 않으면 확인이 필요합니다.'],
    ['신뢰도의 뜻','높음: 촬영 의도가 분명한 기록. 조건부: 촬영 기록일 수도 있어 다른 정보와 비교 필요. 낮음: 촬영시간 판단에 부적합. 카메라 시계 오설정 가능성은 남습니다.']]},
  {title:'사진 EXIF',description:'RAW·JPG 등 스틸 사진의 촬영 시각',items:[
    ['DateTimeOriginal · 높음','카메라가 사진을 촬영할 때 저장하는 시계값입니다. 카메라 시계 자체가 틀렸다면 날짜도 달라집니다.'],
    ['OffsetTimeOriginal · 보조 근거','원본 촬영일시의 UTC 시간대 오프셋입니다. EXIF 날짜에 +09:00 등이 있으면 정확한 시간대 해석에 유리합니다.'],
    ['CreateDate / XMP · 조건부','디지털화 또는 편집 저장 시각일 수 있습니다. DateTimeOriginal이 없으면 참고하지만 동일하게 단정하지 않습니다.']]},
  {title:'영상 메타데이터',description:'MP4 · MOV에서 녹화 날짜를 찾는 방법',items:[
    ['CreationDate / DateTimeOriginal · 높음','영상 안에 녹화/촬영일시가 명시된 경우 우선합니다. +09:00 등 오프셋이 있으면 시간대까지 읽습니다.'],
    ['QuickTime CreateDate · 조건부','영상 헤더의 생성 시각은 UTC로 저장하는 것이 원칙이지만 실제 카메라에 따라 현지 시각일 수 있습니다. 무조건 9시간을 더하지 않습니다.'],
    ['TrackCreateDate / MediaCreateDate · 조건부','영상·음성 트랙의 생성 시각입니다. 촬영 시작 시각인지 다른 기록과 교차 검증해야 합니다.']]},
  {title:'Sony XML',description:'FX3 등 소니 영상의 동반 파일',items:[
    ['CreationDate + 시간대 · 높음','Sony XML의 CreationDate에는 예를 들어 2026-11-10T10:28:19+09:00 형태의 시각이 기록됩니다.'],
    ['MP4와 비교','XML 10:28:19 +09:00와 MP4 QuickTime 01:28:19 UTC는 동일한 순간입니다. 둘이 다르면 확인 필요입니다.'],
    ['주의','XML은 함께 이동하거나 이름 짝이 맞아야 합니다. XML이 없어도 내부 촬영 기록이 분명한 영상은 수정 가능합니다.']]},
  {title:'파일 생성일',description:'Finder · 탐색기 날짜는 원본 촬영일과 다릅니다.',items:[
    ['FileCreateDate / FileModifyDate · 낮음','복사·이동·외장하드 저장·다운로드·변경 작업으로 바뀔 수 있는 파일 시스템 날짜입니다.'],
    ['절대로 자동 대체하지 않음','촬영일시 메타데이터가 없으면 파일 생성일을 원래 촬영일로 추측하여 자동 사용하지 않습니다.'],
    ['선택적으로 맞추기','저장 탭의 파일 생성·수정일 변경은 별도의 선택 옵션이며 파일 시스템에 따라 지원 여부가 다릅니다.']]},
  {title:'시간대·수정',description:'확정할 수 없는 날짜를 안전하게 수정하는 방법',items:[
    ['시간대 미확정','QuickTime 값만 있고 UTC인지 현지시간인지 모르면 확인 필요로 표시합니다. 촬영 날짜 자체는 존재하므로 승인 후 수정할 수 있습니다.'],
    ['해석 방법 선택','날짜 변경 탭에서 “QuickTime UTC → 컴퓨터 시간대” 또는 “QuickTime 값을 현지 시각으로”를 선택하고 예상 날짜를 확인하세요.'],
    ['작업 기본값','↑↓/←→ 파일 이동 · Enter 체크·해제 · Space 큰 미리보기 · Esc 닫기. 원본을 안전하게 보존하려면 복사본으로 저장을 권장합니다.']]}
];
function openEvidence(row=activeRow()){
  if(!row)return;
  if(state.viewerOpen)closeViewer();
  if(state.helpOpen)closeHelp();
  state.evidenceOpen=true;state.evidencePage=0;state.evidenceTarget=row.path;
  $('#evidenceOverlay').hidden=false;
  renderEvidence();$('#evidenceClose').focus();
}
function closeEvidence(){
  state.evidenceOpen=false;$('#evidenceOverlay').hidden=true;
  if(state.tab==='time')$('#timeRows tr.active')?.focus({preventScroll:true});
  else if(state.tab==='files')$('#fileEvidence').focus();
}
function renderEvidence(){
  const row=state.files.find(x=>x.path===state.evidenceTarget);
  if(!row){closeEvidence();return;}
  $('#evidenceName').textContent=row.name;
  $('#evidenceCapture').textContent=(row.captured||'촬영일시 미확인')+' · '+(labels[row.state]||'분석');
  $('#evidenceSource').textContent=row.source||'근거 없음';
  $('#evidenceNote').textContent=row.note||'표시된 정보는 촬영 당시 카메라 기록입니다. 실제 시계 설정은 검증할 수 없습니다.';
  $('#evidenceCompare').textContent=row.evidence?.comparison||'촬영일시와 관련된 메타데이터를 아래에서 비교할 수 있습니다.';
  const items=row.evidence?.items||[];
  const pageSize=3,pages=Math.max(1,Math.ceil(items.length/pageSize));
  state.evidencePage=Math.min(state.evidencePage,pages-1);
  const start=state.evidencePage*pageSize;
  $('#evidenceTotal').textContent=items.length+'개 항목';
  $('#evidencePageLabel').textContent=`${state.evidencePage+1} / ${pages}`;
  $('#evidencePrev').disabled=state.evidencePage===0;
  $('#evidenceNext').disabled=state.evidencePage===pages-1;
  const list=$('#evidenceRows');list.replaceChildren();
  if(!items.length){list.append(el('p','evidence-empty','추출 가능한 촬영일시 관련 메타데이터가 없습니다. 파일 생성일을 촬영일로 자동 대체하지 않습니다.'));return;}
  for(const item of items.slice(start,start+pageSize)){
    const card=el('div','evidence-entry');
    const title=el('div','evidence-entry-title');
    title.append(el('strong','',item.tag),el('span','trust '+item.grade,item.label));
    if(item.chosen)title.append(el('span','trust chosen','표시 시각과 일치'));
    card.append(title);
    const raw=el('div','evidence-raw',item.raw);raw.title=item.raw;
    card.append(raw,el('div','evidence-desc',`${item.category} · 시간대: ${item.timezone} · ${item.description}`));
    list.append(card);
  }
}
function openHelp(){
  if(state.evidenceOpen)closeEvidence();
  if(state.viewerOpen)closeViewer();
  state.helpOpen=true;$('#helpOverlay').hidden=false;
  renderHelp();$('#helpClose').focus();
}
function closeHelp(){state.helpOpen=false;$('#helpOverlay').hidden=true;$('#helpButton').focus();}
function renderHelp(){
  const topic=helpTopics[state.helpPage],topics=$('#helpTopics');topics.replaceChildren();
  helpTopics.forEach((t,i)=>{
    const btn=el('button','help-topic'+(i===state.helpPage?' active':''),t.title);
    btn.type='button';btn.setAttribute('aria-pressed',String(i===state.helpPage));
    btn.addEventListener('click',()=>{state.helpPage=i;renderHelp();});topics.append(btn);
  });
  const content=$('#helpContent');content.replaceChildren();
  content.append(el('h3','',topic.title),el('p','help-intro',topic.description));
  for(const [title,description] of topic.items){
    const card=el('div','help-entry');card.append(el('strong','',title),el('p','',description));content.append(card);
  }
  $('#helpPageLabel').textContent=`${state.helpPage+1} / ${helpTopics.length}`;
  $('#helpPrev').disabled=state.helpPage===0;$('#helpNext').disabled=state.helpPage===helpTopics.length-1;
}
$('#helpButton').addEventListener('click',openHelp);
$('#helpClose').addEventListener('click',closeHelp);
$('#helpDone').addEventListener('click',closeHelp);
$('#helpPrev').addEventListener('click',()=>{state.helpPage=Math.max(0,state.helpPage-1);renderHelp();});
$('#helpNext').addEventListener('click',()=>{state.helpPage=Math.min(helpTopics.length-1,state.helpPage+1);renderHelp();});
$('#fileEvidence').addEventListener('click',()=>openEvidence());
$('#evidenceClose').addEventListener('click',closeEvidence);
$('#evidenceHelp').addEventListener('click',openHelp);
$('#evidencePrev').addEventListener('click',()=>{state.evidencePage--;renderEvidence();});
$('#evidenceNext').addEventListener('click',()=>{state.evidencePage++;renderEvidence();});

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
function shortcutFromEvent(e){return window.DateShiftKeys.keyCombo(e,mac);}
function paintShortcuts(){
  $$('.key-button').forEach(btn=>{
    btn.classList.toggle('recording',state.recording===btn.dataset.shortcut);
    btn.textContent=state.recording===btn.dataset.shortcut?'새 키 입력…':friendlyShortcut(state.shortcuts[btn.dataset.shortcut]);
  });
}
function saveShortcuts(){
  window.dateshift.setShortcutSettings({shortcuts:state.shortcuts});
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
  paintShortcuts();window.dateshift.setShortcutSettings({shortcuts:state.shortcuts,recording:false});
}
function shortcutAction(id){
  if(id==='tabFiles')openTab('files');
  else if(id==='tabTime')openTab('time');
  else if(id==='tabSave')openTab('save');
  else if(id==='tabKeys')openTab('keys');
  else if(id==='openFiles')void openFiles();
  else if(id==='openFolder')void openFolder();
  else if(id==='nextTab')openTab(tabs[(tabs.indexOf(state.tab)+1)%tabs.length]);
  else if(id==='prevTab')openTab(tabs[(tabs.indexOf(state.tab)+tabs.length-1)%tabs.length]);
  else if(id==='search'){openTab('files');$('#search').focus();$('#search').select();}
  else if(id==='toggleSelection'){
    if(state.tab!=='time'||state.viewerOpen||state.running)return;
    const row=ensureTimeActive();if(row&&canSelect(row))changeSelection(row,!state.selected.has(row.path));
  }
  else if(id==='viewer'){
    if(state.viewerOpen)closeViewer();else if(['files','time'].includes(state.tab))openViewer();
  }else if(id==='nextFile'){
    if(['files','time'].includes(state.tab)||state.viewerOpen)moveFile(1);
  }else if(id==='prevFile'){
    if(['files','time'].includes(state.tab)||state.viewerOpen)moveFile(-1);
  }else if(id==='apply'){
    if(state.tab!=='save'){openTab('save');$('#scanStatus').textContent='저장 설정을 확인한 후 실행하세요.';}
    else if(!$('#apply').disabled)void applyChanges();
  }
}
$$('.key-button').forEach(btn=>btn.addEventListener('click',()=>{
  state.recording=btn.dataset.shortcut;
  $('#shortcutHelp').textContent='원하는 키를 누르세요. Enter/Space/방향키는 단독으로 지정할 수 있습니다. Esc는 취소합니다.';
  paintShortcuts();window.dateshift.setShortcutSettings({recording:true});btn.blur();
}));
$('#resetKeys').addEventListener('click',()=>{
  state.shortcuts={...defaults};state.recording='';saveShortcuts();window.dateshift.setShortcutSettings({recording:false});paintShortcuts();
  $('#shortcutHelp').textContent='단축키를 기본값으로 복원했습니다.';
});
window.addEventListener('keydown',e=>{
  if(state.recording){
    e.preventDefault();e.stopPropagation();
    if(e.key==='Escape'){state.recording='';window.dateshift.setShortcutSettings({recording:false});$('#shortcutHelp').textContent='단축키 변경을 취소했습니다.';paintShortcuts();return;}
    const combo=shortcutFromEvent(e);if(!combo)return;
    const blocked=new Set(['Mod+Q','Mod+W','Mod+R','Mod+H','Mod+M','Mod+Tab','Mod+Space']);
    if(blocked.has(combo)){$('#shortcutHelp').textContent='시스템 또는 앱 기본 단축키와 충돌할 수 있습니다. 다른 조합을 선택하세요.';return;}
    if(Object.entries(state.shortcuts).some(([id,value])=>id!==state.recording&&value===combo)){
      $('#shortcutHelp').textContent='이미 사용 중인 단축키입니다. 다른 키를 누르세요.';return;
    }
    state.shortcuts[state.recording]=combo;state.recording='';saveShortcuts();window.dateshift.setShortcutSettings({recording:false});paintShortcuts();
    $('#shortcutHelp').textContent=`단축키 ${friendlyShortcut(combo)}를 저장했습니다.`;
    return;
  }
  if(state.evidenceOpen||state.helpOpen){
    if(e.key==='Escape'){e.preventDefault();if(state.evidenceOpen)closeEvidence();else closeHelp();}
    else if(['ArrowLeft','ArrowRight'].includes(e.key)){
      e.preventDefault();const step=e.key==='ArrowRight'?1:-1;
      if(state.evidenceOpen){state.evidencePage=Math.max(0,state.evidencePage+step);renderEvidence();}
      else{state.helpPage=Math.max(0,Math.min(helpTopics.length-1,state.helpPage+step));renderHelp();}
    }
    return;
  }
  const focused=document.activeElement;
  const typing=focused&&((focused.tagName==='INPUT'&&
    !['checkbox','radio','button','submit'].includes(focused.type))||
    ['TEXTAREA','SELECT'].includes(focused.tagName)||focused.isContentEditable);
  if(state.viewerOpen){
    if(e.key==='Escape'){e.preventDefault();closeViewer();return;}
    if(!typing && ['ArrowUp','ArrowDown'].includes(e.code)){
      e.preventDefault();moveFile(e.code==='ArrowDown'?1:-1);return;
    }
  }
  if(!state.viewerOpen&&e.key==='Escape'&&state.tab==='time')return;
  const combo=shortcutFromEvent(e);
  const match=Object.entries(state.shortcuts).find(([,value])=>value===combo);
  if(match){
    // Enter must not swallow the normal action of focused buttons, input controls or dialogs.
    if(match[0]==='toggleSelection'){
      const interactive=focused?.closest?.('button, a, select, textarea, input, [contenteditable="true"]');
      if(state.tab!=='time'||state.viewerOpen||typing||
         (interactive&&!(focused?.matches?.('input[type="checkbox"]')&&focused.closest('#timeRows'))))return;
    }
    if(state.running&&!['tabFiles','tabTime','tabSave','tabKeys','nextTab','prevTab','viewer','nextFile','prevFile'].includes(match[0]))return;
    if(typing&&(!combo.startsWith('Mod+') || ['viewer','nextFile','prevFile'].includes(match[0])))return;
    if(e.repeat&&!['nextFile','prevFile'].includes(match[0]))return;
    e.preventDefault();e.stopPropagation();shortcutAction(match[0]);return;
  }
  if(!typing&&['files','time'].includes(state.tab)&&!state.viewerOpen){
    if(e.code==='ArrowDown'){e.preventDefault();moveFile(1);}
    else if(e.code==='ArrowUp'){e.preventDefault();moveFile(-1);}
  }
},true);
// Command/Ctrl shortcuts are captured in Electron's main process first so that
// macOS menu accelerators and focused controls cannot swallow them.
window.dateshift.onAppShortcut(id=>{
  if(state.recording)return;
  if(state.running&&!['tabFiles','tabTime','tabSave','tabKeys','nextTab','prevTab'].includes(id))return;
  shortcutAction(id);
});
loadShortcuts();
if(typeof ResizeObserver!=='undefined'){
  new ResizeObserver(adjustPageSize).observe($('#tableSpace'));
  new ResizeObserver(adjustTimePageSize).observe($('#timeTableSpace'));
}
window.addEventListener('resize',()=>{adjustPageSize();adjustTimePageSize();});
openTab('files');updateStats();renderFileRows();renderTimeRows();showSidePreview();
requestAnimationFrame(adjustPageSize);
