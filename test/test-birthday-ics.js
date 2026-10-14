import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { spawn } from 'node:child_process';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'birthday-feed-test';
const { get } = await import('../server/db.js');
const feed = await import('../server/services/birthday-ics.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const db = get();
const ids = ['first', 'second'].map(name => Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')").run(name, name).lastInsertRowid));
let actor = ids[0];
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor; req.authRole = 'member'; req.session = { userId: actor, role: 'member' };
  next();
});
app.use('/birthdays', birthdaysRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); db.close(); });
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('birthday-only ICS includes reminder-free birthdays, all-day recurrence and stable UIDs without other events or birth years', async () => {
  const created = await call('POST', '/birthdays', { name: 'Ada, Test', birth_date: '1984-12-31', reminder_offset: '' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.calendar_event_id, null);
  await call('POST', '/birthdays', { name: 'Leap birthday', birth_date: '2000-02-29', reminder_offset: '' });
  db.prepare("INSERT INTO calendar_events (title,start_datetime,created_by) VALUES ('Not a birthday','2035-01-01',?)").run(actor);
  const ics = feed.buildBirthdayFeed(db, new Date('2035-01-01T00:00:00Z'));
  assert.match(ics, /Ada\\, Test/);
  assert.match(ics, /DTSTART;VALUE=DATE:20001231\r\nDTEND;VALUE=DATE:20010101/);
  assert.match(ics, /DTSTART;VALUE=DATE:20000229/);
  assert.match(ics, /RRULE:FREQ=YEARLY;INTERVAL=1/);
  assert.doesNotMatch(ics, /1984|Not a birthday|TZID|VALARM/);
  assert.match(ics, new RegExp(`UID:birthday-${created.body.data.id}@yuvomi`));
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  db.prepare('UPDATE birthdays SET name = ? WHERE id = ?').run('Renamed\r\nBEGIN:VEVENT', created.body.data.id);
  const renamed = feed.buildBirthdayFeed(db);
  assert.match(renamed, new RegExp(`UID:birthday-${created.body.data.id}@yuvomi`));
  assert.equal((renamed.match(/\r\nBEGIN:VEVENT\r\n/g) ?? []).length, 2, 'text cannot inject an event');
});

test('birthday feed links are independent per user, rotate and revoke without touching the calendar feed', async () => {
  assert.equal((await call('GET', '/birthdays/feed')).body.data, null);
  const enabled = await call('POST', '/birthdays/feed/regenerate');
  assert.equal(enabled.status, 200);
  assert.ok(enabled.body.data.url.endsWith(`/feed/birthdays/${enabled.body.data.token}.ics`));
  assert.equal(feed.findUserIdByFeedToken(db, enabled.body.data.token), actor);
  db.prepare("UPDATE users SET calendar_feed_token = 'calendar-token' WHERE id = ?").run(actor);
  actor = ids[1];
  assert.equal((await call('GET', '/birthdays/feed')).body.data, null);
  const other = await call('POST', '/birthdays/feed/regenerate');
  assert.notEqual(other.body.data.token, enabled.body.data.token);
  actor = ids[0];
  const rotated = await call('POST', '/birthdays/feed/regenerate');
  assert.equal(feed.findUserIdByFeedToken(db, enabled.body.data.token), null);
  assert.equal(feed.findUserIdByFeedToken(db, rotated.body.data.token), actor);
  await call('DELETE', '/birthdays/feed');
  assert.equal(feed.findUserIdByFeedToken(db, rotated.body.data.token), null);
  assert.equal(feed.findUserIdByFeedToken(db, other.body.data.token), ids[1]);
  assert.equal(db.prepare('SELECT calendar_feed_token FROM users WHERE id = ?').get(actor).calendar_feed_token, 'calendar-token');
});

test('production birthday ICS route accepts only its own token and ends access when revoked', { timeout: 20000 }, async () => {
  const script = `
    const { server } = await import('./server/index.js');
    const { get } = await import('./server/db.js');
    const feed = await import('./server/services/birthday-ics.js');
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const db = get();
    const id = Number(db.prepare("INSERT INTO users (username,display_name,password_hash,role) VALUES ('feed','Feed','x','member')").run().lastInsertRowid);
    db.prepare("INSERT INTO birthdays (name,birth_date,created_by,reminder_offset) VALUES ('HTTP birthday','1990-05-12',?,'')").run(id);
    db.prepare("UPDATE users SET calendar_feed_token = 'different-calendar-token' WHERE id = ?").run(id);
    const token = feed.regenerateFeedToken(db,id);
    process.on('message', () => { feed.clearFeedToken(db,id); process.send({ revoked: true }); });
    process.send({ port: server.address().port, token });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DB_PATH: ':memory:', DB_ENCRYPTION_KEY: '', PORT: '0', BIND_ADDRESS: '127.0.0.1', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Birthday feed server startup: ' + errors)), 15000);
      child.once('message', data => { clearTimeout(timer); resolve(data); });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Feed server exited: ' + code + errors)); });
    });
    const url = `http://127.0.0.1:${ready.port}/feed/birthdays/${ready.token}.ics`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/calendar/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(await response.text(), /HTTP birthday/);
    assert.equal((await fetch(url.replace(ready.token, 'different-calendar-token'))).status, 404);
    const revoked = new Promise(resolve => child.once('message', resolve));
    child.send('revoke'); await revoked;
    assert.equal((await fetch(url)).status, 404);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
  }
});
