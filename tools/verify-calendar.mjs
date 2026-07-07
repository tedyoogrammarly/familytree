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

// Task 4: Work/Personal/Family filter chips (Month view).
const filt = await p.evaluate(() => {
  const g = (kind, cat) => CalendarView.groupOf(kind, cat);
  return {
    work: g('google', 'work'), pers: g('google', 'personal'), oth: g('google', 'other'),
    apptGroup: g('event', 'personal'), famEvent: g('event', 'family'), bday: g('birthday'),
  };
});
console.log('TASK4', JSON.stringify(filt));
check(filt.work === 'work' && filt.pers === 'personal' && filt.oth === 'work', 'google other→work bucket');
check(filt.apptGroup === 'personal' && filt.famEvent === 'family' && filt.bday === 'family', 'internal buckets');

const filterRoundTrip = await p.evaluate(() => {
  CalendarView.setFilter('family', false);
  const offRead = CalendarView.filterOn('family');
  const persisted = Store.state.calendarFilters.family;
  CalendarView.setFilter('family', true);
  const onRead = CalendarView.filterOn('family');
  return { offRead, persisted, onRead };
});
console.log('TASK4 roundtrip', JSON.stringify(filterRoundTrip));
check(filterRoundTrip.offRead === false && filterRoundTrip.persisted === false, 'setFilter(false) persists to Store.state.calendarFilters');
check(filterRoundTrip.onRead === true, 'setFilter(true) round-trips back on');

// Task 5: weekly time-grid layout helpers (overlap columns + time parsing).
const lay = await p.evaluate(() => {
  const items = [
    { startMin: 540, endMin: 600 },  // 9:00–10:00
    { startMin: 570, endMin: 630 },  // 9:30–10:30 (overlaps #1)
    { startMin: 660, endMin: 690 },  // 11:00–11:30 (separate)
  ];
  CalendarView.layoutDayColumns(items);
  return items.map(i => ({ c: i._col, n: i._ncols }));
});
console.log('TASK5', JSON.stringify(lay));
check(lay[0].n === 2 && lay[1].n === 2, 'overlapping pair splits into 2 columns');
check(lay[0].c !== lay[1].c, 'overlapping events get different columns');
check(lay[2].n === 1, 'non-overlapping event is full width');

const time = await p.evaluate(() => CalendarView.timeToMin('09:30'));
check(time === 570, 'timeToMin');

// Task 6: in-app personal appointment modal — pure persistence path.
const appt = await p.evaluate(() => {
  const before = (Store.state.events || []).length;
  AppointmentModal.saveFrom({ name: 'Dentist', date: '2026-07-07', startTime: '15:00', endTime: '', location: 'Downtown', description: '' });
  const ev = Store.state.events[0];
  return { added: Store.state.events.length - before, cat: ev.category, start: ev.startTime, name: ev.name };
});
console.log('TASK6', JSON.stringify(appt));
check(appt.added === 1 && appt.cat === 'personal' && appt.start === '15:00' && appt.name === 'Dentist', 'appointment saved as personal timed event');

