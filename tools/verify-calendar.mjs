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

console.log(errs.length ? ('ERRORS:\n' + errs.join('\n')) : 'no console/page errors');
await b.close();

if (fails.length) { console.error('CHECK FAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
else console.log('ALL CHECKS PASSED');
