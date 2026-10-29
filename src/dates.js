/**
 * Date helpers for the Kerio calendar API.
 *
 * Kerio dates look like "20261030T150000+0300" (local time of the mailbox owner with its UTC
 * offset) or "20261031" for all-day events. When Kerio receives a date it keeps the clock time
 * and ignores the offset, so dates must always be sent in the owner's local time.
 */

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** "+03:00", "+0300", "03" or "-5" -> minutes east of UTC. */
function parseOffset(text) {
  const m = /^([+-])?(\d{1,2})(?::?(\d{2}))?$/.exec(String(text || '').trim());
  if (!m) throw new Error(`Invalid time zone offset: ${text} (expected something like +03:00)`);
  const minutes = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === '-' ? -minutes : minutes;
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** Offset of a Kerio date string, or null if it has none. */
function offsetOfKerioDate(text) {
  const m = /([+-]\d{4})$/.exec(String(text || ''));
  return m ? parseOffset(m[1]) : null;
}

/**
 * Parses user input into an absolute Date.
 *  "2026-10-30"            -> midnight in the owner's time zone
 *  "2026-10-30T15:00"      -> 15:00 in the owner's time zone ("2026-10-30 15:00" works too)
 *  "2026-10-30T15:00+03:00" or "...Z" -> that exact moment
 */
function parseInput(text, offsetMinutes) {
  const value = String(text || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - offsetMinutes * 60000);
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - offsetMinutes * 60000);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const date = new Date(value.replace(' ', 'T'));
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new Error(`Cannot understand the date "${text}". Use 2026-10-30 or 2026-10-30T15:00 (local time of the mailbox).`);
}

/** Absolute Date -> Kerio string in the owner's zone. */
function toKerio(date, offsetMinutes) {
  const s = new Date(date.getTime() + offsetMinutes * 60000);
  return `${s.getUTCFullYear()}${pad(s.getUTCMonth() + 1)}${pad(s.getUTCDate())}` +
    `T${pad(s.getUTCHours())}${pad(s.getUTCMinutes())}${pad(s.getUTCSeconds())}${formatOffset(offsetMinutes)}`;
}

/** Kerio string -> { date: absolute Date, allDay } (date-only strings are local midnight). */
function fromKerio(text, fallbackOffsetMinutes = 0) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})([+-]\d{4})?)?$/.exec(String(text || ''));
  if (!m) throw new Error(`Unexpected date from Kerio: ${text}`);
  const offset = m[7] ? parseOffset(m[7]) : fallbackOffsetMinutes;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - offset * 60000;
  return { date: new Date(ms), allDay: m[4] === undefined };
}

/** "2026-10-30 15:00" in the owner's zone (or "2026-10-30" for all-day). */
function formatLocal(date, offsetMinutes, { dateOnly = false } = {}) {
  const s = new Date(date.getTime() + offsetMinutes * 60000);
  const day = `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
  return dateOnly ? day : `${day} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
}

/** Day of week of an absolute moment in the owner's zone: 0 = Sunday ... 6 = Saturday. */
function weekdayLocal(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * 60000).getUTCDay();
}

/** Midnight (owner's zone) of the day containing the date. */
function startOfDayLocal(date, offsetMinutes) {
  const s = new Date(date.getTime() + offsetMinutes * 60000);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - offsetMinutes * 60000);
}

module.exports = {
  parseOffset, formatOffset, offsetOfKerioDate, parseInput, toKerio, fromKerio, formatLocal, weekdayLocal, startOfDayLocal
};
