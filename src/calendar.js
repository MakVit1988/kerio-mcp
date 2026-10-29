/**
 * Calendar, meetings, invitations and availability on top of KerioClient.
 */
const dates = require('./dates');

const ROLES = {
  required: 'RoleRequiredAttendee',
  optional: 'RoleOptionalAttendee',
  room: 'RoleRoom',
  equipment: 'RoleEquipment'
};
const FREE_BUSY = { busy: 'Busy', tentative: 'Tentative', free: 'Free', 'out-of-office': 'OutOfOffice', unavailable: 'NotAvailable' };
const FREQUENCY = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
const RESPONSES = { accept: 'PartAccepted', tentative: 'PartTentative', decline: 'PartDeclined' };
const SCOPES = { all: 'modifyAll', this: 'modifyThis', following: 'modifyAllFollowing' };
const PART_STATUS_TEXT = {
  PartNotResponded: 'no answer', PartAccepted: 'accepted', PartDeclined: 'declined',
  PartTentative: 'maybe', PartDelegated: 'delegated'
};
const BUSY_STATUSES = new Set(['Busy', 'Tentative', 'OutOfOffice', 'NotAvailable']);

const isOccurrenceId = id => String(id).includes('://occurrence/');

class Calendar {
  /** @param {import('./kerio-client').KerioClient} client */
  constructor(client, { offset } = {}) {
    this.client = client;
    this.offsetOverride = offset || process.env.KERIO_TIMEZONE_OFFSET || null;
    this.offsetMinutes = null;
  }

  /** Time zone offset of the mailbox owner in minutes (override, else seen in the mailbox, else this computer). */
  async offset() {
    if (this.offsetMinutes !== null) return this.offsetMinutes;
    if (this.offsetOverride) {
      this.offsetMinutes = dates.parseOffset(this.offsetOverride);
    } else {
      let found = null;
      try {
        const { mails } = await this.client.listMails({ folder: 'inbox', limit: 1 });
        found = mails[0] ? dates.offsetOfKerioDate(mails[0].receiveDate) : null;
      } catch (e) { /* fall back below */ }
      this.offsetMinutes = found !== null ? found : -new Date().getTimezoneOffset();
    }
    return this.offsetMinutes;
  }

  async calendarId(name) {
    const folders = (await this.client.listFolders()).filter(f => f.type === 'FCalendar');
    if (!folders.length) throw new Error('No calendar folder found in this mailbox');
    if (!name) return folders[0].id;
    const match = folders.find(f => f.name.toLowerCase() === String(name).toLowerCase());
    if (!match) throw new Error(`Calendar not found: ${name}. Available: ${folders.map(f => f.name).join(', ')}`);
    return match.id;
  }

  // ---- reading -----------------------------------------------------------

  /** Occurrences (recurring events expanded) between two dates, oldest first. */
  async listEvents({ from, to, calendar, limit = 50 } = {}) {
    const offset = await this.offset();
    const start = from ? dates.parseInput(from, offset) : dates.startOfDayLocal(new Date(), offset);
    const end = to ? dates.parseInput(to, offset) : new Date(start.getTime() + 7 * 86400000);
    if (end <= start) throw new Error('"to" must be later than "from"');
    const folderId = await this.calendarId(calendar);
    const result = await this.client.rpc('Occurrences.get', {
      folderIds: [folderId],
      query: {
        fields: ['id', 'eventId', 'summary', 'location', 'start', 'end', 'isAllDay', 'isRecurrent', 'freeBusy', 'isCancelled', 'attendees'],
        start: 0,
        limit,
        conditions: [
          { fieldName: 'start', comparator: 'GreaterEq', value: dates.toKerio(start, offset) },
          { fieldName: 'end', comparator: 'LessThan', value: dates.toKerio(end, offset) }
        ],
        combining: 'And',
        orderBy: [{ columnName: 'start', direction: 'Asc' }]
      }
    });
    return { total: result.totalItems, events: result.list, from: start, to: end };
  }

  async getEvent(id) {
    const result = isOccurrenceId(id)
      ? (await this.client.batch('Occurrences.getById', { ids: [id] })).result[0]
      : (await this.client.rpc('Events.getById', { id })).result;
    if (!result) throw new Error(`Event not found: ${id}`);
    return result;
  }

  // ---- changing ----------------------------------------------------------

