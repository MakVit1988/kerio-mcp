/**
 * MCP tools for the calendar, meetings, invitations and availability.
 */
const dates = require('./dates');
const { PART_STATUS_TEXT } = require('./calendar');

const text = value => ({ content: [{ type: 'text', text: value }] });
const failure = error => ({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
const wrap = handler => async args => {
  try {
    return await handler(args || {});
  } catch (error) {
    return failure(error);
  }
};

const DATE_HELP = 'Local time of the mailbox: 2026-10-30 (whole day) or 2026-10-30T15:00. An explicit offset such as +03:00 is also accepted.';
const dateSchema = description => ({ type: 'string', description: `${description} ${DATE_HELP}` });
const scopeSchema = {
  type: 'string',
  enum: ['all', 'this', 'following'],
  default: 'all',
  description: 'For recurring events given by an occurrence id: change only this occurrence, this and the following ones, or the whole series.'
};
const attendeesSchema = {
  type: 'array',
  description:
    'People to invite (this makes the event a meeting and Kerio e-mails the invitations): addresses, or ' +
    '{ "email", "name", "role": required | optional | room | equipment }.',
  items: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          email: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string', enum: ['required', 'optional', 'room', 'equipment'] }
        },
        required: ['email']
      }
    ]
  }
};
const repeatSchema = {
  type: 'object',
  description: 'Repeat the event.',
  properties: {
    frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
    interval: { type: 'number', description: 'Every N days/weeks/months/years (default 1)' },
    until: dateSchema('Last day of the series.')
  },
  required: ['frequency']
};
const eventFields = {
  summary: { type: 'string', description: 'Title' },
  location: { type: 'string' },
  description: { type: 'string' },
  allDay: { type: 'boolean', description: 'Whole-day event' },
  reminderMinutes: { type: 'number', description: 'Reminder this many minutes before the start; -1 for none (default 15 for new events)' },
  busy: { type: 'string', enum: ['busy', 'tentative', 'free', 'out-of-office', 'unavailable'], description: 'How the time shows to others' },
  private: { type: 'boolean' },
  attendees: attendeesSchema,
  repeat: repeatSchema
};

function describeRule(rule) {
  if (!rule || !rule.isSet) return null;
  const every = rule.preciseBy && rule.preciseBy.byInterval > 1 ? ` every ${rule.preciseBy.byInterval}` : '';
  const until = rule.endBy && rule.endBy.type === 'ByRecurrenceDate' ? `, until ${String(rule.endBy.date).slice(0, 8)}` : '';
  return `${rule.frequency.toLowerCase()}${every}${until}`;
}

