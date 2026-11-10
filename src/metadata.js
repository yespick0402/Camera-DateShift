'use strict';
const path = require('node:path');
const {parseDate, calculate, formatDate, formatHuman, dateToUTC, utcToParts} = require('./time');

const PHOTO = new Set(['.jpg', '.jpeg', '.arw', '.heif', '.heic', '.tif', '.tiff', '.dng', '.cr2', '.cr3', '.nef', '.nrw', '.raf', '.rw2', '.orf', '.pef', '.srw', '.3fr', '.iiq', '.k25', '.mos']);
const VIDEO = new Set(['.mp4', '.mov', '.m4v']);
const supported = p => PHOTO.has(path.extname(p).toLowerCase()) || VIDEO.has(path.extname(p).toLowerCase());
const kind = p => PHOTO.has(path.extname(p).toLowerCase()) ? 'photo' : 'video';

// Only camera capture dates and companion capture-creation fields, not file system times.
// Keys with -G1 depend on the source (e.g., ExifIFD, XMP-exif, Track1).
const CAPTURE_PRIORITY = {
  photo: ['EXIF:DateTimeOriginal', 'ExifIFD:DateTimeOriginal', 'XMP-exif:DateTimeOriginal', 'DateTimeOriginal',
          'EXIF:CreateDate', 'ExifIFD:CreateDate', 'XMP-xmp:CreateDate', 'CreateDate'],
  video: ['Keys:CreationDate', 'UserData:DateTimeOriginal', 'QuickTime:CreateDate', 'CreationDate', 'DateTimeOriginal', 'CreateDate', 'Track1:TrackCreateDate', 'Track1:MediaCreateDate']
};
const PHOTO_FIELDS = {
  DateTimeOriginal: 'EXIF:DateTimeOriginal',
  CreateDate: 'EXIF:CreateDate',
  ModifyDate: 'EXIF:ModifyDate'
};
const VIDEO_FIELDS = {
  CreateDate: 'QuickTime:CreateDate', ModifyDate: 'QuickTime:ModifyDate',
  TrackCreateDate: 'QuickTime:TrackCreateDate', TrackModifyDate: 'QuickTime:TrackModifyDate',
  MediaCreateDate: 'QuickTime:MediaCreateDate', MediaModifyDate: 'QuickTime:MediaModifyDate',
  CreationDate: 'Keys:CreationDate', DateTimeOriginal: 'UserData:DateTimeOriginal'
};
function partsOf(tag) { const p = tag.lastIndexOf(':'); return { group:p >= 0 ? tag.slice(0, p) : '', name:p >= 0 ? tag.slice(p + 1) : tag }; }
function dateFields(tags, fileKind) {
  const out = [];
  for (const [tag, value] of Object.entries(tags)) {
    if (typeof value !== 'string') continue;
    const p = parseDate(value);
    if (!p) continue;
    const { group, name } = partsOf(tag);
    let writeTag = null;
    if (fileKind === 'photo') {
      if ((group === 'EXIF' || group === 'ExifIFD' || group === 'IFD0' || !group) && PHOTO_FIELDS[name]) writeTag = PHOTO_FIELDS[name];
      if (group.startsWith('XMP') && ['DateTimeOriginal', 'CreateDate', 'ModifyDate'].includes(name)) writeTag = `XMP:${name}`;
    } else {
      if (['QuickTime', 'MovieHeader', 'Track1', 'Track2', 'Track3', 'Track4', 'Track5', 'Track6', 'Track7', 'Track8', ''].includes(group) && VIDEO_FIELDS[name] && !['CreationDate', 'DateTimeOriginal'].includes(name)) writeTag = VIDEO_FIELDS[name];
      if ((group === 'Keys' || !group) && name === 'CreationDate') writeTag = 'Keys:CreationDate';
      if ((group === 'UserData' || !group) && name === 'DateTimeOriginal') writeTag = 'UserData:DateTimeOriginal';
      if (group.startsWith('XMP') && ['DateTimeOriginal', 'CreateDate', 'ModifyDate'].includes(name)) writeTag = `XMP:${name}`;
    }
    if (writeTag) out.push({tag, writeTag, raw:value, parts:p});
  }
  return out;
}
function detectPrimary(tags, fileKind) {
  const fields = dateFields(tags, fileKind);
  for (const name of CAPTURE_PRIORITY[fileKind]) {
    const found = fields.find(f => f.tag === name);
    if (found) return found;
  }
  if (fileKind === 'photo') return fields.find(f => f.writeTag === 'EXIF:DateTimeOriginal') || fields.find(f => f.writeTag === 'EXIF:CreateDate') || fields.find(f=>f.writeTag === 'XMP:DateTimeOriginal') || fields.find(f=>f.writeTag === 'XMP:CreateDate') || null;
  return fields.find(f => ['Keys:CreationDate', 'UserData:DateTimeOriginal', 'QuickTime:CreateDate', 'XMP:DateTimeOriginal', 'XMP:CreateDate'].includes(f.writeTag)) || null;
}
function makeWritePlan(tags, fileKind, options, cameraCapture=null) {
  const fields = dateFields(tags, fileKind);
  const primary = detectPrimary(tags, fileKind);
  if (!primary) return null;
  const originalWall = cameraCapture?.parts || primary.parts;
  const anchor = (options.action === 'absolute' && options.absoluteAnchor) ? parseDate(options.absoluteAnchor) : originalWall;
  if (!anchor) throw Error('기준 파일의 촬영일시를 확인할 수 없습니다.');
  const newWall = calculate(originalWall, options, anchor);
  const delta = dateToUTC(newWall) - dateToUTC(originalWall);
  const write = {};
  for (const field of fields) {
    if (Object.hasOwn(write, field.writeTag)) continue;
    // Keep the field's native time representation, shifting its wall-clock reading
    // by the same duration. QuickTime stored in UTC stays UTC; EXIF local stays local.
    const next = utcToParts(dateToUTC(field.parts) + delta, field.parts);
    write[field.writeTag] = formatDate(next);
  }
  return { primary:formatHuman(originalWall), after:formatHuman(newWall), afterParts:newWall,
    tags:write, key:primary.writeTag, delta };
}

module.exports = {PHOTO, VIDEO, supported, kind, dateFields, detectPrimary, makeWritePlan};
