'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {detectPrimary,makeWritePlan}=require('../src/metadata');
const options={action:'shift',direction:'later',amount:{hours:2}};
test('photo RAW gets EXIF date as anchor',()=>{
 const raw={'ExifIFD:DateTimeOriginal':'2026:09:01 09:12:15','IFD0:ModifyDate':'2026:09:01 09:13:00','System:FileModifyDate':'2026:11:09 20:00:00+09:00'};
 const plan=makeWritePlan(raw,'photo',options);
 assert.equal(plan.after,'2026-09-01 11:12:15');
 assert.equal(plan.tags['EXIF:DateTimeOriginal'],'2026:09:01 11:12:15');
 assert.equal(plan.tags['EXIF:ModifyDate'],'2026:09:01 11:13:00');
 assert.equal(Object.keys(plan.tags).some(x=>x.startsWith('System:')),false);
});
test('video QuickTime and Keys capture date both shifted',()=>{
 const raw={'QuickTime:CreateDate':'2026:09:01 09:12:15','Track1:TrackCreateDate':'2026:09:01 09:12:15','Track2:MediaCreateDate':'2026:09:01 09:12:15','Keys:CreationDate':'2026-09-01T18:12:15+09:00'};
 const plan=makeWritePlan(raw,'video',options);
 assert.equal(plan.tags['Keys:CreationDate'],'2026-09-01T20:12:15+09:00');
 assert.equal(plan.tags['QuickTime:CreateDate'],'2026:09:01 11:12:15');
 assert.equal(plan.tags['QuickTime:MediaCreateDate'],'2026:09:01 11:12:15');
});
test('no timestamp is missing not filesystem based',()=>{
 const raw={'System:FileCreateDate':'2026:11:09 11:12:15+09:00','EXIF:Model':'ILME-FX3'};
 assert.equal(detectPrimary(raw,'photo'),null);
 assert.equal(makeWritePlan(raw,'photo',options),null);
});
test('absolute target rebases all files against same first selected capture time',()=>{
 const first={'ExifIFD:DateTimeOriginal':'2026:09:01 10:00:00'};
 const second={'ExifIFD:DateTimeOriginal':'2026:09:01 10:10:00'};
 const settings={action:'absolute',absolute:'2026-10-01T12:00:00',absoluteAnchor:'2026:09:01 10:00:00'};
 assert.equal(makeWritePlan(first,'photo',settings).after,'2026-10-01 12:00:00');
 assert.equal(makeWritePlan(second,'photo',settings).after,'2026-10-01 12:10:00');
});

test('Canon Nikon Fujifilm and Sony RAW formats are included', () => {
 const {supported, kind} = require('../src/metadata');
 for (const extension of ['CR3','CR2','NEF','RAF','ARW','RW2','ORF','DNG']) {
  assert.equal(supported('/tmp/PHOTO.'+extension), true);
  assert.equal(kind('/tmp/PHOTO.'+extension),'photo');
 }
});

test('only filesystem modify date is not mistaken for capture date', () => {
 const {detectPrimary} = require('../src/metadata');
 assert.equal(detectPrimary({'IFD0:ModifyDate':'2023:01:01 02:03:04'},'photo'),null);
});
