'use strict';
// Camera DateShift v1.0.0 — 화면/단축키 전용. 메타데이터 엔진은 수정하지 않습니다.
const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const tabs = ['files', 'time', 'save', 'keys'];
const defaults = {
  openFiles: 'Mod+O', openFolder: 'Mod+Shift+O',
  nextTab: 'Mod+Alt+ArrowRight', prevTab: 'Mod+Alt+ArrowLeft',
  apply: 'Mod+Enter', search: 'Mod+F'
};
const state = {
  queue: [], files: [], selected: new Set(), previews: new Map(),
  filter: 'all', query: '', page: 0, pageSize: 4, running: false,
  outputDir: '', tab: 'files', shortcuts: {...defaults}, recording: '', results: [],
  hasResult: false
};
const mac = navigator.platform.toLowerCase().includes('mac');
const el = (name, cls = '', value) => {
  const node = document.createElement(name);
  if (cls) node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
};
const size = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' :
  n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : `${Math.ceil((n || 0) / 1024)} KB`;

function settings() {
  return {
    action: $('input[name="action"]:checked').value,
    direction: $('input[name="direction"]:checked').value,
    amount: Object.fromEntries($$('[data-unit]').map(x => [x.dataset.unit, Number(x.value)])),
    absolute: $('#absoluteInput').value,
    filesystemDates: $('#filesystemDates').checked,
    timeMode: $('#timeMode').value
  };
}
function chosenRows() { return state.files.filter(r => r.state === 'ready' && state.selected.has(r.path)); }
function filtered() {
  return state.files.filter(r => (state.filter === 'all' || r.state === state.filter) &&
    (!state.query || r.path.toLowerCase().includes(state.query.toLowerCase())));
}
function openTab(tab) {
  if (!tabs.includes(tab)) return;
  state.tab = tab;
  $$('.stage').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $$('.tab-panel').forEach(panel => {
    const active = panel.id === `panel-${tab}`;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });
  updateStats();
  if (tab === 'files') requestAnimationFrame(adjustPageSize);
  if (tab === 'time') updatePreviewPanel();
}
function setRunning(running) {
  state.running = running;
  for (const id of ['pickFiles', 'pickFolder', 'clearAll', 'pickDestination', 'timeMode', 'resetKeys']) {
    $('#' + id).disabled = running;
  }
  $('#cancel').hidden = !running;
  updateApply();
}
function updateApply() {
  const mode = $('input[name="saveMode"]:checked').value;
  $('#destinationRow').hidden = mode !== 'copy';
  const chosen = chosenRows();
  $('#countChecked').textContent = String(chosen.length);
  $('#timeSelection').textContent = `수정 가능 파일 ${chosen.length}개 선택`;
  $('#saveSelection').textContent = `${chosen.length}개 파일 선택됨`;
  $('#saveSummaryCount').textContent = `${chosen.length}개`;
  const o = settings();
  $('#saveSummaryMode').textContent = o.action === 'absolute' ? '기준 날짜에 맞춰 이동' :
    `${o.direction === 'earlier' ? '과거' : '미래'}로 ` +
    Object.entries({년:o.amount.years,월:o.amount.months,일:o.amount.days,시:o.amount.hours,분:o.amount.minutes,초:o.amount.seconds})
      .filter(([,n]) => n > 0).map(([u,n]) => `${n}${u}`).join(' ') || '이동 없음';
  $('#apply').disabled = state.running || !chosen.length || (mode === 'copy' && !state.outputDir);
}
function updateStats() {
  $('#countAll').textContent = String(state.files.length);
  for (const status of ['ready', 'review', 'missing', 'error']) {
    const id = '#count' + status[0].toUpperCase() + status.slice(1);
    $(id).textContent = String(state.files.filter(x => x.state === status).length);
  }
  updateApply();
}
function parseDisplayDate(raw) {
  if (!raw || raw === '계산 중…') return {day: raw || '—', clock: '—'};
  const normalized = String(raw).trim().replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3 ').replace('T', ' ');
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return {day: normalized, clock: ''};
  const zone = match[3] ? ' ' + match[3] : '';
  return {day: match[1], clock: match[2] + zone};
}
function dateCell(value, isAfter) {
  const parts = parseDisplayDate(value);
  const div = el('div', 'date-value' + (isAfter ? ' after' : ''));
  div.append(el('span', 'day', parts.day), el('span', 'clock', parts.clock));
  div.title = value || '';
  return div;
}
function renderRows() {
  const all = filtered();
  const pages = Math.max(1, Math.ceil(all.length / state.pageSize));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const start = state.page * state.pageSize;
  const items = all.slice(start, start + state.pageSize);
  const body = $('#fileRows');
  body.replaceChildren();
  if (!all.length) {
    const tr = el('tr'), td = el('td', 'empty', state.files.length ? '검색 조건에 맞는 파일이 없습니다.' : '파일이나 폴더를 선택하면 분석 결과가 나타납니다.');
    td.colSpan = 5; tr.append(td); body.append(tr);
  }
  for (const row of items) {
    const tr = el('tr');
    let td = el('td');
    const box = el('input'); box.type = 'checkbox'; box.disabled = state.running || row.state !== 'ready';
    box.checked = state.selected.has(row.path);
    box.setAttribute('aria-label', `${row.name} 선택`);
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(row.path); else state.selected.delete(row.path);
      updateApply(); renderRows(); updatePreviewPanel(); schedulePreview();
    });
    td.append(box); tr.append(td);
    td = el('td');
    const filename = el('div', 'filename', row.name);
    const hint = el('div', 'filehint', `${row.type === 'photo' ? '사진' : '영상'} · ${size(row.bytes)} · ${row.source || '근거 없음'}`);
    hint.title = `${row.path}\n${row.source || ''}\n${row.note || ''}`;
    td.append(filename, hint); tr.append(td);
    td = el('td'); td.append(dateCell(row.captured || '—', false)); td.title = row.note || row.source || ''; tr.append(td);
    td = el('td'); td.append(dateCell(row.state === 'ready' ? (state.previews.get(row.path) || '계산 중…') : '—', true)); tr.append(td);
    const statuses = {ready:'수정 가능', review:'시간대 확인', missing:'촬영일 없음', error:'읽기 오류'};
    td = el('td');
    const pill = el('span', 'pill ' + (row.state === 'ready' ? '' : row.state), statuses[row.state] || row.state);
    pill.title = row.note || row.error || '';
    td.append(pill); tr.append(td);
    body.append(tr);
  }
  $('#shownCount').textContent = all.length ? `${all.length}개 중 ${start + 1}–${Math.min(start + items.length, all.length)}개 표시` : '표시할 파일이 없습니다.';
  $('#pageLabel').textContent = `${state.page + 1} / ${pages}`;
  $('#prevPage').disabled = state.page === 0;
  $('#nextPage').disabled = state.page >= pages - 1;
  const ready = all.filter(r => r.state === 'ready');
  $('#checkAll').checked = !!ready.length && ready.every(r => state.selected.has(r.path));
}
function adjustPageSize() {
  if (state.tab !== 'files') return;
  const area = $('#tableSpace');
  if (!area.clientHeight) return;
  const compact = window.innerHeight <= 820;
  const rowHeight = compact ? 56 : 72;
  const next = Math.max(1, Math.min(30, Math.floor((area.clientHeight - (compact ? 30 : 38) - 2) / rowHeight)));
  if (next !== state.pageSize) { state.pageSize = next; state.page = 0; renderRows(); }
}
function updatePreviewPanel() {
  const row = chosenRows()[0];
  const before = parseDisplayDate(row?.captured);
  const after = parseDisplayDate(row && (state.previews.get(row.path) || '계산 중…'));
  $('#beforeDay').textContent = before.day;
  $('#beforeClock').textContent = before.clock;
  $('#afterDay').textContent = after.day;
  $('#afterClock').textContent = after.clock;
  $('#previewAnchorLabel').textContent = row ? `대표 파일: ${row.name} (선택한 첫 번째 파일)` : '파일 확인 탭에서 수정할 파일을 선택하세요.';
  $('#previewSource').textContent = row?.source || '파일을 선택해 주세요.';
  $('#previewNote').textContent = row?.note || '사진 EXIF / 영상 시간대 메타데이터 / 동반 XML을 분석합니다.';
}
let paintTimer;
function paint() {
  if (paintTimer) return;
  paintTimer = setTimeout(() => {paintTimer = null; updateStats(); renderRows(); updatePreviewPanel();}, 80);
}
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (state.running) return;
    const paths = state.files.filter(r => r.state === 'ready').map(r => r.path);
    if (!paths.length) {state.previews.clear(); renderRows(); updatePreviewPanel(); return;}
    try {
      const result = await window.dateshift.preview(paths, chosenRows().map(r => r.path), settings());
      if (!result.ok) throw Error(result.error);
      state.previews = new Map(result.previews.map(item => [item.path, item.after]));
      renderRows(); updatePreviewPanel(); updateApply();
      $('#scanStatus').textContent = `${state.files.length}개 분석됨 · ${chosenRows().length}개 선택됨`;
    } catch (err) {$('#scanStatus').textContent = `미리보기 오류: ${err.message}`;}
  }, 160);
}
async function scanFiles() {
  if (state.running || !state.queue.length) return;
  state.files = []; state.selected.clear(); state.previews.clear(); state.page = 0;
  setRunning(true); state.hasResult = false; $('#resultBox').hidden = true;
  $('#resultEmpty').hidden = false; $('#saveCsv').disabled = true;
  $('#scanStatus').textContent = `메타데이터 분석 중 · 0 / ${state.queue.length}`;
  updateStats(); renderRows(); updatePreviewPanel();
  try {
    const result = await window.dateshift.scan(state.queue, {timeMode: $('#timeMode').value});
    if (!result.ok) throw Error(result.error);
    $('#scanStatus').textContent = `분석 완료 ${result.done}개 · 시간대 확인 필요 ${state.files.filter(x => x.state === 'review').length}개${result.cancelled ? ' · 중단됨' : ''}`;
  } catch (err) {$('#scanStatus').textContent = '분석 오류: ' + err.message;}
  finally {setRunning(false); updateStats(); renderRows(); updatePreviewPanel(); schedulePreview();}
}
window.dateshift.onScanRow(({row, done, total}) => {
  state.files.push(row);
  if (row.state === 'ready') state.selected.add(row.path);
  $('#scanStatus').textContent = `촬영일시 확인 중 · ${done} / ${total}`;
  paint();
});
window.dateshift.onApplyRow(row => {
  state.results.push(`[${row.status}] ${row.file.split(/[\\/]/).at(-1)}${row.after ? ' → ' + row.after : ''}${row.message ? ' · ' + row.message : ''}`);
  $('#resultDetails').textContent = state.results.slice(-4).join('\n');
  $('#resultHeadline').textContent = `작업 중 ${row.done} / ${row.total}`;
  $('#scanStatus').textContent = `촬영일시 변경 중 · ${row.done} / ${row.total}`;
});
async function add(items) {
  if (state.running || !items?.length) return;
  state.queue = [...new Map([...state.queue, ...items].filter(x => x?.path).map(x => [x.path, x])).values()];
  openTab('files');
  await scanFiles();
}
async function openFiles() {
  if (state.running) return;
  try {await add(await window.dateshift.pickFiles());}
  catch (err) {alert(err.message);}
}
async function openFolder() {
  if (state.running) return;
  try {await add(await window.dateshift.pickFolder());}
  catch (err) {alert(err.message);}
}
$('#pickFiles').addEventListener('click', openFiles);
$('#pickFolder').addEventListener('click', openFolder);
$('#clearAll').addEventListener('click', () => {
  if (state.running) return;
  state.queue = []; state.files = []; state.selected.clear(); state.previews.clear(); state.page = 0;
  $('#scanStatus').textContent = '촬영 파일을 불러와 주세요.';
  state.hasResult = false; $('#resultBox').hidden = true; $('#resultEmpty').hidden = false; $('#saveCsv').disabled = true;
  updateStats(); renderRows(); updatePreviewPanel();
});
$('#pickDestination').addEventListener('click', async () => {
  const folder = await window.dateshift.pickDestination();
  if (folder) {state.outputDir = folder; $('#destination').textContent = folder; $('#destination').title = folder;}
  updateApply();
});
$('#cancel').addEventListener('click', () => {
  window.dateshift.cancel();
  $('#scanStatus').textContent = '진행 중인 파일을 마친 뒤 작업을 중단합니다.';
});
$$('input[name="saveMode"]').forEach(x => x.addEventListener('change', updateApply));
$$('input[name="action"]').forEach(x => x.addEventListener('change', () => {
  $('#shiftControls').hidden = settings().action !== 'shift';
  $('#absoluteControls').hidden = settings().action === 'shift';
  updateApply(); schedulePreview();
}));
$$('input[name="direction"], [data-unit]').forEach(x => x.addEventListener('input', () => { updateApply(); schedulePreview(); }));
$('#absoluteInput').addEventListener('input', () => {updateApply(); schedulePreview();});
$('#timeMode').addEventListener('change', () => {if (state.queue.length) void scanFiles();});
$$('.filter').forEach(btn => btn.addEventListener('click', () => {
  state.filter = btn.dataset.filter; state.page = 0;
  $$('.filter').forEach(b => b.classList.toggle('active', b === btn));
  renderRows();
}));
$('#search').addEventListener('input', e => {state.query = e.target.value; state.page = 0; renderRows();});
$('#prevPage').addEventListener('click', () => {state.page = Math.max(0, state.page - 1); renderRows();});
$('#nextPage').addEventListener('click', () => {state.page++; renderRows();});
$('#checkAll').addEventListener('change', e => {
  for (const row of filtered()) {
    if (row.state === 'ready') {
      if (e.target.checked) state.selected.add(row.path); else state.selected.delete(row.path);
    }
  }
  updateStats(); renderRows(); updatePreviewPanel(); schedulePreview();
});
$('#dropzone').addEventListener('dragover', e => {e.preventDefault(); $('#dropzone').classList.add('dragover');});
$('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('dragover'));
$('#dropzone').addEventListener('drop', async e => {
  e.preventDefault(); $('#dropzone').classList.remove('dragover');
  try {await add(window.dateshift.fromDroppedFiles([...e.dataTransfer.files]));}
  catch (err) {alert(err.message);}
});
$('#dropzone').addEventListener('keydown', e => {if (e.key === 'Enter' || e.key === ' ') {e.preventDefault(); void openFiles();}});
async function applyChanges() {
  if (state.running) return;
  const chosen = chosenRows().map(row => row.path);
  if (!chosen.length) {openTab('files'); alert('수정할 파일을 선택해 주세요.'); return;}
  const options = settings();
  if (options.action === 'shift' && !Object.values(options.amount).some(n => Number.isInteger(n) && n > 0)) {
    openTab('time'); alert('시간 이동 값을 입력해 주세요.'); return;
  }
  if (options.action === 'shift' && Object.values(options.amount).some(n => !Number.isSafeInteger(n) || n < 0 || n > 9999)) {
    openTab('time'); alert('각 이동 값은 0~9999 사이의 정수여야 합니다.'); return;
  }
  const mode = $('input[name="saveMode"]:checked').value;
  if (mode === 'copy' && !state.outputDir) {openTab('save'); alert('복사본 저장 폴더를 선택하세요.'); return;}
  openTab('save');
  setRunning(true); state.results = []; state.hasResult = true;
  $('#resultBox').hidden = false; $('#resultEmpty').hidden = true;
  $('#resultHeadline').textContent = '작업 처리 중'; $('#resultDetails').textContent = '파일별 적용 결과를 확인하고 있습니다.';
  try {
    const result = await window.dateshift.apply(chosen, options, mode, state.outputDir);
    if (!result.ok) {$('#resultHeadline').textContent = '적용하지 않음'; $('#resultDetails').textContent = result.error; return;}
    $('#resultHeadline').textContent = `완료 ${result.success} · 건너뜀 ${result.skipped} · 실패 ${result.failure}`;
    $('#scanStatus').textContent = `작업 종료 · ${result.completed} / ${result.total}개${result.cancelled ? ' · 중단됨' : ''}`;
    $('#saveCsv').disabled = !result.completed;
    if (mode === 'original' && result.success) $('#resultDetails').textContent += '\n원본 파일이 변경되었습니다. 다시 불러와 확인하세요.';
  } catch (err) {
    $('#resultHeadline').textContent = '작업 실패'; $('#resultDetails').textContent = err.message;
  } finally {setRunning(false);}
}
$('#apply').addEventListener('click', applyChanges);
$('#saveCsv').addEventListener('click', async () => {
  try {
    const result = await window.dateshift.saveCsv();
    if (result.ok) $('#scanStatus').textContent = 'CSV 저장 완료: ' + result.path;
    else if (result.error !== '취소되었습니다.') alert(result.error);
  } catch (err) {alert(err.message);}
});
$$('.stage').forEach(btn => btn.addEventListener('click', () => openTab(btn.dataset.tab)));
$('#goTime').addEventListener('click', () => openTab('time'));
$('#goSave').addEventListener('click', () => openTab('save'));
$('#goFiles').addEventListener('click', () => openTab('files'));
$('#goHome').addEventListener('click', () => openTab('files'));

// 변경 가능 · 앱이 활성화된 경우에만 동작하는 단축키 (OS 전역 단축키를 점유하지 않음).
function friendlyShortcut(value) {
  return (value || '설정 안 됨').split('+').map(key => {
    if (key === 'Mod') return mac ? '⌘' : 'Ctrl';
    if (key === 'Alt') return mac ? '⌥' : 'Alt';
    if (key === 'Shift') return mac ? '⇧' : 'Shift';
    if (key === 'ArrowLeft') return '←';
    if (key === 'ArrowRight') return '→';
    if (key === 'Enter') return 'Enter';
    return key;
  }).join(' + ');
}
function shortcutFromEvent(e) {
  const parts = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) key = e.key;
  if (!parts.length || !key) return '';
  return [...parts, key].join('+');
}
function paintShortcuts() {
  $$('.key-button').forEach(btn => {
    btn.classList.toggle('recording', state.recording === btn.dataset.shortcut);
    btn.textContent = state.recording === btn.dataset.shortcut ? '새 키 조합 입력…' : friendlyShortcut(state.shortcuts[btn.dataset.shortcut]);
  });
}
function saveShortcuts() {
  try {localStorage.setItem('camera-dateshift-shortcuts-v1', JSON.stringify(state.shortcuts));}
  catch (_) {$('#shortcutHelp').textContent = '이 환경에서는 단축키 저장이 차단되었습니다. 앱 실행 중에는 사용할 수 있습니다.';}
}
function loadShortcuts() {
  try {
    const saved = JSON.parse(localStorage.getItem('camera-dateshift-shortcuts-v1') || 'null');
    if (saved && typeof saved === 'object') {
      const values = {...defaults};
      for (const id of Object.keys(defaults)) {
        if (typeof saved[id] === 'string' && saved[id].length < 60) values[id] = saved[id];
      }
      if (new Set(Object.values(values)).size === Object.values(values).length) state.shortcuts = values;
    }
  } catch (_) { /* 저장된 단축키가 손상되면 기본값 사용 */ }
  paintShortcuts();
}
function shortcutAction(id) {
  if (id === 'openFiles') void openFiles();
  if (id === 'openFolder') void openFolder();
  if (id === 'nextTab') openTab(tabs[(tabs.indexOf(state.tab) + 1) % tabs.length]);
  if (id === 'prevTab') openTab(tabs[(tabs.indexOf(state.tab) + tabs.length - 1) % tabs.length]);
  if (id === 'search') {openTab('files'); $('#search').focus(); $('#search').select();}
  if (id === 'apply') {
    if (state.tab !== 'save') {openTab('save'); $('#scanStatus').textContent = '저장 설정을 확인하고 날짜 변경을 실행하세요.';}
    else if (!$('#apply').disabled) void applyChanges();
  }
}
$$('.key-button').forEach(btn => btn.addEventListener('click', () => {
  state.recording = btn.dataset.shortcut;
  $('#shortcutHelp').textContent = '새 키 조합을 누르세요. 취소하려면 Esc를 누르세요. ⌘ 또는 Ctrl 등 조합 키를 포함해야 합니다.';
  paintShortcuts();
  btn.blur();
}));
$('#resetKeys').addEventListener('click', () => {
  state.shortcuts = {...defaults}; state.recording = '';
  saveShortcuts(); paintShortcuts();
  $('#shortcutHelp').textContent = '기본 단축키로 복원했습니다.';
});
window.addEventListener('keydown', e => {
  if (state.recording) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') {
      state.recording = ''; $('#shortcutHelp').textContent = '단축키 변경을 취소했습니다.';
      paintShortcuts(); return;
    }
    const combo = shortcutFromEvent(e);
    if (!combo) return;
    const blocked = new Set(['Mod+Q','Mod+W','Mod+R','Mod+H','Mod+M','Mod+Tab']);
    if (blocked.has(combo)) {$('#shortcutHelp').textContent = '시스템 또는 기본 앱 단축키와 충돌할 수 있는 키입니다. 다른 조합을 선택하세요.'; return;}
    if (Object.entries(state.shortcuts).some(([id, val]) => id !== state.recording && val === combo)) {
      $('#shortcutHelp').textContent = '다른 기능에서 이미 사용 중인 키 조합입니다. 다른 키를 선택하세요.'; return;
    }
    state.shortcuts[state.recording] = combo;
    state.recording = ''; saveShortcuts(); paintShortcuts();
    $('#shortcutHelp').textContent = `변경한 단축키 ${friendlyShortcut(combo)}를 저장했습니다.`;
    return;
  }
  if (e.repeat) return;
  const combo = shortcutFromEvent(e);
  const match = Object.entries(state.shortcuts).find(([,value]) => value === combo);
  if (!match) return;
  if (state.running && !['nextTab','prevTab'].includes(match[0])) return;
  const focused = document.activeElement;
  const typing = focused && (['INPUT','TEXTAREA','SELECT'].includes(focused.tagName) || focused.isContentEditable);
  if (typing && match[0] !== 'search') return;
  e.preventDefault(); e.stopPropagation(); shortcutAction(match[0]);
}, true);
loadShortcuts();
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(adjustPageSize).observe($('#tableSpace'));
window.addEventListener('resize', adjustPageSize);
openTab('files'); updateStats(); renderRows(); updatePreviewPanel();
requestAnimationFrame(adjustPageSize);
