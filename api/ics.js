// Serverless proxy for public Google Calendar .ics feeds.
//
// Why this exists: Google's calendar.google.com/calendar/ical/<id>/public/basic.ics
// endpoint returns the feed with NO CORS headers, so a browser fetch() from our
// origin is blocked by the same-origin policy (curl works, the browser doesn't).
// This function fetches the feed server-side (no CORS enforcement there) and
// re-serves it from our own origin with Access-Control-Allow-Origin, so the
// keyless client-side ICS path in app.js can read it. (v4.82)
//
// Usage: GET /api/ics?src=<calendarId>
//   e.g. /api/ics?src=ted.yoo%40grammarly.com
//
// Security: this is a narrow proxy, not an open one. `src` must look like a
// Google calendar id (an email address or a *.calendar.google.com id). We build
// the upstream URL ourselves from that id and only ever hit Google's ical host,
// so it can't be pointed at arbitrary URLs.

// A Google calendar id is either an email address (personal calendar) or a
// generated address ending in calendar.google.com (holiday/group calendars,
// e.g. en.usa#holiday@group.v.calendar.google.com — note the '#'). We reject
// anything containing URL-structural characters (slash, ?, whitespace, scheme
// colon) so this can never be pointed at an arbitrary URL.
const NO_URL_CHARS = /^[^\s/?]+$/;
const IS_GOOGLE_ID = (id) =>
  NO_URL_CHARS.test(id) &&
  !id.includes('://') &&
  id.includes('@') &&
  (/@[^@\s]+\.[^@\s]+$/.test(id));  // has a domain after the '@'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const src = (req.query && req.query.src) || '';
  const id = Array.isArray(src) ? src[0] : String(src || '');
  if (!id || !IS_GOOGLE_ID(id)) {
    res.status(400).json({ error: 'bad_src' });
    return;
  }

  const upstream = `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      headers: { 'User-Agent': 'FamilyArchive-CalendarProxy/1.0' },
    });
  } catch {
    res.status(502).json({ error: 'fetch_failed' });
    return;
  }

  if (!upstreamRes.ok) {
    // 404 from Google usually means the calendar isn't public.
    res.status(upstreamRes.status === 404 ? 404 : 502)
       .json({ error: upstreamRes.status === 404 ? 'not_public' : 'upstream_error', status: upstreamRes.status });
    return;
  }

  const text = await upstreamRes.text();
  // Cache at the edge for 10 min (feeds change slowly); allow stale while revalidating.
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
  res.status(200).send(text);
}
