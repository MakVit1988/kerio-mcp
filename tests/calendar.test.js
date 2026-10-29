const { Calendar, findFreeSlots } = require('../src/calendar');
const dates = require('../src/dates');

const CAL = 'keriostorage://folder/d/u/cal';

function makeCalendar(over = {}) {
  const client = {
    listFolders: jest.fn(async () => [{ id: 'F-INBOX', name: 'INBOX', type: 'FMail' }, { id: CAL, name: 'Calendar', type: 'FCalendar' }]),
    listMails: jest.fn(async () => ({ mails: [{ receiveDate: '20261028T155541+0300' }] })),
    rpc: jest.fn(async () => ({})),
    batch: jest.fn(async () => ({ result: [{ id: 'EV1' }] })),
    ...over
  };
  return { client, calendar: new Calendar(client) };
}

describe('time zone', () => {
  test('is taken from the mailbox', async () => {
    const { calendar } = makeCalendar();
    expect(await calendar.offset()).toBe(180);
  });
  test('an override wins', async () => {
    const calendar = new Calendar({}, { offset: '+05:00' });
    expect(await calendar.offset()).toBe(300);
  });
});

describe('listEvents', () => {
  test('asks for occurrences in the range, in the owner zone', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ list: [{ id: 'o1' }], totalItems: 1 });
    const r = await calendar.listEvents({ from: '2026-10-30', to: '2026-11-02' });
    const [method, params] = client.rpc.mock.calls[0];
    expect(method).toBe('Occurrences.get');
    expect(params.folderIds).toEqual([CAL]);
    expect(params.query.conditions).toEqual([
      { fieldName: 'start', comparator: 'GreaterEq', value: '20261030T000000+0300' },
      { fieldName: 'end', comparator: 'LessThan', value: '20261102T000000+0300' }
    ]);
    expect(r.events).toEqual([{ id: 'o1' }]);
  });
  test('rejects an empty period', async () => {
    const { calendar } = makeCalendar();
    await expect(calendar.listEvents({ from: '2026-10-30', to: '2026-10-29' })).rejects.toThrow(/later/);
  });
  test('names the available calendars when one is not found', async () => {
    const { calendar } = makeCalendar();
    await expect(calendar.calendarId('Nope')).rejects.toThrow(/Available: Calendar/);
  });
});

describe('createEvent', () => {
  test('builds a plain event with a default 15 minute reminder and 1 hour length', async () => {
    const { client, calendar } = makeCalendar();
    const id = await calendar.createEvent({ summary: 'Call', start: '2026-10-30T15:00', location: 'Room 1' });
    expect(id).toBe('EV1');
    const [method, params] = client.batch.mock.calls[0];
    expect(method).toBe('Events.create');
    expect(params.events[0]).toMatchObject({
      folderId: CAL, summary: 'Call', location: 'Room 1', start: '20261030T150000+0300', end: '20261030T160000+0300',
      isAllDay: false, attendees: [], rule: { isSet: false }, reminder: { isSet: true, type: 'ReminderRelative', minutesBeforeStart: 15 }
    });
  });

  test('a meeting carries the attendees with roles', async () => {
    const { client, calendar } = makeCalendar();
    await calendar.createEvent({
      summary: 'Sync', start: '2026-10-30T10:00', durationMinutes: 30,
      attendees: ['a@x.y', { email: 'b@x.y', name: 'Bob', role: 'optional' }, { email: 'room@x.y', role: 'room' }]
    });
    const event = client.batch.mock.calls[0][1].events[0];
    expect(event.end).toBe('20261030T103000+0300');
    expect(event.attendees).toEqual([
      { displayName: '', emailAddress: 'a@x.y', role: 'RoleRequiredAttendee' },
      { displayName: 'Bob', emailAddress: 'b@x.y', role: 'RoleOptionalAttendee' },
      { displayName: '', emailAddress: 'room@x.y', role: 'RoleRoom' }
    ]);
  });

  test('whole-day events: the end date is the last day, inclusive', async () => {
    const { client, calendar } = makeCalendar();
    await calendar.createEvent({ summary: 'Trip', start: '2026-10-30', end: '2026-11-01', allDay: true });
    const event = client.batch.mock.calls[0][1].events[0];
    expect(event).toMatchObject({ isAllDay: true, start: '20261030T000000+0300', end: '20261102T000000+0300' });
  });

  test('a weekly series until a date', async () => {
    const { client, calendar } = makeCalendar();
    await calendar.createEvent({ summary: 'Weekly', start: '2026-11-02T09:00', repeat: { frequency: 'weekly', interval: 2, until: '2026-11-30' } });
    expect(client.batch.mock.calls[0][1].events[0].rule).toEqual({
      isSet: true, frequency: 'Weekly', endBy: { type: 'ByRecurrenceDate', date: '20261130T000000+0300' },
      preciseBy: { byDay: [], byMonthDay: [], byMonth: [], byPosition: [], byInterval: 2 }
    });
  });

  test.each([
    [{ start: '2026-10-30T10:00' }, /summary is required/],
    [{ summary: 'x' }, /start is required/],
    [{ summary: 'x', start: '2026-10-30T10:00', end: '2026-10-30T09:00' }, /later than the start/],
    [{ summary: 'x', start: '2026-10-30T10:00', attendees: ['not-an-address'] }, /Invalid attendee/],
    [{ summary: 'x', start: '2026-10-30T10:00', attendees: [{ email: 'a@b.c', role: 'boss' }] }, /Unknown attendee role/],
    [{ summary: 'x', start: '2026-10-30T10:00', busy: 'maybe' }, /Unknown busy value/],
    [{ summary: 'x', start: '2026-10-30T10:00', repeat: { frequency: 'hourly' } }, /repeat.frequency/]
  ])('rejects bad input %#', async (spec, message) => {
    const { client, calendar } = makeCalendar();
    await expect(calendar.createEvent(spec)).rejects.toThrow(message);
    expect(client.batch).not.toHaveBeenCalled();
  });
});

