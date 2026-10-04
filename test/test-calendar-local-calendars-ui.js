import test from 'node:test';
import assert from 'node:assert/strict';

const { __test: calendar } = await import('../public/pages/calendar.js');

test('the default local calendar has a translated display name while named calendars keep theirs', () => {
  assert.equal(
    calendar.localCalendarDisplayName({ id: 1, name: 'Renamed default', is_default: true }),
    'calendar.defaultLocalCalendar',
  );
  assert.equal(
    calendar.localCalendarDisplayName({ id: 2, name: 'Work', is_default: false }),
    'Work',
  );
});
