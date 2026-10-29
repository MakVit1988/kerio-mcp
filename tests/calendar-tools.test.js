const { createCalendarTools } = require('../src/calendar-tools');

const fakeCalendar = over => ({
  offset: jest.fn(async () => 180),
  listEvents: jest.fn(),
  getEvent: jest.fn(),
  createEvent: jest.fn(),
  updateEvent: jest.fn(),
  deleteEvent: jest.fn(),
  listInvitations: jest.fn(),
  respond: jest.fn(),
  busyTimes: jest.fn(),
  findMeetingTimes: jest.fn(),
  ...over
});
const tool = (calendar, name) => createCalendarTools(calendar).find(t => t.name === name);

test('list-events shows time, title, place and ids', async () => {
  const calendar = fakeCalendar({
    listEvents: jest.fn(async () => ({
      from: new Date('2026-10-29T21:00:00Z'), to: new Date('2026-11-05T21:00:00Z'),
      events: [
        { id: 'o1', summary: 'Planning', location: 'Room 5', start: '20261030T100000+0300', end: '20261030T113000+0300', isRecurrent: true, attendees: [{}, {}] },
        { id: 'o2', summary: 'Holiday', start: '20261031', end: '20261101', isAllDay: true },
        { id: 'o3', summary: 'Trip', start: '20261031', end: '20261103', isAllDay: true }
      ]
    }))
  });
  const out = await tool(calendar, 'list-events').handler({});
  const body = out.content[0].text;
  expect(body).toContain('2026-10-30 10:00-11:30 | Planning | Room 5 [repeats, 2 attendee(s)]');
  expect(body).toContain('2026-10-31 (all day) | Holiday');
  expect(body).toContain('2026-10-31 to 2026-11-02 (all day) | Trip');
  expect(body).toContain('id: o1');
});

test('list-events says so when nothing is planned', async () => {
  const calendar = fakeCalendar({ listEvents: jest.fn(async () => ({ from: new Date(0), to: new Date(86400000), events: [] })) });
  const out = await tool(calendar, 'list-events').handler({});
  expect(out.content[0].text).toMatch(/^No events/);
});

test('read-event lists attendees with their answers', async () => {
  const calendar = fakeCalendar({
    getEvent: jest.fn(async () => ({
      id: 'e1', summary: 'Sync', location: 'Zoom', description: 'Agenda', start: '20261030T150000+0300', end: '20261030T160000+0300',
      freeBusy: 'Busy', isPrivate: false, reminder: { isSet: true, minutesBeforeStart: 15 }, rule: { isSet: false },
      attendees: [
        { displayName: 'Boss', emailAddress: 'boss@x.y', role: 'RoleOrganizer', partStatus: 'PartAccepted' },
        { displayName: '', emailAddress: 'a@x.y', role: 'RoleOptionalAttendee', partStatus: 'PartNotResponded' }
      ]
    }))
  });
  const text = (await tool(calendar, 'read-event').handler({ id: 'e1' })).content[0].text;
  expect(text).toContain('When: 2026-10-30 15:00-16:00');
  expect(text).toContain('Boss <boss@x.y> (organizer): accepted');
  expect(text).toContain('<a@x.y> (optional): no answer');
  expect(text).toContain('Reminder: 15 min before');
  expect(text.endsWith('Agenda')).toBe(true);
});

test('create-event passes the arguments through and reports invitations', async () => {
  const calendar = fakeCalendar({
    createEvent: jest.fn(async () => 'e9'),
    getEvent: jest.fn(async () => ({ id: 'e9', summary: 'Meet', start: '20261030T150000+0300', end: '20261030T160000+0300' }))
  });
  const spec = { summary: 'Meet', start: '2026-10-30T15:00', attendees: ['a@x.y', 'b@x.y'] };
  const out = await tool(calendar, 'create-event').handler(spec);
  expect(calendar.createEvent).toHaveBeenCalledWith(spec);
  expect(out.content[0].text).toContain('Invitations sent to 2 attendee(s).');
  expect(out.content[0].text).toContain('id: e9');
});

test('update-event splits id and scope from the fields', async () => {
  const calendar = fakeCalendar({ updateEvent: jest.fn(async () => ['start', 'end']) });
  await tool(calendar, 'update-event').handler({ id: 'o1', scope: 'this', start: '2026-10-31T10:00' });
  expect(calendar.updateEvent).toHaveBeenCalledWith('o1', { start: '2026-10-31T10:00' }, { scope: 'this' });
});

test('errors become tool errors', async () => {
  const calendar = fakeCalendar({ deleteEvent: jest.fn(async () => { throw new Error('nope'); }) });
  const out = await tool(calendar, 'delete-event').handler({ id: 'e1' });
  expect(out).toEqual({ content: [{ type: 'text', text: 'Error: nope' }], isError: true });
  const noId = await tool(calendar, 'respond-to-invitation').handler({ response: 'accept' });
  expect(noId.isError).toBe(true);
});

test('list-invitations explains each item', async () => {
  const calendar = fakeCalendar({
    listInvitations: jest.fn(async () => [
      { type: 'EUpdateRequest', summary: 'Kickoff', start: '20261102T100000+0300', location: 'HQ', attendee: { displayName: 'Anna', emailAddress: 'a@x.y' }, eventId: 'e1', occurrenceId: 'o1' },
      { type: 'EUpdateCancel', summary: 'Old', start: '20261103T100000+0300', isObsolete: true, eventId: 'e2' }
    ])
  });
  const text = (await tool(calendar, 'list-invitations').handler({})).content[0].text;
  expect(text).toContain('[invitation] 2026-11-02 10:00 | Kickoff | HQ | from Anna');
  expect(text).toContain('event: o1');
  expect(text).toContain('[cancelled, outdated]');
});

test('check-availability and find-meeting-time print readable results', async () => {
  const busy = { email: 'a@x.y', unknown: false, busy: [{ status: 'Busy', start: new Date('2026-10-30T07:00:00Z'), end: new Date('2026-10-30T08:30:00Z') }] };
  const calendar = fakeCalendar({
    busyTimes: jest.fn(async () => [busy, { email: 'b@x.y', unknown: false, busy: [] }, { email: 'c@other.org', unknown: true, busy: [] }]),
    findMeetingTimes: jest.fn(async () => ({ unknown: ['c@other.org'], slots: [{ start: new Date('2026-10-30T09:00:00Z'), end: new Date('2026-10-30T10:00:00Z') }] }))
  });
  const avail = (await tool(calendar, 'check-availability').handler({ emails: ['a@x.y', 'b@x.y'], from: '2026-10-30', to: '2026-10-31' })).content[0].text;
  expect(avail).toContain('a@x.y: busy\n  2026-10-30 10:00 - 11:30');
  expect(avail).toContain('b@x.y: free for the whole period');
  expect(avail).toContain('c@other.org: availability unknown (no calendar on this server)');
  const slots = (await tool(calendar, 'find-meeting-time').handler({ emails: ['a@x.y'], from: '2026-10-30', to: '2026-10-31' })).content[0].text;
  expect(slots).toContain('2026-10-30 12:00 - 13:00');
  expect(slots).toContain('Not checked (no calendar on this server): c@other.org');
});
