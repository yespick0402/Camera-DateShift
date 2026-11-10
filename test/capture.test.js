'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {analyzeCapture,originalDateFromXML,shiftSonyXML,findSonyXML,utcInstant}=require('../src/capture');
const {makeWritePlan}=require('../src/metadata');
const {parseDate}=require('../src/time');
const XML=`<?xml version="1.0" encoding="UTF-8"?>\n<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20" lastUpdate="2026-11-10T10:28:20+09:00"><CreationDate value="2026-11-10T10:28:19+09:00"/><Device manufacturer="Sony" modelName="ILME-FX3"/></NonRealTimeMeta>`;
const MP4={
 'QuickTime:MajorBrand':'XAVC',
 'QuickTime:CreateDate':'2026:11:10 01:28:19',
 'Track1:TrackCreateDate':'2026:11:10 01:28:19',
 'Track1:MediaCreateDate':'2026:11:10 01:28:19',
 'System:FileModifyDate':'2026:11:10 12:34:56+09:00'
};
const oneHour={action:'shift',direction:'earlier',amount:{hours:1}};
test('attached FX3 XML and MP4 UTC describe the same instant exactly',()=>{
 const xml=originalDateFromXML(XML);assert.equal(xml.raw,'2026-11-10T10:28:19+09:00');
 assert.equal(utcInstant(xml.parts),Date.UTC(2026,10,10,1,28,19));
 const result=analyzeCapture(MP4,'video',{...xml,path:'/tmp/C0313M01.XML'});
 assert.equal(result.captured,'2026-11-10 10:28:19 +09:00');assert.equal(result.state,'ready');
 assert.match(result.source,/Sony XML/);
});
test('sidecar is located even after media folder is copied or relocated',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'ds-camera-'));
 try{
  await fs.writeFile(path.join(folder,'C0313M01.XML'),XML);
  const sidecar=await findSonyXML(path.join(folder,'C0313.MP4'));
  assert.equal(sidecar.raw,'2026-11-10T10:28:19+09:00');
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('Sony XML and QuickTime original date shift together with offset preserved',()=>{
 const capture=analyzeCapture(MP4,'video',{...originalDateFromXML(XML),path:'/tmp/C0313M01.XML'});
 const plan=makeWritePlan(MP4,'video',oneHour,capture);
 assert.equal(plan.after,'2026-11-10 09:28:19 +09:00');
 assert.equal(plan.tags['QuickTime:CreateDate'],'2026:11:10 00:28:19');
 assert.equal(plan.tags['QuickTime:MediaCreateDate'],'2026:11:10 00:28:19');
 const changed=shiftSonyXML(XML,oneHour,parseDate(capture.raw));
 assert.match(changed,/CreationDate value="2026-11-10T09:28:19\+09:00"/);
 assert.match(changed,/lastUpdate="2026-11-10T10:28:20\+09:00"/);
});
test('no sidecar, unknown QuickTime time zone is flagged review, never silently 9h fixed',()=>{
 const noSidecar=analyzeCapture(MP4,'video',null,{timeMode:'auto',offsetMinutes:540});
 assert.equal(noSidecar.state,'review');
 assert.equal(noSidecar.captured,'2026-11-10 10:28:19 +09:00');
 assert.match(noSidecar.note,/확정/);
});
test('user can choose UTC conversion or camera-local reading in ambiguous MOV',()=>{
 const utc=analyzeCapture(MP4,'video',null,{timeMode:'utc',offsetMinutes:540});
 const local=analyzeCapture(MP4,'video',null,{timeMode:'local'});
 assert.equal(utc.state,'ready');assert.equal(utc.captured,'2026-11-10 10:28:19 +09:00');
 assert.equal(local.state,'ready');assert.equal(local.captured,'2026-11-10 01:28:19');
});
test('photo EXIF captures local wall time, without filesystem date fallback',()=>{
 const photo={'ExifIFD:DateTimeOriginal':'2024:03:07 18:12:08','System:FileCreateDate':'2026:11:10 10:28:19+09:00'};
 assert.equal(analyzeCapture(photo,'photo').captured,'2024-03-07 18:12:08');
 assert.equal(analyzeCapture({'System:FileCreateDate':'2026:11:10 10:28:19+09:00'},'photo').state,'missing');
});
test('disagreeing XML and movie UTC are flagged for confirmation',()=>{
 const mismatch={...MP4,'QuickTime:CreateDate':'2026:11:09 01:28:19'};
 const result=analyzeCapture(mismatch,'video',{...originalDateFromXML(XML),path:'C0313M01.XML'});
 assert.equal(result.state,'review');assert.match(result.note,/일치하지/);
});
test('unsupported XML cannot be used as original evidence',()=>{
 assert.equal(originalDateFromXML('<CreationDate value="2026-11-10T10:28:19+09:00"/>'),null);
});
test('absolute target uses true local capture time as anchor, never UTC movie header',()=>{
 const capture=analyzeCapture(MP4,'video',{...originalDateFromXML(XML),path:'C0313M01.XML'});
 const settings={action:'absolute',absolute:'2026-11-11T13:00:00',absoluteAnchor:'2026-11-10T10:28:19+09:00'};
 const plan=makeWritePlan(MP4,'video',settings,capture);
 assert.equal(plan.after,'2026-11-11 13:00:00 +09:00');
 assert.equal(plan.tags['QuickTime:CreateDate'],'2026:11:11 04:00:00');
 const changed=shiftSonyXML(XML,settings,parseDate(settings.absoluteAnchor));
 assert.match(changed,/CreationDate value="2026-11-11T13:00:00\+09:00"/);
});
