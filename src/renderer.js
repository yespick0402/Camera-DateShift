'use strict';
const $=sel=>document.querySelector(sel), $$=sel=>Array.from(document.querySelectorAll(sel));
const state={queue:[],files:[],selected:new Set(),previews:new Map(),filter:'all',query:'',page:0,
  pageSize:5,running:false,outputDir:''};
const el=(name,cls='',value)=>{const x=document.createElement(name);x.className=cls;if(value!==undefined)x.textContent=value;return x;};
const fileSize=n=>n>=1024**3?(n/1024**3).toFixed(2)+' GB':n>=1024**2?(n/1024**2).toFixed(1)+' MB':`${Math.ceil(n/1024||0)} KB`;
function opts(){return {action:$('input[name="action"]:checked').value,
  direction:$('input[name="direction"]:checked').value,
  amount:Object.fromEntries($$('[data-unit]').map(x=>[x.dataset.unit,Number(x.value)])),
  absolute:$('#absoluteInput').value,filesystemDates:$('#filesystemDates').checked,
  timeMode:$('#timeMode').value};}
function filtered(){return state.files.filter(r=>(state.filter==='all'||r.state===state.filter)&&(!state.query||r.path.toLowerCase().includes(state.query.toLowerCase())));}
function selectedReady(){return state.files.filter(x=>x.state==='ready'&&state.selected.has(x.path));}
function setRunning(r){
  state.running=r;
  for(const id of ['pickFiles','pickFolder','clearAll','pickDestination','timeMode'])$('#'+id).disabled=r;
  $('#cancel').hidden=!r;
  updateApply();
}
function updateApply(){
  const mode=$('input[name="saveMode"]:checked').value;
  $('#destinationRow').hidden=mode!=='copy';
  $('#apply').disabled=state.running||!selectedReady().length||(mode==='copy'&&!state.outputDir);
  $('#countChecked').textContent=selectedReady().length;
}
function updateStats(){
  $('#countAll').textContent=state.files.length;
  for(const stateName of ['ready','review','missing','error']){
    $('#count'+stateName[0].toUpperCase()+stateName.slice(1)).textContent=state.files.filter(x=>x.state===stateName).length;
  }
  updateApply();
}
function adjustPageSize(){
  const h=$('#tableSpace').clientHeight;
  const count=Math.floor(Math.max(0,h-38)/62);
  const next=Math.max(1,Math.min(12,count));
  if(next!==state.pageSize){state.pageSize=next;renderRows();}
}
function renderRows(){
  const all=filtered();
  const pages=Math.max(1,Math.ceil(all.length/state.pageSize));
  state.page=Math.min(state.page,pages-1);
  const start=state.page*state.pageSize,items=all.slice(start,start+state.pageSize);
  const tbody=$('#fileRows');tbody.replaceChildren();
  if(!all.length){const tr=el('tr'),td=el('td','empty',state.files.length?'표시할 파일이 없습니다.':'파일이나 폴더를 불러오면 촬영일시를 분석합니다.');td.colSpan=5;tr.append(td);tbody.append(tr);}
  for(const row of items){
    const tr=el('tr');
    const checktd=el('td');const box=el('input');box.type='checkbox';box.disabled=state.running||row.state!=='ready';box.checked=state.selected.has(row.path);
    box.addEventListener('change',()=>{if(box.checked)state.selected.add(row.path);else state.selected.delete(row.path);updateApply();updateExample();schedulePreview();});checktd.append(box);tr.append(checktd);
    let td=el('td');const name=el('div','filename',row.name);const hint=el('div','filehint',`${row.type==='photo'?'사진':'영상'} · ${fileSize(row.bytes||0)} · ${row.source||''}`);hint.title=`${row.path}\n${row.source||''}\n${row.note||''}`;td.append(name,hint);tr.append(td);
    td=el('td','before-date',row.captured||'—');td.title=row.note||row.source||'';tr.append(td);
    td=el('td','after-date',row.state==='ready'?(state.previews.get(row.path)||'계산 중…'):'—');tr.append(td);
    const statuses={ready:'수정 가능',review:'시간대 확인',missing:'촬영일 없음',error:'읽기 오류'};
    td=el('td');const badge=el('span','pill '+(row.state==='ready'?'':row.state),statuses[row.state]||row.state);badge.title=row.note||row.error||'';td.append(badge);tr.append(td);
    tbody.append(tr);
  }
  $('#shownCount').textContent=all.length?`${all.length}개 중 ${start+1}–${Math.min(start+items.length,all.length)}개 표시 · 스크롤 없이 페이지 넘김`:'표시할 파일이 없습니다.';
  $('#pageLabel').textContent=`${state.page+1} / ${pages}`;
  $('#prevPage').disabled=state.page===0;$('#nextPage').disabled=state.page>=pages-1;
  const readyAll=all.filter(x=>x.state==='ready');$('#checkAll').checked=!!readyAll.length&&readyAll.every(x=>state.selected.has(x.path));
}
let paintTimer;
function paint(){if(paintTimer)return;paintTimer=setTimeout(()=>{paintTimer=null;updateStats();renderRows();},80);}
let previewTimer;
function schedulePreview(){
  clearTimeout(previewTimer);previewTimer=setTimeout(async()=>{
    if(state.running)return;
    const paths=state.files.filter(x=>x.state==='ready').map(x=>x.path);
    if(!paths.length){state.previews.clear();renderRows();updateExample();return;}
    try{const r=await window.dateshift.preview(paths,selectedReady().map(x=>x.path),opts());
      if(!r.ok)throw Error(r.error);
      state.previews=new Map(r.previews.map(x=>[x.path,x.after]));renderRows();updateExample();
    }catch(e){$('#scanStatus').textContent='날짜 미리보기 오류: '+e.message;}
  },150);
}
function updateExample(){
  const first=selectedReady()[0];
  if(first){$('#example').textContent=`${first.captured} → ${state.previews.get(first.path)||'계산 중…'}`;return;}
  $('#example').textContent='파일을 선택하면 변경 전·후 시각이 표시됩니다.';
}
async function scanFiles(reset=true){
  if(state.running||!state.queue.length)return;
  if(reset){state.files=[];state.selected.clear();state.previews.clear();state.page=0;}
  setRunning(true);$('#resultBox').hidden=true;
  $('#scanStatus').textContent=`원본 메타데이터 확인 중 · 0 / ${state.queue.length}`;
  updateStats();renderRows();
  try{const r=await window.dateshift.scan(state.queue,{timeMode:$('#timeMode').value});
    if(!r.ok)throw Error(r.error);
    $('#scanStatus').textContent=`${r.done}개 확인 완료 · 시간대 확인 필요 ${state.files.filter(x=>x.state==='review').length}개${r.cancelled?' · 중단됨':''}`;
  }catch(e){$('#scanStatus').textContent='읽기 실패: '+e.message;}
  finally{setRunning(false);updateStats();renderRows();schedulePreview();}
}
window.dateshift.onScanRow(({row,done,total})=>{
  state.files.push(row);if(row.state==='ready')state.selected.add(row.path);
  $('#scanStatus').textContent=`촬영일시 분석 중 · ${done} / ${total}`;paint();
});
let resultLines=[];
window.dateshift.onApplyRow(row=>{
  resultLines.push(`[${row.status}] ${row.file.split(/[\\/]/).at(-1)}${row.after?' → '+row.after:''}${row.message?' · '+row.message:''}`);
  $('#resultDetails').textContent=resultLines.slice(-3).join('\n');
  $('#resultHeadline').textContent=`처리 중 ${row.done} / ${row.total}`;
  $('#scanStatus').textContent=`촬영일시 변경 중 · ${row.done} / ${row.total}`;
});
$('#pickFiles').addEventListener('click',async()=>{try{const added=await window.dateshift.pickFiles();await add(added);}catch(e){alert(e.message);}});
$('#pickFolder').addEventListener('click',async()=>{try{const added=await window.dateshift.pickFolder();await add(added);}catch(e){alert(e.message);}});
async function add(items){
  if(state.running||!items?.length)return;
  state.queue=[...new Map([...state.queue,...items].filter(x=>x?.path).map(x=>[x.path,x])).values()];
  await scanFiles();
}
$('#clearAll').addEventListener('click',()=>{
  if(state.running)return;
  state.queue=[];state.files=[];state.selected.clear();state.previews.clear();state.page=0;
  $('#scanStatus').textContent='촬영 파일을 불러와 주세요.';$('#resultBox').hidden=true;
  updateStats();renderRows();updateExample();
});
$('#pickDestination').addEventListener('click',async()=>{
  const folder=await window.dateshift.pickDestination();if(folder){state.outputDir=folder;$('#destination').textContent=folder;$('#destination').title=folder;}updateApply();
});
$('#cancel').addEventListener('click',()=>{window.dateshift.cancel();$('#scanStatus').textContent='진행 중인 파일을 마친 뒤 중단합니다.';});
$$('input[name="saveMode"]').forEach(x=>x.addEventListener('change',updateApply));
$$('input[name="action"]').forEach(x=>x.addEventListener('change',()=>{
  $('#shiftControls').hidden=opts().action!=='shift';$('#absoluteControls').hidden=opts().action==='shift';schedulePreview();
}));
$$('input[name="direction"], [data-unit]').forEach(x=>x.addEventListener('input',schedulePreview));
$('#absoluteInput').addEventListener('input',schedulePreview);
$('#timeMode').addEventListener('change',()=>{if(state.queue.length)void scanFiles();});
$$('.filter').forEach(x=>x.addEventListener('click',()=>{state.filter=x.dataset.filter;state.page=0;$$('.filter').forEach(b=>b.classList.toggle('active',b===x));renderRows();}));
$('#search').addEventListener('input',e=>{state.query=e.target.value;state.page=0;renderRows();});
$('#prevPage').addEventListener('click',()=>{state.page=Math.max(0,state.page-1);renderRows();});
$('#nextPage').addEventListener('click',()=>{state.page++;renderRows();});
$('#checkAll').addEventListener('change',e=>{
  for(const row of filtered())if(row.state==='ready'){
    if(e.target.checked)state.selected.add(row.path);else state.selected.delete(row.path);
  }
  updateApply();renderRows();schedulePreview();
});
$('#dropzone').addEventListener('dragover',e=>{e.preventDefault();$('#dropzone').classList.add('dragover');});
$('#dropzone').addEventListener('dragleave',()=>$('#dropzone').classList.remove('dragover'));
$('#dropzone').addEventListener('drop',async e=>{e.preventDefault();$('#dropzone').classList.remove('dragover');try{await add(window.dateshift.fromDroppedFiles([...e.dataTransfer.files]));}catch(x){alert(x.message);}});
$('#apply').addEventListener('click',async()=>{
  if(state.running)return;
  const chosen=selectedReady().map(x=>x.path);if(!chosen.length)return;
  const options=opts();
  if(options.action==='shift'&&!Object.values(options.amount).some(x=>Number.isInteger(x)&&x>0)){alert('시간 이동 값을 입력하세요.');return;}
  if(options.action==='shift'&&Object.values(options.amount).some(x=>!Number.isSafeInteger(x)||x<0||x>9999)){alert('각 이동 값은 0~9999 사이의 정수여야 합니다.');return;}
  const mode=$('input[name="saveMode"]:checked').value;
  if(mode==='copy'&&!state.outputDir){alert('복사본 저장 폴더를 선택하세요.');return;}
  setRunning(true);resultLines=[];$('#resultBox').hidden=false;$('#resultHeadline').textContent='변경 적용 중';$('#resultDetails').textContent='저장 결과를 확인합니다.';
  try{
    const r=await window.dateshift.apply(chosen,options,mode,state.outputDir);
    if(!r.ok){$('#resultHeadline').textContent='적용하지 않음';$('#resultDetails').textContent=r.error;return;}
    $('#resultHeadline').textContent=`완료 ${r.success} · 건너뜀 ${r.skipped} · 실패 ${r.failure}`;
    $('#scanStatus').textContent=`작업 종료 · ${r.completed} / ${r.total}개${r.cancelled?' · 중단됨':''}`;
    if(mode==='original'&&r.success)$('#resultDetails').textContent+='\n원본이 변경됐습니다. 다시 불러와 확인하세요.';
  }catch(e){$('#resultHeadline').textContent='실패';$('#resultDetails').textContent=e.message;}
  finally{setRunning(false);adjustPageSize();}
});
$('#saveCsv').addEventListener('click',async()=>{try{const r=await window.dateshift.saveCsv();if(r.ok)$('#scanStatus').textContent='CSV 저장: '+r.path;else if(r.error!=='취소되었습니다.')alert(r.error);}catch(e){alert(e.message);}});
if(typeof ResizeObserver!=='undefined')new ResizeObserver(adjustPageSize).observe($('#tableSpace'));
updateStats();renderRows();updateExample();requestAnimationFrame(adjustPageSize);
