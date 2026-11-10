'use strict';
// Camera metadata is not a filesystem timestamp. This module never looks at birthtime/mtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const {parseDate, formatHuman, dateToUTC, shiftParts, formatDate} = require('./time');

const SIDE_SUFFIX = /^(.+)M01\.XML$/i;
function isoOffsetMinutes(tz) {
  if (tz === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz || '');
  if (!m) return null;
  const h = +m[2], min = +m[3];
  if (h > 14 || min > 59 || (h === 14 && min !== 0)) return null;
  return (m[1] === '-' ? -1 : 1) * (h * 60 + min);
}
function zoneFromOffset(parts) {
  return isoOffsetMinutes(parts?.tz);
}
function utcInstant(parts) {
  const offset=zoneFromOffset(parts);
  return offset === null ? null : dateToUTC(parts) - offset * 60000;
}
function formatOffset(minutes) {
  const sign=minutes<0?'-':'+'; const abs=Math.abs(minutes);
  return `${sign}${String(Math.floor(abs/60)).padStart(2,'0')}:${String(abs%60).padStart(2,'0')}`;
}
function wallFromUTC(utcParts, minutes) {
  const d=new Date(dateToUTC(utcParts)+minutes*60000);
  return { ...utcParts, y:d.getUTCFullYear(), mo:d.getUTCMonth()+1, d:d.getUTCDate(), h:d.getUTCHours(), mi:d.getUTCMinutes(), se:d.getUTCSeconds(), tz:formatOffset(minutes), iso:false};
}
function hostOffsetMinutes(parts, zone='') {
  const instant=new Date(dateToUTC(parts));
  try {
    const fmt=new Intl.DateTimeFormat('en-US', {timeZone:zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    const o=Object.fromEntries(fmt.formatToParts(instant).filter(t=>t.type!=='literal').map(t=>[t.type,Number(t.value)]));
    const local=Date.UTC(o.year,o.month-1,o.day,o.hour,o.minute,o.second);
    return Math.round((local-instant.getTime())/60000);
  } catch { return -instant.getTimezoneOffset(); }
}
function findCaptureTag(tags, names) {
  const entries=Object.entries(tags || {});
  for(const name of names) {
    const hit=entries.find(([key,value])=>{
      if (typeof value !== 'string' || !parseDate(value)) return false;
      const tail=key.split(':').at(-1);
      return key===name || (name===tail && !key.startsWith('System:') && !key.startsWith('File:'));
    });
    if(hit) return {tag:hit[0],parts:parseDate(hit[1]),raw:hit[1]};
  }
  return null;
}
function originalDateFromXML(content) {
  if (!/\<NonRealTimeMeta\b/.test(content) || !/schemas-professionalDisc:nonRealTimeMeta/i.test(content)) return null;
  const m=content.match(/<CreationDate\s+value="([^"]+)"\s*\/?\s*>/);
  const parts=m&&parseDate(m[1]);
  if (!parts || zoneFromOffset(parts)===null) return null;
  return {raw:m[1],parts};
}
async function findSonyXML(file) {
  if (!/\.(mp4|mov|m4v)$/i.test(file)) return null;
  const dir=path.dirname(file), stem=path.parse(file).name;
  try {
    const children=await fs.readdir(dir);
    const match=children.find(n=>SIDE_SUFFIX.test(n) && n.slice(0,-7).toLowerCase()===stem.toLowerCase());
    if(!match) return null;
    const xmlPath=path.join(dir,match);
    if ((await fs.stat(xmlPath)).size > 1024*1024) return null;
    const text=await fs.readFile(xmlPath,'utf8');
    const capture=originalDateFromXML(text);
    return capture ? {path:xmlPath,text, ...capture} : null;
  } catch(e) { if(['ENOENT','ENOTDIR','EACCES'].includes(e.code)) return null; throw e; }
}
function shiftSonyXML(xml, options, anchor) {
  const capture=originalDateFromXML(xml);
  if(!capture) throw Error('Sony XML의 촬영일시를 읽을 수 없습니다.');
  const {calculate}=require('./time');
  const shifted=calculate(capture.parts,options,anchor);
  const formatted=formatDate(shifted);
  return xml.replace(/(<CreationDate\s+value=")[^"]+("\s*\/?\s*>)/, (_all,a,b)=>a+formatted+b);
}
// The date is always a CAMERA WALL CLOCK. Explicit offsets are trusted; QuickTime integers are not.
function analyzeCapture(tags, type, sidecar=null, settings={}) {
  if(type==='photo') {
    const original=findCaptureTag(tags,['SubSecDateTimeOriginal','DateTimeOriginal', 'CreationDate']);
    const fallback=findCaptureTag(tags,['CreateDate','DateTimeDigitized']);
    const capture=original || fallback;
    if(!capture) return {state:'missing', captured:null, source:'내부 촬영일시 없음', confidence:'none'};
    return {state:original?'ready':'review', captured:formatHuman(capture.parts), parts:capture.parts, raw:capture.raw,
      source:original?'사진 EXIF/XMP 촬영일시':'EXIF 생성일시만 존재', confidence:original?'strong':'uncertain', note:original?'':'촬영일시 원본 필드가 없어 확인이 필요합니다.'};
  }
  if(sidecar?.parts) {
    const movie=findCaptureTag(tags,['QuickTime:CreateDate','MovieHeader:CreateDate','CreateDate']);
    let conflict=false;
    if(movie) {
      const instant=utcInstant(sidecar.parts);
      // Many XAVC files write UTC integer times. If stored differently, surface the disagreement.
      if(instant!==null && Math.abs(dateToUTC(movie.parts)-instant)>120000) conflict=true;
    }
    return {state:conflict?'review':'ready',captured:formatHuman(sidecar.parts),parts:sidecar.parts,raw:sidecar.raw,
      source:'Sony XML · 원본 촬영일시',confidence:conflict?'uncertain':'strong',sidecar:sidecar.path,
      note:conflict?'XML 시간과 MP4의 UTC 시간이 일치하지 않습니다. 카메라 시간 설정을 확인하세요.':''};
  }
  const explicit=findCaptureTag(tags,['Keys:CreationDate','UserData:DateTimeOriginal','UserData:CreationDate',
    'XMP-exif:DateTimeOriginal','XMP-xmp:CreateDate','CreationDate','DateTimeOriginal']);
  if(explicit?.parts && zoneFromOffset(explicit.parts)!==null) return {
    state:'ready',captured:formatHuman(explicit.parts),parts:explicit.parts,raw:explicit.raw,
    source:`영상 내 시간대 포함 · ${explicit.tag}`, confidence:'strong',note:''};
  const movie=findCaptureTag(tags,['QuickTime:CreateDate','MovieHeader:CreateDate','CreateDate','Track1:MediaCreateDate','MediaCreateDate','TrackCreateDate']);
  if(!movie) {
    if(explicit) return {state:'review',captured:formatHuman(explicit.parts),parts:explicit.parts,raw:explicit.raw,
      source:'영상 내 시간대 미기재',confidence:'uncertain',note:'카메라 시간대 정보가 없습니다.'};
    return {state:'missing',captured:null,source:'영상 내부 촬영일시 없음',confidence:'none'};
  }
  const mode=settings.timeMode||'auto';
  if(mode==='local') return {state:'ready',captured:formatHuman(movie.parts),parts:movie.parts,raw:movie.raw,
    source:'QuickTime 원시 시각 · 사용자 지정',confidence:'manual',note:'파일의 숫자를 카메라 현지 시각으로 해석했습니다.'};
  const offset = Number.isInteger(settings.offsetMinutes)?settings.offsetMinutes:hostOffsetMinutes(movie.parts);
  const rendered=wallFromUTC(movie.parts,offset);
  return {state:mode==='utc'?'ready':'review',captured:formatHuman(rendered),parts:rendered,raw:movie.raw,
    source:mode==='utc'?'QuickTime UTC · 사용자 지정':'QuickTime UTC 환산 · 시간대 추정',
    confidence:mode==='utc'?'manual':'uncertain',note:mode==='utc'?'':`촬영 장소 시간대를 확정할 정보가 없습니다. 현재 ${formatOffset(offset)}로 추정했습니다. 모드를 선택하면 적용할 수 있습니다.`};
}
module.exports={isoOffsetMinutes, utcInstant,wallFromUTC,hostOffsetMinutes,findSonyXML,originalDateFromXML,shiftSonyXML,analyzeCapture,formatOffset};
