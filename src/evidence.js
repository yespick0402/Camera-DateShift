'use strict';
// A read-only audit of capture-date evidence. Never substitute filesystem dates for camera capture.
const {parseDate, dateToUTC} = require('./time');
const {utcInstant} = require('./capture');
const MAX_ITEMS = 100;
const DATE_FIELDS = new Set([
  'SubSecDateTimeOriginal','DateTimeOriginal','DateTimeDigitized','CreateDate','CreationDate',
  'ModifyDate','TrackCreateDate','MediaCreateDate','TrackModifyDate','MediaModifyDate',
  'OffsetTimeOriginal','OffsetTimeDigitized','OffsetTime','TimeZone','TimeZoneOffset',
  'GPSDateTime','GPSDateStamp','GPSTimeStamp','TimeCreated','DateCreated','DateTimeStamp',
  'CameraDateTime','ContentCreateDate','FileCreateDate','FileModifyDate',
  'FileAccessDate','DigitalCreationDate','DigitalCreationTime', 'SubSecCreateDate'
]);
function groupAndName(key) {
  const idx=key.lastIndexOf(':');
  return idx<0?{group:'',name:key}:{group:key.slice(0,idx),name:key.slice(idx+1)};
}
function isFilesystem(group,name){return ['System','File'].includes(group) || /^File(?:Create|Modify|Access)Date$/.test(name);}
function hasTimezone(value){return /(?:Z|[+-](?:0\d|1[0-4]):?[0-5]\d)\s*$/i.test(value);}
function explainTag(group,name,type,raw){
  const zone=hasTimezone(raw);
  if(isFilesystem(group,name))return {grade:'low',label:'낮음',category:'파일시스템',description:'복사·이동·다운로드 또는 파일 수정에 따라 바뀔 수 있어 촬영일시 근거로 사용하지 않습니다.',timezone:zone?'표기됨':'불명'};
  if(/^OffsetTime|^TimeZone/.test(name))return {grade:'medium',label:'보조 근거',category:'시간대',description:'독립적인 촬영일시가 아니라 다른 날짜 값에 붙는 시간대·오프셋 정보입니다.',timezone:'오프셋 기록'};
  if(/^GPS/.test(name))return {grade:'medium',label:'보조 근거',category:'GPS 시각',description:'GPS 시각은 UTC 기준으로 기록될 수 있습니다. 해당 영상/사진의 촬영 시작 시각과 일치하는지 확인해야 합니다.',timezone:'GPS/UTC 확인'};
  if(['ModifyDate','TrackModifyDate','MediaModifyDate'].includes(name))return {grade:'low',label:'낮음',category:'수정/트랙 시각',description:'촬영 시작이 아니라 내부 메타데이터·트랙의 수정 시각일 수 있습니다.',timezone:zone?'명시':'불명'};
  if(['TrackCreateDate','MediaCreateDate'].includes(name))return {grade:'medium',label:'조건부',category:'QuickTime 트랙',description:'영상·음성 트랙 생성 정보입니다. 카메라 촬영 시작 시각과 같을 수도 있지만 별도 검증이 필요합니다.',timezone:zone?'명시':'UTC 또는 현지시간 미확정'};
  if(name==='CreateDate'&&['QuickTime','MovieHeader'].includes(group))return {grade:'medium',label:'조건부',category:'QuickTime 헤더',description:'컨테이너 생성 날짜입니다. UTC로 기록하는 규칙이 있지만 일부 카메라는 현지 시각으로 기록합니다.',timezone:zone?'명시':'UTC 또는 현지시간 미확정'};
  if(type==='photo' && ['SubSecDateTimeOriginal','DateTimeOriginal'].includes(name) && !isFilesystem(group,name))return {grade:'high',label:'높음',category:'사진 촬영 기록',description:'사진의 카메라 원본 촬영 시계값입니다. 카메라 시계 설정이 틀리면 기록도 틀릴 수 있습니다.',timezone:zone?'명시':'카메라 시계값(시간대 별도 확인)'};
  if(type==='photo' && ['CreateDate','DateTimeDigitized','SubSecCreateDate'].includes(name))return {grade:'medium',label:'조건부',category:'사진 디지털화',description:'사진의 디지털 생성 시각입니다. 원본 촬영일 필드가 없을 때 참고합니다.',timezone:zone?'명시':'시간대 별도 확인'};
  if(type==='video' && ['CreationDate','DateTimeOriginal','CameraDateTime','DateTimeStamp'].includes(name))return {
    grade:'high',label:'높음',category:'영상 촬영 기록',description:'영상 내부의 녹화/촬영 날짜 기록입니다. 시간대가 없으면 실제 UTC 오프셋은 확정되지 않습니다.',timezone:zone?'명시':'카메라 시계값(시간대 미표기)'};
  if(group.startsWith('XMP'))return {grade:'medium',label:'조건부',category:'XMP 메타데이터',description:'파일에 포함된 날짜입니다. 촬영 후 편집 프로그램에서 덮어썼을 가능성을 검토하세요.',timezone:zone?'명시':'미표기'};
  return {grade:'medium',label:'조건부',category:'날짜 메타데이터',description:'파일에 들어 있는 날짜입니다. 촬영일인지 생성·가공일인지는 다른 기록과 비교하세요.',timezone:zone?'명시':'미표기'};
}
function buildEvidence(tags, type, sidecar=null, capture=null) {
  const evidence=[];
  if(sidecar?.raw){
    evidence.push({tag:'Sony XML:CreationDate',raw:sidecar.raw,category:'소니 동반 XML',grade:'high',label:'높음',
      description:'소니가 녹화 시작 시 기록한 날짜와 명시적인 시간대입니다. XML이 원본 영상과 짝이 맞는지도 확인해야 합니다.',
      timezone:'명시',chosen:capture?.source?.includes('Sony XML')||false});
  }
  for(const [key,val] of Object.entries(tags||{})){
    const {group,name}=groupAndName(key);
    if(!DATE_FIELDS.has(name) || val===null || val===undefined || typeof val==='object')continue;
    const raw=String(val).trim();
    if(!raw || raw.length>200)continue;
    const x=explainTag(group,name,type,raw);
    evidence.push({tag:key,raw,...x,chosen:Boolean(capture?.raw && capture.raw===raw &&
      !isFilesystem(group,name) && !/^GPS/.test(name) && !/^OffsetTime|^TimeZone/.test(name))});
    if(evidence.length>=MAX_ITEMS)break;
  }
  const rank = x => x.chosen?0:(x.category==='소니 동반 XML'?1:(x.grade==='high'?2:(x.grade==='medium'?3:4)));
  evidence.sort((a,b)=>rank(a)-rank(b));
  let comparison='';
  if(sidecar?.parts){
    const movie=Object.entries(tags||{}).find(([key,value])=> /^(?:QuickTime|MovieHeader):CreateDate$/.test(key) && typeof value==='string' && parseDate(value));
    if(movie){
      const xmlUTC=utcInstant(sidecar.parts);
      const movieUTC=dateToUTC(parseDate(movie[1]));
      const diff=Math.round(Math.abs(xmlUTC-movieUTC)/1000);
      comparison=diff<=2?'QuickTime 헤더를 UTC로 해석하면 Sony XML과 동일한 순간입니다.':`Sony XML과 QuickTime 헤더의 기록 차이: ${diff}초. 서로 다른 해석이나 원본 변경 가능성을 확인하세요.`;
    }
  }
  return {items:evidence, comparison, count:evidence.length};
}
module.exports={buildEvidence,explainTag,hasTimezone};
