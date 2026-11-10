'use strict';
// One normalization rule for Electron main and the renderer, independent of keyboard layout.
(function (root) {
 const defaults = Object.freeze({
  tabFiles:'Mod+1', tabTime:'Mod+2', tabSave:'Mod+3', tabKeys:'Mod+4',
  openFiles:'Mod+O',openFolder:'Mod+Shift+O',nextTab:'Mod+Alt+ArrowRight',
  prevTab:'Mod+Alt+ArrowLeft',apply:'Mod+Enter',search:'Mod+F',
  viewer:'Space',nextFile:'ArrowRight',prevFile:'ArrowLeft'
 });
 function keyCombo(event, mac) {
  const parts=[];
  if(mac?event.metaKey??event.meta:event.ctrlKey??event.control)parts.push('Mod');
  if(event.altKey??event.alt)parts.push('Alt');
  if(event.shiftKey??event.shift)parts.push('Shift');
  const code=event.code||'';
  let key='';
  if(/^Key[A-Z]$/.test(code))key=code.slice(3);
  else if(/^Digit[0-9]$/.test(code))key=code.slice(5);
  else if(/^Numpad[0-9]$/.test(code))key=code.slice(6);
  else if(['Enter','NumpadEnter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(code))key=code==='NumpadEnter'?'Enter':code;
  else if(typeof event.key==='string'){
   if(/^[a-zA-Z0-9]$/.test(event.key))key=event.key.toUpperCase();
   else if(['Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(event.key))key=event.key===' '?'Space':event.key;
  }
  if(!key)return '';
  if(!parts.length&&!['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return '';
  return [...parts,key].join('+');
 }
 const api={defaults,keyCombo};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 else root.DateShiftKeys=api;
})(typeof window!=='undefined'?window:globalThis);