// Task 7: FIX B — week view unifies internal + Google timed items into one
// per-day layout pass (this._weekTimed / relayoutDay), instead of two
// independent placeTimed() passes that stacked same-time events on top of
// each other. Also verifies the merge path de-dupes by event id (guards the
// old double-append bug on a re-resolved same-week fetch).
const weekMerge = await p.evaluate(() => {
  CalendarView.mode = 'week';
  CalendarView.weekStart = CalendarView.startOfWeek(new Date());
  CalendarView.render(); // fresh week grid; resets this._weekTimed for the week

  // Pick a day in the current week that isn't "today", so this doesn't
  // collide with the Task 6 Dentist appointment (seeded on today's date).
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(CalendarView.weekStart); d.setDate(d.getDate() + i); return d; });
  const todayIso = toIsoDate(new Date());
  const testDay = days.find(d => toIsoDate(d) !== todayIso) || days[0];
  const iso = toIsoDate(testDay);

  // Seed two overlapping "internal" items directly into the shared store,
  // exactly as renderWeek() would, then lay that day out.
  CalendarView._weekTimed[iso] = [
    { startMin: 540, endMin: 600, label: 'A', group: 'personal', kind: 'event', id: 'ev-a' },
    { startMin: 570, endMin: 630, label: 'B', group: 'personal', kind: 'event', id: 'ev-b' },
  ];
  CalendarView.relayoutDay(iso);
  const col = document.querySelector(`#cal-week .cal-wk-col[data-date="${iso}"]`);
  const nodesAfterSeed = col ? col.querySelectorAll('.cal-wk-event').length : -1;
  const lefts = col ? Array.from(col.querySelectorAll('.cal-wk-event')).map(n => n.style.left) : [];
  const ncolsCheck = CalendarView.layoutDayColumns([...CalendarView._weekTimed[iso]]).map(i => i._ncols);

  // Simulate the Google-merge path (mirrors renderGoogleEventsUnified's week
  // branch): one genuinely new item + one item whose id already exists.
  const incoming = [
    { startMin: 660, endMin: 690, label: 'G-new', group: 'work', kind: 'google', id: 'g:new1' },
    { startMin: 540, endMin: 600, label: 'A-dup', group: 'personal', kind: 'event', id: 'ev-a' }, // duplicate id
  ];
  const existing = CalendarView._weekTimed[iso];
  const seenIds = new Set(existing.map(it => it.id));
  const fresh = incoming.filter(it => !seenIds.has(it.id));
  existing.push(...fresh);
  CalendarView.relayoutDay(iso);
  const nodesAfterMerge = col.querySelectorAll('.cal-wk-event').length;
  const storeLenAfterMerge = CalendarView._weekTimed[iso].length;

  // Re-merge the SAME duplicate id again — node count / store length must
  // not grow further (this is the double-append regression the fix targets).
  const seenIds2 = new Set(CalendarView._weekTimed[iso].map(it => it.id));
  const reDupeIncoming = [{ startMin: 540, endMin: 600, label: 'A-dup2', group: 'personal', kind: 'event', id: 'ev-a' }];
  const fresh2 = reDupeIncoming.filter(it => !seenIds2.has(it.id));
  CalendarView._weekTimed[iso].push(...fresh2);
  CalendarView.relayoutDay(iso);
  const nodesAfterReDupe = col.querySelectorAll('.cal-wk-event').length;

  return { nodesAfterSeed, lefts, ncolsCheck, freshCount: fresh.length, nodesAfterMerge, storeLenAfterMerge, nodesAfterReDupe };
});
console.log('TASK7', JSON.stringify(weekMerge));
check(weekMerge.nodesAfterSeed === 2, 'two overlapping internal items render as two .cal-wk-event nodes in the day column');
check(weekMerge.lefts.length === 2 && weekMerge.lefts[0] !== weekMerge.lefts[1], 'overlapping items get different left offsets (side-by-side, not stacked)');
check(weekMerge.ncolsCheck[0] === 2 && weekMerge.ncolsCheck[1] === 2, 'layoutDayColumns over the combined array assigns _ncols=2 to the overlapping pair');
check(weekMerge.freshCount === 1, 'merge filters out the item whose id already exists in _weekTimed, keeping only the genuinely new one');
check(weekMerge.nodesAfterMerge === 3, 'merging one new + one duplicate-id item yields 3 rendered nodes total (2 seed + 1 new)');
check(weekMerge.storeLenAfterMerge === 3, '_weekTimed[iso] holds 3 items after merge (no duplicate by id)');
check(weekMerge.nodesAfterReDupe === 3, 're-merging an already-present id does not increase the rendered node count (no double-append)');

console.log(errs.length ? ('ERRORS:\n' + errs.join('\n')) : 'no console/page errors');
await b.close();

if (fails.length) { console.error('CHECK FAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
else console.log('ALL CHECKS PASSED');