  buildAttendees(attendees = []) {
    return attendees.map(a => {
      const spec = typeof a === 'string' ? { email: a } : a;
      const email = spec.email || spec.emailAddress;
      if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`Invalid attendee address: ${email}`);
      const role = ROLES[spec.role || 'required'];
      if (!role) throw new Error(`Unknown attendee role: ${spec.role} (use required, optional, room, equipment)`);
      return { displayName: spec.name || spec.displayName || '', emailAddress: email, role };
    });
  }

  buildRule(repeat) {
    if (!repeat) return { isSet: false };
    const frequency = FREQUENCY[String(repeat.frequency || '').toLowerCase()];
    if (!frequency) throw new Error('repeat.frequency must be daily, weekly, monthly or yearly');
    return {
      isSet: true,
      frequency,
      endBy: repeat.until
        ? { type: 'ByRecurrenceDate', date: repeat.untilKerio }
        : { type: 'ByRecurrenceNever', date: '' },
      preciseBy: { byDay: [], byMonthDay: [], byMonth: [], byPosition: [], byInterval: repeat.interval || 1 }
    };
  }

  /** Converts the user-facing arguments of create/update into the fields Kerio expects. */
  async buildFields(spec, existing) {
    const offset = await this.offset();
    const fields = {};
    for (const key of ['summary', 'location', 'description']) {
      if (spec[key] !== undefined) fields[key] = String(spec[key]);
    }
    if (spec.busy !== undefined) {
      fields.freeBusy = FREE_BUSY[spec.busy];
      if (!fields.freeBusy) throw new Error(`Unknown busy value: ${spec.busy} (use ${Object.keys(FREE_BUSY).join(', ')})`);
    }
    if (spec.private !== undefined) fields.isPrivate = Boolean(spec.private);
    if (spec.allDay !== undefined) fields.isAllDay = Boolean(spec.allDay);
    const allDay = fields.isAllDay !== undefined ? fields.isAllDay : existing ? existing.isAllDay : false;

    if (spec.start !== undefined || spec.end !== undefined || spec.durationMinutes !== undefined) {
      let start;
      if (spec.start !== undefined) start = dates.parseInput(spec.start, offset);
      else if (existing) start = dates.fromKerio(existing.start, offset).date;
      else throw new Error('start is required');

      let end;
      if (spec.end !== undefined) {
        end = dates.parseInput(spec.end, offset);
        if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(String(spec.end))) end = new Date(end.getTime() + 86400000); // inclusive last day
      } else if (spec.durationMinutes !== undefined) {
        end = new Date(start.getTime() + spec.durationMinutes * 60000);
      } else if (existing) {
        const old = dates.fromKerio(existing.end, offset).date;
        const oldStart = dates.fromKerio(existing.start, offset).date;
        end = new Date(start.getTime() + (old - oldStart));
      } else {
        end = new Date(start.getTime() + (allDay ? 86400000 : 3600000));
      }
      if (end <= start) throw new Error('The end must be later than the start');
      fields.start = dates.toKerio(start, offset);
      fields.end = dates.toKerio(end, offset);
    }
    if (spec.reminderMinutes !== undefined) {
      fields.reminder = spec.reminderMinutes === null || spec.reminderMinutes < 0
        ? { isSet: false }
        : { isSet: true, type: 'ReminderRelative', minutesBeforeStart: spec.reminderMinutes };
    }
    if (spec.attendees !== undefined) fields.attendees = this.buildAttendees(spec.attendees);
    if (spec.repeat !== undefined) {
      const repeat = spec.repeat && spec.repeat.until
        ? { ...spec.repeat, untilKerio: dates.toKerio(dates.parseInput(spec.repeat.until, offset), offset) }
        : spec.repeat;
      fields.rule = this.buildRule(repeat);
    }
    return fields;
  }

  /**
   * Creates an event. With attendees it is a meeting and Kerio e-mails the invitations.
   * @returns {Promise<string>} id of the new event
   */
  async createEvent(spec) {
    if (!spec.summary) throw new Error('summary is required');
    if (!spec.start) throw new Error('start is required');
    const folderId = await this.calendarId(spec.calendar);
    const fields = await this.buildFields({ reminderMinutes: 15, ...spec });
    const event = {
      folderId,
      description: '',
      location: '',
      freeBusy: 'Busy',
      isPrivate: false,
      isAllDay: false,
      label: 'None',
      priority: 'Normal',
      attendees: [],
      rule: { isSet: false },
      ...fields
    };
    const result = await this.client.batch('Events.create', { events: [event] });
    return result.result[0].id;
  }

  /**
   * Changes an event. An event id changes the whole event; an occurrence id changes that
   * occurrence, the following ones, or the whole series, depending on `scope`.
   */
  async updateEvent(id, spec, { scope = 'all' } = {}) {
    const modification = SCOPES[scope];
    if (!modification) throw new Error('scope must be all, this or following');
    const existing = await this.getEvent(id);
    const fields = await this.buildFields(spec, existing);
    if (!Object.keys(fields).length) throw new Error('Nothing to change');
    if (isOccurrenceId(id)) {
      await this.client.batch('Occurrences.set', { occurrences: [{ id, ...fields, modification }] });
    } else {
      await this.client.batch('Events.set', { events: [{ id, ...fields }] });
    }
    return Object.keys(fields);
  }

  /** Deletes an event (cancelling the meeting for its attendees) or one/following occurrences. */
  async deleteEvent(id, { scope = 'all' } = {}) {
    const modification = SCOPES[scope];
    if (!modification) throw new Error('scope must be all, this or following');
    if (isOccurrenceId(id)) {
      await this.client.batch('Occurrences.remove', { occurrences: [{ id, modification }] });
    } else {
      await this.client.batch('Events.remove', { ids: [id] });
    }
  }

  // ---- invitations -------------------------------------------------------

  /** Invitations and updates waiting in the calendar inbox. */
  async listInvitations() {
    const result = await this.client.rpc('Events.getEventUpdateList', {});
    return result.eventUpdates;
  }

  /** Answers an invitation; the organizer is told. */
  async respond(id, answer, message = '') {
    const status = RESPONSES[answer];
    if (!status) throw new Error('response must be accept, tentative or decline');
    await this.client.rpc('Occurrences.setPartStatus', { id, response: { status, message } });
  }

  // ---- availability ------------------------------------------------------

  /** Busy intervals per address between two dates. */
  async busyTimes({ emails, from, to }) {
    const offset = await this.offset();
    const start = dates.parseInput(from, offset);
    const end = dates.parseInput(to, offset);
    if (end <= start) throw new Error('"to" must be later than "from"');
    const result = await this.client.rpc('FreeBusy.get', {
      userAddresses: emails,
      start: dates.toKerio(start, offset),
      end: dates.toKerio(end, offset)
    });
    return emails.map((email, i) => {
      const intervals = (result.list[i] || []).map(x => ({
        status: x.status,
        start: dates.fromKerio(x.start, offset).date,
        end: dates.fromKerio(x.end, offset).date
      }));
      // For an address without a calendar on this server Kerio answers "not available" for the whole period.
      const unknown = intervals.length === 1 && intervals[0].status === 'NotAvailable' &&
        intervals[0].start <= start && intervals[0].end >= end;
      return { email, unknown, busy: unknown ? [] : intervals.filter(x => BUSY_STATUSES.has(x.status)) };
    });
  }

  /** Common free slots of several people during working hours. */
  async findMeetingTimes({ emails, from, to, durationMinutes = 60, workdayStart = '09:00', workdayEnd = '18:00', weekdaysOnly = true, limit = 5 }) {
    const offset = await this.offset();
    const people = await this.busyTimes({ emails, from, to });
    const range = { start: dates.parseInput(from, offset), end: dates.parseInput(to, offset) };
    const slots = findFreeSlots({
      busy: people.flatMap(p => p.busy),
      range, durationMinutes, workdayStart, workdayEnd, weekdaysOnly, offsetMinutes: offset, limit
    });
    return { people, slots, unknown: people.filter(p => p.unknown).map(p => p.email) };
  }
}