function createCalendarTools(calendar) {
  const when = async event => {
    const offset = await calendar.offset();
    const start = dates.fromKerio(event.start, offset);
    const end = dates.fromKerio(event.end, offset);
    if (start.allDay) {
      const lastDay = new Date(end.date.getTime() - 86400000);
      const same = lastDay <= start.date;
      return `${dates.formatLocal(start.date, offset, { dateOnly: true })}${same ? '' : ' to ' + dates.formatLocal(lastDay, offset, { dateOnly: true })} (all day)`;
    }
    const sameDay = dates.formatLocal(start.date, offset, { dateOnly: true }) === dates.formatLocal(end.date, offset, { dateOnly: true });
    return `${dates.formatLocal(start.date, offset)}-${sameDay ? dates.formatLocal(end.date, offset).slice(11) : dates.formatLocal(end.date, offset)}`;
  };

  const eventLine = async occurrence => {
    const marks = [occurrence.isRecurrent ? 'repeats' : null, occurrence.isCancelled ? 'CANCELLED' : null,
      occurrence.attendees && occurrence.attendees.length ? `${occurrence.attendees.length} attendee(s)` : null].filter(Boolean);
    return `${await when(occurrence)} | ${occurrence.summary}${occurrence.location ? ' | ' + occurrence.location : ''}` +
      `${marks.length ? ' [' + marks.join(', ') + ']' : ''}\n    id: ${occurrence.id}`;
  };

  return [
    {
      name: 'list-events',
      description: 'List calendar events (recurring ones expanded) between two dates; by default the next 7 days.',
      inputSchema: {
        type: 'object',
        properties: {
          from: dateSchema('Start of the period (default: today).'),
          to: dateSchema('End of the period, exclusive (default: 7 days after the start).'),
          calendar: { type: 'string', description: 'Calendar name (default: the main calendar)' },
          limit: { type: 'number', default: 50 }
        }
      },
      handler: wrap(async ({ from, to, calendar: name, limit = 50 }) => {
        const result = await calendar.listEvents({ from, to, calendar: name, limit: Math.min(limit, 200) });
        const offset = await calendar.offset();
        const period = `${dates.formatLocal(result.from, offset)} - ${dates.formatLocal(result.to, offset)}`;
        if (!result.events.length) return text(`No events ${period}.`);
        const lines = [];
        for (const e of result.events) lines.push(await eventLine(e));
        return text(`${result.events.length} event(s) ${period}\n\n${lines.join('\n')}`);
      })
    },
    {
      name: 'read-event',
      description: 'Show one event or meeting in full: time, place, description, attendees and their answers.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Event or occurrence id' } }, required: ['id'] },
      handler: wrap(async ({ id }) => {
        if (!id) throw new Error('id is required');
        const e = await calendar.getEvent(id);
        const lines = [
          `Title: ${e.summary}`,
          `When: ${await when(e)}`,
          e.location ? `Where: ${e.location}` : null,
          describeRule(e.rule) ? `Repeats: ${describeRule(e.rule)}` : null,
          e.isCancelled ? 'This event was cancelled by the organizer.' : null,
          e.reminder && e.reminder.isSet ? `Reminder: ${e.reminder.minutesBeforeStart} min before` : null,
          `Shows as: ${e.freeBusy}${e.isPrivate ? ', private' : ''}`
        ].filter(Boolean);
        if (e.attendees && e.attendees.length) {
          lines.push('Attendees:');
          for (const a of e.attendees) {
            const role = a.role === 'RoleOrganizer' ? ' (organizer)' : a.role === 'RoleOptionalAttendee' ? ' (optional)' : '';
            lines.push(`  ${a.displayName ? a.displayName + ' ' : ''}<${a.emailAddress}>${role}: ${PART_STATUS_TEXT[a.partStatus] || a.partStatus}`);
          }
        }
        lines.push(`id: ${e.id}`);
        return text(`${lines.join('\n')}${e.description ? '\n\n' + e.description : ''}`);
      })
    },
    {
      name: 'create-event',
      description:
        'Create a calendar event. With "attendees" it becomes a meeting and Kerio e-mails the invitations to those people: ' +
        'confirm the attendees and the time with the user before calling.',
      inputSchema: {
        type: 'object',
        properties: {
          ...eventFields,
          start: dateSchema('Start.'),
          end: dateSchema('End (default: start + 1 hour, or the next day for whole-day events). For a whole-day event it is the last day, inclusive.'),
          durationMinutes: { type: 'number', description: 'Length instead of "end"' },
          calendar: { type: 'string', description: 'Calendar name (default: the main calendar)' }
        },
        required: ['summary', 'start']
      },
      handler: wrap(async spec => {
        const id = await calendar.createEvent(spec);
        const e = await calendar.getEvent(id);
        const invited = spec.attendees && spec.attendees.length ? `\nInvitations sent to ${spec.attendees.length} attendee(s).` : '';
        return text(`Event created: ${await when(e)} | ${e.summary}${invited}\nid: ${id}`);
      })
    },
    {
      name: 'update-event',
      description:
        'Change an event or meeting; only the given fields change. Changing attendees or the time of a meeting notifies the attendees.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Event id (whole event) or occurrence id (see "scope")' },
          ...eventFields,
          start: dateSchema('New start (the length is kept unless "end" is given).'),
          end: dateSchema('New end.'),
          durationMinutes: { type: 'number' },
          scope: scopeSchema
        },
        required: ['id']
      },
      handler: wrap(async ({ id, scope, ...spec }) => {
        if (!id) throw new Error('id is required');
        const changed = await calendar.updateEvent(id, spec, { scope });
        return text(`Updated: ${changed.join(', ')}.`);
      })
    },
    {
      name: 'delete-event',
      description:
        'Delete an event. If you organise a meeting, the attendees are told it is cancelled: confirm with the user first.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Event id (whole event) or occurrence id' }, scope: scopeSchema },
        required: ['id']
      },
      handler: wrap(async ({ id, scope }) => {
        if (!id) throw new Error('id is required');
        await calendar.deleteEvent(id, { scope });
        return text('Event deleted.');
      })
    },
    {
      name: 'list-invitations',
      description: 'List meeting invitations, changes and cancellations waiting in the calendar inbox.',
      inputSchema: { type: 'object', properties: {} },
      handler: wrap(async () => {
        const updates = await calendar.listInvitations();
        if (!updates.length) return text('No invitations waiting.');
        const offset = await calendar.offset();
        const kinds = { EUpdateRequest: 'invitation', EUpdateReply: 'reply', EUpdateCancel: 'cancelled' };
        const lines = updates.map(u => {
          const start = u.start ? dates.formatLocal(dates.fromKerio(u.start, offset).date, offset) : '?';
          const who = u.attendee && u.attendee.emailAddress ? ` | from ${u.attendee.displayName || u.attendee.emailAddress}` : '';
          return `[${kinds[u.type] || u.type}${u.isObsolete ? ', outdated' : ''}] ${start} | ${u.summary}${u.location ? ' | ' + u.location : ''}${who}\n` +
            `    event: ${u.occurrenceId || u.eventId}`;
        });
        return text(`${updates.length} item(s)\n\n${lines.join('\n')}\n\nAnswer with respond-to-invitation using the event id.`);
      })
    },
    {
      name: 'respond-to-invitation',
      description: 'Accept, tentatively accept or decline a meeting invitation. The organizer is told your answer.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Event or occurrence id from list-invitations' },
          response: { type: 'string', enum: ['accept', 'tentative', 'decline'] },
          message: { type: 'string', description: 'Optional note to the organizer' }
        },
        required: ['id', 'response']
      },
      handler: wrap(async ({ id, response, message }) => {
        if (!id) throw new Error('id is required');
        await calendar.respond(id, response, message || '');
        return text(`Answer sent: ${response}.`);
      })
    },
    {
      name: 'check-availability',
      description: 'Show when the given people are busy between two dates (people on this server only; others show as free).',
      inputSchema: {
        type: 'object',
        properties: {
          emails: { type: 'array', items: { type: 'string' }, minItems: 1 },
          from: dateSchema('Start of the period.'),
          to: dateSchema('End of the period.')
        },
        required: ['emails', 'from', 'to']
      },
      handler: wrap(async ({ emails, from, to }) => {
        if (!emails || !emails.length) throw new Error('emails is required');
        const offset = await calendar.offset();
        const people = await calendar.busyTimes({ emails, from, to });
        const lines = people.map(p => {
          if (p.unknown) return `${p.email}: availability unknown (no calendar on this server)`;
          if (!p.busy.length) return `${p.email}: free for the whole period`;
          const blocks = p.busy.map(b => `  ${dates.formatLocal(b.start, offset)} - ${dates.formatLocal(b.end, offset).slice(11)}${b.status === 'Busy' ? '' : ' (' + b.status + ')'}`);
          return `${p.email}: busy\n${blocks.join('\n')}`;
        });
        return text(lines.join('\n'));
      })
    },
    {
      name: 'find-meeting-time',
      description: 'Find times when all the given people are free, within working hours (weekdays), for a meeting of the given length.',
      inputSchema: {
        type: 'object',
        properties: {
          emails: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Participants (add the mailbox owner too if they take part)' },
          from: dateSchema('Search from.'),
          to: dateSchema('Search until.'),
          durationMinutes: { type: 'number', default: 60 },
          workdayStart: { type: 'string', default: '09:00' },
          workdayEnd: { type: 'string', default: '18:00' },
          limit: { type: 'number', default: 5, description: 'How many options' }
        },
        required: ['emails', 'from', 'to']
      },
      handler: wrap(async ({ emails, from, to, durationMinutes = 60, workdayStart, workdayEnd, limit = 5 }) => {
        if (!emails || !emails.length) throw new Error('emails is required');
        const offset = await calendar.offset();
        const { slots, unknown } = await calendar.findMeetingTimes({ emails, from, to, durationMinutes, workdayStart, workdayEnd, limit });
        const note = unknown && unknown.length ? `\nNot checked (no calendar on this server): ${unknown.join(', ')}` : '';
        if (!slots.length) return text(`No common free time of ${durationMinutes} min in that period.${note}`);
        const lines = slots.map(s => `${dates.formatLocal(s.start, offset)} - ${dates.formatLocal(s.end, offset).slice(11)}`);
        return text(`Free for everyone (${durationMinutes} min):\n${lines.join('\n')}${note}`);
      })
    }
  ];
}

module.exports = { createCalendarTools };
