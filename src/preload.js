'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('dateshift',{
 pickFiles:()=>ipcRenderer.invoke('pick-files'),
 pickFolder:()=>ipcRenderer.invoke('pick-folder'),
 pickDestination:()=>ipcRenderer.invoke('pick-destination'),
 scan:(files,settings)=>ipcRenderer.invoke('scan',{files,settings}),
 preview:(paths,selected,options)=>ipcRenderer.invoke('preview',{paths,selected,options}),
 apply:(paths,options,mode,outputDir,reviewApprovedPaths=[])=>ipcRenderer.invoke('apply',{paths,options,mode,outputDir,reviewApprovedPaths}),
 getMediaPreview:(file,large=false)=>ipcRenderer.invoke('get-media-preview',{file,large}),
 getVideoUrl:file=>ipcRenderer.invoke('get-video-url',file),
 setShortcutSettings:settings=>ipcRenderer.send('shortcut-settings',settings),
 onAppShortcut:callback=>ipcRenderer.on('app-shortcut',(_ev,action)=>callback(action)),
 openMediaExternally:file=>ipcRenderer.invoke('open-media-external',file),
 saveCsv:()=>ipcRenderer.invoke('save-csv'),
 cancel:()=>ipcRenderer.send('cancel'),
 fromDroppedFiles:files=>files.map(f=>({path:webUtils.getPathForFile(f),base:''})).filter(f=>f.path),
 onScanRow:callback=>ipcRenderer.on('scan-row',(_ev,v)=>callback(v)),
 onApplyRow:callback=>ipcRenderer.on('apply-row',(_ev,v)=>callback(v))
});
