import test from 'node:test';
import assert from 'node:assert/strict';

const { __test: calendar } = await import('../public/pages/calendar.js');

test('the default local calendar displays its saved name', () => {
  assert.equal(
    calendar.localCalendarDisplayName({ id: 1, name: 'Yuvomi', is_default: true }),
    'Yuvomi',
  );
});

test('renamed and additional calendars display their saved names', () => {
  assert.equal(
    calendar.localCalendarDisplayName({ id: 1, name: 'Renamed default', is_default: true }),
    'Renamed default',
  );
  assert.equal(
    calendar.localCalendarDisplayName({ id: 2, name: 'Work', is_default: false }),
    'Work',
  );
  assert.equal(
    calendar.localCalendarDisplayName({ id: 2, name: 'Yuvomi', is_default: false }),
    'Yuvomi',
  );
});
