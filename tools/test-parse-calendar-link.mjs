import assert from 'node:assert';

// ---- function under test (keep identical to the copy in app.js) ----
function parseCalendarLink(input) {
  if (!input) return null;
  const s = String(input).trim();

  // 1) iCal URL: /calendar/ical/<calId>/public/basic.ics (calId is URL-encoded)
  const ical = s.match(/\/calendar\/ical\/([^/]+)\//);
  if (ical) { try { return decodeURIComponent(ical[1]); } catch { return ical[1]; } }

  // 2) cid= param (full URL or bare "cid=..."), base64 → calendar id
  const m = s.match(/[?&]cid=([^&\s]+)/);
  const cidToken = m ? m[1]
    : (/^[A-Za-z0-9\-_]+={0,2}$/.test(s) && !s.includes('@') && s.length >= 16 ? s : null);
  if (cidToken) {
    try {
      let b = decodeURIComponent(cidToken).replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const decoded = atob(b);
      if (decoded && /@/.test(decoded)) return decoded;
    } catch { /* fall through */ }
  }

  // 3) raw calendar id (email-like or *.calendar.google.com)
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s;

  return null;
}
// ---- end function under test ----

const cid = Buffer.from('family@group.calendar.google.com').toString('base64');
assert.strictEqual(
  parseCalendarLink(`https://calendar.google.com/calendar/u/0?cid=${cid}`),
  'family@group.calendar.google.com', 'full cid URL');
assert.strictEqual(
  parseCalendarLink(cid.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')),
  'family@group.calendar.google.com', 'url-safe, unpadded bare cid');
assert.strictEqual(
  parseCalendarLink('https://calendar.google.com/calendar/ical/ted%40gmail.com/public/basic.ics'),
  'ted@gmail.com', 'iCal URL');
assert.strictEqual(parseCalendarLink('ted@gmail.com'), 'ted@gmail.com', 'raw id');
assert.strictEqual(parseCalendarLink('not a link'), null, 'junk → null');
assert.strictEqual(parseCalendarLink(''), null, 'empty → null');
assert.strictEqual(parseCalendarLink('   '), null, 'whitespace → null');

console.log('all parseCalendarLink cases passed');
