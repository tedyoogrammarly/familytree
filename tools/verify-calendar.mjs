// Playwright harness for the Shared Calendar feature. Run: node tools/verify-calendar.mjs
import { chromium } from 'playwright';

const fails = [];
function check(cond, msg) { if (!cond) fails.push(msg); }

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errs.push('console: ' + m.text()); });
await p.goto('http://localhost:3000', { waitUntil: 'networkidle' });

// Force an admin session with no Supabase, then open the Calendar.
await p.evaluate(() => {
  const login = document.getElementById('login-view');
  const app = document.getElementById('app-view');
  if (login) login.hidden = true;
  if (app) app.hidden = false;
  Auth.current = 'admin-bootstrap';
  document.body.classList.add('is-admin');
});

const state = await p.evaluate(() => ({
  view: Store.state.calendarView,
  filters: Store.state.calendarFilters,
  allEventsHaveCategory: (Store.state.events || []).every(e => typeof e.category === 'string'),
}));
console.log('TASK1', JSON.stringify(state));
check(state.view === 'week', 'calendarView should default to week');
check(state.filters && state.filters.work === true && state.filters.personal === true && state.filters.family === true, 'filters default all true');
check(state.allEventsHaveCategory, 'every event has a category');

const norm = await p.evaluate(() => {
  // Offset-less local ISO strings: new Date() parses these as local time in
  // every host timezone, so getHours()/getMinutes() are deterministic (no -07:00).
  const timed = GoogleCalendar.normalizeEvent(
    { id: 'x1', summary: 'Standup', htmlLink: 'h',
      start: { dateTime: '2026-07-07T09:30:00' }, end: { dateTime: '2026-07-07T10:00:00' } },
    { id: 'c1', summary: 'Work', backgroundColor: '#123', category: 'work' });
  const allDay = GoogleCalendar.normalizeEvent(
    { id: 'x2', summary: 'Holiday', start: { date: '2026-07-04' }, end: { date: '2026-07-05' } },
    { id: 'c2', summary: 'Personal', backgroundColor: '#456', category: 'personal' });
  return { timed, allDay };
});
console.log('TASK2', JSON.stringify(norm));
check(norm.timed.startTime === '09:30' && norm.timed.endTime === '10:00', 'timed event keeps HH:MM');
check(norm.timed.allDay === false && norm.timed.category === 'work', 'timed flags');
check(norm.timed.color === '#123', 'color reads backgroundColor');
check(norm.allDay.allDay === true && norm.allDay.startTime === null && norm.allDay.category === 'personal', 'all-day flags');

const cat = await p.evaluate(() => {
  Store.state.googleCalendar = { clientId: 'x', accessToken: '', tokenExpiresAt: 0, userEmail: '',
    calendars: [{ id: 'c1', summary: 'Work', color: '#123', enabled: true }], lastSync: 0, showEvents: true };
  GoogleCalendar.setCalendarCategory('c1', 'work');
  return GoogleCalendar.config().calendars[0].category;
});
console.log('TASK3', cat);
check(cat === 'work', 'category persists on calendar');

// Screenshot the connect-modal category dropdowns on a seeded, configured googleCalendar.
await p.evaluate(() => {
  Store.state.googleCalendar = {
    clientId: 'x', accessToken: 'tok', tokenExpiresAt: Date.now() + 3600000, userEmail: 'ted@example.com',
    calendars: [
      { id: 'c1', summary: 'Work Calendar', backgroundColor: '#4285f4', enabled: true, category: 'work', primary: true },
      { id: 'c2', summary: 'Personal', backgroundColor: '#0f9d58', enabled: true, category: 'personal' },
      { id: 'c3', summary: 'Misc', backgroundColor: '#db4437', enabled: false, category: 'other' },
    ],
    lastSync: Date.now(), showEvents: true,
  };
  CalendarView.openGoogleModal();
});
await p.waitForTimeout(300);
const gcalCatCount = await p.evaluate(() => document.querySelectorAll('[data-gcal-cat]').length);
check(gcalCatCount === 3, 'modal renders one category select per calendar');
await p.screenshot({ path: 'temporary screenshots/cal-gcal-modal.png' });

console.log(errs.length ? ('ERRORS:\n' + errs.join('\n')) : 'no console/page errors');
await b.close();

if (fails.length) { console.error('CHECK FAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
else console.log('ALL CHECKS PASSED');