describe('updateEvent and deleteEvent', () => {
  const existing = { id: 'EV1', summary: 'Old', start: '20261030T100000+0300', end: '20261030T113000+0300', isAllDay: false };

  test('moving the start keeps the length', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ result: existing });
    const changed = await calendar.updateEvent('keriostorage://event/d/u/f/1', { start: '2026-10-31T14:00' });
    expect(changed).toEqual(['start', 'end']);
    expect(client.batch).toHaveBeenCalledWith('Events.set', {
      events: [{ id: 'keriostorage://event/d/u/f/1', start: '20261031T140000+0300', end: '20261031T153000+0300' }]
    });
  });

  test('an occurrence goes through Occurrences.set with the scope', async () => {
    const { client, calendar } = makeCalendar();
    client.batch.mockImplementation(async method => (method === 'Occurrences.getById' ? { result: [existing] } : { result: [] }));
    await calendar.updateEvent('keriostorage://occurrence/d/u/f/1/', { summary: 'New' }, { scope: 'this' });
    expect(client.batch).toHaveBeenLastCalledWith('Occurrences.set', {
      occurrences: [{ id: 'keriostorage://occurrence/d/u/f/1/', summary: 'New', modification: 'modifyThis' }]
    });
  });

  test('refuses an empty update and a bad scope', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ result: existing });
    await expect(calendar.updateEvent('keriostorage://event/x', {})).rejects.toThrow(/Nothing to change/);
    await expect(calendar.updateEvent('keriostorage://event/x', { summary: 'a' }, { scope: 'weekly' })).rejects.toThrow(/scope/);
  });

  test('delete: whole event vs one occurrence', async () => {
    const { client, calendar } = makeCalendar();
    await calendar.deleteEvent('keriostorage://event/d/u/f/1');
    expect(client.batch).toHaveBeenLastCalledWith('Events.remove', { ids: ['keriostorage://event/d/u/f/1'] });
    await calendar.deleteEvent('keriostorage://occurrence/d/u/f/1/', { scope: 'this' });
    expect(client.batch).toHaveBeenLastCalledWith('Occurrences.remove', {
      occurrences: [{ id: 'keriostorage://occurrence/d/u/f/1/', modification: 'modifyThis' }]
    });
  });
});

describe('invitations', () => {
  test('respond maps the answer to a participation status', async () => {
    const { client, calendar } = makeCalendar();
    await calendar.respond('EV1', 'tentative', 'maybe');
    expect(client.rpc).toHaveBeenCalledWith('Occurrences.setPartStatus', { id: 'EV1', response: { status: 'PartTentative', message: 'maybe' } });
    await expect(calendar.respond('EV1', 'perhaps')).rejects.toThrow(/accept, tentative or decline/);
  });
  test('lists the waiting updates', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ eventUpdates: [{ summary: 'S' }] });
    expect(await calendar.listInvitations()).toEqual([{ summary: 'S' }]);
  });
});

