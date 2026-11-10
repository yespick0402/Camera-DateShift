'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict');
const {parseDate,formatDate,shiftParts,calculate}=require('../src/time');
test('EXIF date roundtrip and suffix',()=>{
  assert.equal(formatDate(parseDate('2026:11:09 10:05:07+09:00')),'2026:11:09 10:05:07+09:00');
});
test('QuickTime ISO date roundtrip',()=>{
  assert.equal(formatDate(parseDate('2026-11-09T10:05:07+09:00')),'2026-11-09T10:05:07+09:00');
});
test('no capture date / placeholder rejected',()=>{
  for (const v of ['','0000:00:00 00:00:00','1904:01:01 00:00:00','2026:02:30 20:20:20']) assert.equal(parseDate(v),null);
});
test('leap day and month end clamp',()=>{
  const date=parseDate('2024:01:31 23:10:10');
  assert.equal(formatDate(shiftParts(date,{months:1})),'2024:02:29 23:10:10');
});
test('shift by 1h across midnight without local DST',()=>{
  const date=parseDate('2026:11:09 00:20:00');
  assert.equal(formatDate(shiftParts(date,{hours:1},-1)),'2026:11:08 23:20:00');
});
test('absolute target keeps difference between original fields',()=>{
  const anchor=parseDate('2026:01:01 10:00:00');
  const changed=parseDate('2026:01:01 10:00:15');
  assert.equal(formatDate(calculate(changed,{action:'absolute',absolute:'2025-01-01T12:00:00'},anchor)),'2025:01:01 12:00:15');
});
