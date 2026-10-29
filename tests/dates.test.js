const d = require('../src/dates');

const MSK = 180; // +03:00

test('parseOffset understands the usual spellings', () => {
  expect(d.parseOffset('+03:00')).toBe(180);
  expect(d.parseOffset('+0300')).toBe(180);
  expect(d.parseOffset('-5')).toBe(-300);
  expect(d.parseOffset('05:30')).toBe(330);
  expect(() => d.parseOffset('Moscow')).toThrow(/Invalid time zone/);
});

test('formatOffset and offsetOfKerioDate', () => {
  expect(d.formatOffset(180)).toBe('+0300');
  expect(d.formatOffset(-330)).toBe('-0530');
  expect(d.offsetOfKerioDate('20261030T150000+0300')).toBe(180);
  expect(d.offsetOfKerioDate('20261031')).toBeNull();
});

describe('parseInput', () => {
  test('a bare date is local midnight', () => {
    expect(d.parseInput('2026-10-30', MSK).toISOString()).toBe('2026-10-29T21:00:00.000Z');
  });
  test('a local date-time is read in the mailbox zone', () => {
    expect(d.parseInput('2026-10-30T15:00', MSK).toISOString()).toBe('2026-10-30T12:00:00.000Z');
    expect(d.parseInput('2026-10-30 15:00', MSK).toISOString()).toBe('2026-10-30T12:00:00.000Z');
  });
  test('an explicit offset or Z is kept', () => {
    expect(d.parseInput('2026-10-30T15:00+05:00', MSK).toISOString()).toBe('2026-10-30T10:00:00.000Z');
    expect(d.parseInput('2026-10-30T15:00:00Z', MSK).toISOString()).toBe('2026-10-30T15:00:00.000Z');
  });
  test('garbage is rejected with a helpful message', () => {
    expect(() => d.parseInput('tomorrow', MSK)).toThrow(/Cannot understand the date/);
  });
});

test('toKerio sends the owner local time', () => {
  expect(d.toKerio(new Date('2026-10-30T12:00:00Z'), MSK)).toBe('20261030T150000+0300');
  expect(d.toKerio(new Date('2026-10-30T22:30:00Z'), MSK)).toBe('20261031T013000+0300');
});

test('fromKerio reads both forms', () => {
  expect(d.fromKerio('20261030T150000+0300').date.toISOString()).toBe('2026-10-30T12:00:00.000Z');
  const allDay = d.fromKerio('20261031', MSK);
  expect(allDay.allDay).toBe(true);
  expect(allDay.date.toISOString()).toBe('2026-10-30T21:00:00.000Z');
  expect(() => d.fromKerio('nonsense')).toThrow(/Unexpected date/);
});

test('formatLocal, weekday and start of day follow the owner zone', () => {
  const t = new Date('2026-10-30T22:30:00Z'); // 01:30 on Saturday 31 Oct in Moscow
  expect(d.formatLocal(t, MSK)).toBe('2026-10-31 01:30');
  expect(d.formatLocal(t, MSK, { dateOnly: true })).toBe('2026-10-31');
  expect(d.weekdayLocal(t, MSK)).toBe(6);
  expect(d.startOfDayLocal(t, MSK).toISOString()).toBe('2026-10-30T21:00:00.000Z');
});