const toMinutes = hhmm => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time of day: ${hhmm} (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * Slots of the given length (starting every 30 minutes) that fall inside working hours and
 * overlap none of the busy intervals. Pure function, easy to test.
 */
function findFreeSlots({ busy, range, durationMinutes, workdayStart, workdayEnd, weekdaysOnly, offsetMinutes, limit }) {
  const startMin = toMinutes(workdayStart);
  const endMin = toMinutes(workdayEnd);
  const duration = durationMinutes * 60000;
  const step = 30 * 60000;
  const slots = [];
  const intervals = [...busy].sort((a, b) => a.start - b.start);
  for (let day = dates.startOfDayLocal(range.start, offsetMinutes); day < range.end; day = new Date(day.getTime() + 86400000)) {
    const weekday = dates.weekdayLocal(new Date(day.getTime() + 12 * 3600000), offsetMinutes);
    if (weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    const dayStart = new Date(day.getTime() + startMin * 60000);
    const dayEnd = new Date(day.getTime() + endMin * 60000);
    for (let t = dayStart; t.getTime() + duration <= dayEnd.getTime(); t = new Date(t.getTime() + step)) {
      const slotEnd = new Date(t.getTime() + duration);
      if (t < range.start || slotEnd > range.end) continue;
      if (intervals.some(b => b.start < slotEnd && b.end > t)) continue;
      slots.push({ start: t, end: slotEnd });
      if (slots.length >= limit) return slots;
    }
  }
  return slots;
}

module.exports = { Calendar, findFreeSlots, PART_STATUS_TEXT, RESPONSES, isOccurrenceId };