describe('availability', () => {
  test('busyTimes keeps only busy intervals per person, in order', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ list: [[{ status: 'Busy', start: '20261030T100000+0300', end: '20261030T110000+0300' }, { status: 'Free', start: '20261030T120000+0300', end: '20261030T130000+0300' }], []] });
    const people = await calendar.busyTimes({ emails: ['a@x.y', 'b@x.y'], from: '2026-10-30', to: '2026-10-31' });
    expect(client.rpc).toHaveBeenCalledWith('FreeBusy.get', { userAddresses: ['a@x.y', 'b@x.y'], start: '20261030T000000+0300', end: '20261031T000000+0300' });
    expect(people[0].busy).toHaveLength(1);
    expect(people[0].busy[0].start.toISOString()).toBe('2026-10-30T07:00:00.000Z');
    expect(people[1].busy).toEqual([]);
  });
});

describe('people without a calendar here', () => {
  test('are reported as unknown instead of busy', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ list: [[{ status: 'NotAvailable', start: '20261030T000000+0300', end: '20261031T000000+0300' }], []] });
    const people = await calendar.busyTimes({ emails: ['x@other.org', 'me@here.ru'], from: '2026-10-30', to: '2026-10-31' });
    expect(people[0]).toMatchObject({ email: 'x@other.org', unknown: true, busy: [] });
    expect(people[1]).toMatchObject({ unknown: false, busy: [] });
  });
  test('a real out-of-office block is still busy', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ list: [[{ status: 'OutOfOffice', start: '20261030T100000+0300', end: '20261030T120000+0300' }]] });
    const [p] = await calendar.busyTimes({ emails: ['a@x.y'], from: '2026-10-30', to: '2026-10-31' });
    expect(p.unknown).toBe(false);
    expect(p.busy).toHaveLength(1);
  });
});

describe('findFreeSlots', () => {
  const offset = 180;
  const at = (day, hhmm) => dates.parseInput(`${day}T${hhmm}`, offset);
  const base = { workdayStart: '09:00', workdayEnd: '18:00', weekdaysOnly: true, offsetMinutes: offset, limit: 10, durationMinutes: 60 };

  test('skips busy time and works in 30 minute steps', () => {
    const slots = findFreeSlots({
      ...base, limit: 3,
      range: { start: at('2026-10-30', '00:00'), end: at('2026-10-31', '00:00') }, // Friday
      busy: [{ start: at('2026-10-30', '09:00'), end: at('2026-10-30', '10:15') }]
    });
    expect(slots.map(s => dates.formatLocal(s.start, offset))).toEqual(['2026-10-30 10:30', '2026-10-30 11:00', '2026-10-30 11:30']);
  });

  test('stays inside working hours and skips weekends', () => {
    const slots = findFreeSlots({ ...base, limit: 100, durationMinutes: 90, range: { start: at('2026-10-31', '00:00'), end: at('2026-11-02', '00:00') }, busy: [] });
    expect(slots).toEqual([]); // Saturday and Sunday only
    const friday = findFreeSlots({ ...base, limit: 100, durationMinutes: 90, range: { start: at('2026-10-30', '00:00'), end: at('2026-10-31', '00:00') }, busy: [] });
    expect(dates.formatLocal(friday[0].start, offset)).toBe('2026-10-30 09:00');
    expect(dates.formatLocal(friday[friday.length - 1].end, offset)).toBe('2026-10-30 18:00');
  });

  test('respects the search range', () => {
    const slots = findFreeSlots({ ...base, limit: 2, range: { start: at('2026-10-30', '13:10'), end: at('2026-10-30', '16:00') }, busy: [] });
    expect(slots.map(s => dates.formatLocal(s.start, offset))).toEqual(['2026-10-30 13:30', '2026-10-30 14:00']);
  });

  test('findMeetingTimes combines everyone', async () => {
    const { client, calendar } = makeCalendar();
    client.rpc.mockResolvedValue({ list: [
      [{ status: 'Busy', start: '20261030T090000+0300', end: '20261030T120000+0300' }],
      [{ status: 'Tentative', start: '20261030T120000+0300', end: '20261030T130000+0300' }]
    ] });
    const { slots } = await calendar.findMeetingTimes({ emails: ['a@x.y', 'b@x.y'], from: '2026-10-30', to: '2026-10-31', limit: 1 });
    expect(dates.formatLocal(slots[0].start, 180)).toBe('2026-10-30 13:00');
  });
});
