'use strict';

/** Camera local/naive times are shifted as wall-clock time; no host timezone/DST conversion. */
const DATE_RE = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;
function pad(n) { return String(n).padStart(2, '0'); }
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(DATE_RE);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (y < 1971 || y > 9998 || mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(y, mo - 1, d);
  utc.setUTCHours(h, mi, se, 0);
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return { y, mo, d, h, mi, se, fraction: m[7] || '', tz: m[8] || '', iso: s.trim()[4] === '-' || s.trim()[10] === 'T' };
}
function formatDate(p) {
  const date = p.iso ? `${String(p.y).padStart(4,'0')}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.se)}` : `${String(p.y).padStart(4,'0')}:${pad(p.mo)}:${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.se)}`;
  return date + (p.fraction || '') + (p.tz || '');
}
function formatHuman(p) {
  if (!p) return '촬영일 미확인';
  return `${String(p.y).padStart(4, '0')}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.se)}` + (p.tz ? ' ' + p.tz : '');
}
function dateToUTC(p) {
  const d = new Date(0);
  d.setUTCFullYear(p.y, p.mo - 1, p.d);
  d.setUTCHours(p.h, p.mi, p.se, 0);
  return d.getTime();
}
function utcToParts(ms, base) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9998 || d.getUTCFullYear() < 1971) throw Error('날짜 계산 범위를 벗어났습니다.');
  return { y:d.getUTCFullYear(), mo:d.getUTCMonth()+1, d:d.getUTCDate(), h:d.getUTCHours(), mi:d.getUTCMinutes(), se:d.getUTCSeconds(), fraction:base.fraction, tz:base.tz, iso:base.iso };
}
function shiftParts(parts, values, sign = 1) {
  const years = sign * Number(values.years || 0);
  const months = sign * Number(values.months || 0);
  const days = sign * Number(values.days || 0);
  const hours = sign * Number(values.hours || 0);
  const minutes = sign * Number(values.minutes || 0);
  const seconds = sign * Number(values.seconds || 0);
  for (const val of [years, months, days, hours, minutes, seconds]) {
    if (!Number.isSafeInteger(val) || Math.abs(val) > 100000) throw Error('시간 이동 값이 유효하지 않습니다.');
  }
  // Clamp day for year/month shifts (Jan 31 + 1 month => Feb 28/29), then add remaining time.
  const first = new Date(0);
  first.setUTCFullYear(parts.y + years, parts.mo - 1 + months, 1);
  first.setUTCHours(parts.h, parts.mi, parts.se, 0);
  const newYear = first.getUTCFullYear();
  const newMonth = first.getUTCMonth();
  const lastDay = new Date(Date.UTC(newYear, newMonth + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(parts.d, lastDay));
  return utcToParts(first.getTime() + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000, parts);
}
function calculate(old, options, anchor = old) {
  if (!old) return null;
  if (options.action === 'absolute') {
    const target = parseDate(options.absolute);
    if (!target) throw Error('지정 날짜를 YYYY-MM-DD HH:MM:SS 형식으로 입력하세요.');
    if (!anchor) throw Error('기준 촬영일시가 없습니다.');
    return utcToParts(dateToUTC(old) + dateToUTC(target) - dateToUTC(anchor), old);
  }
  return shiftParts(old, options.amount, options.direction === 'earlier' ? -1 : 1);
}
module.exports = {parseDate, formatDate, formatHuman, dateToUTC, utcToParts, calculate, shiftParts};
