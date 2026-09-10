import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped renderer with a tiny SVG / store boundary. No copied
// routing implementation, browser, account, or backend is needed.
const source = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  renderEdges(visibleIdsIn) {');
const end = source.indexOf('  renderNodes(visibleIdsIn) {', start);
assert.ok(start > 0 && end > start, 'Canvas renderer must be present');
const renderer = source.slice(start, end);
const heartStart = source.indexOf('function heartMarker(');
const heartEnd = source.indexOf('// The people the relationship spotlight', heartStart);
const heartSource = source.slice(heartStart, heartEnd);
const escapeSource = source.match(/^function escape\(s\).*$/m)[0];
const W = 200, H = 280;
const member = (id, x, y, options = {}) => ({ id, x, y, parentIds: [], siblingLinkIds: [], exSpouseIds: [], ...options });

function render(members, orientation = 'vertical', visible = members.map(m => m.id), nodeHeights = new Map()) {
  const edges = { style: {}, setAttribute(name, value) { this[name] = value; } };
  const scope = {
    NODE_W: W, NODE_H: H,
    Store: { state: { orientation }, membersList: () => members, byId: id => members.find(m => m.id === id) },
    computeVisibleIds: () => new Set(visible),
    unique: values => [...new Set(values)],
    familyKey: ids => ids.slice().sort().join('|'),
    yearsTogether: () => 20
  };
  vm.createContext(scope);
  const canvas = vm.runInContext(`${escapeSource}\n${heartSource}\n({ ${renderer} })`, scope);
  canvas.edges = edges;
  canvas._nodeHeights = nodeHeights;
  canvas.renderEdges(new Set(visible));
  const html = edges.innerHTML;
  assert.ok(!/NaN|Infinity|undefined/.test(html), 'SVG coordinates and attributes stay finite');
  const elements = [...html.matchAll(/<(path|circle)\s+([^>]+)>/g)].map(match => {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(attr => [attr[1], attr[2]]));
    return { tag: match[1], ...attrs };
  });
  const paths = elements.filter(el => el.tag === 'path' && el.class?.startsWith('edge '));
  return { html, edges, elements, paths, family: paths.filter(el => el.class === 'edge family') };
}
const points = path => [...path.d.matchAll(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
const bars = (result, vertical = true) => result.family.filter(p => {
  const [a, b] = points(p);
  return vertical ? a[1] === b[1] && a[0] !== b[0] : a[0] === b[0] && a[1] !== b[1];
});

const married = [
  member('a', 0, 0, { spouseId: 'b' }), member('b', 240, 0, { spouseId: 'a' }),
  member('c', 0, 392, { parentIds: ['a', 'b'] }), member('d', 240, 392, { parentIds: ['a', 'b'] })
];
const vertical = render(married);
assert.equal(bars(vertical).length, 1, 'married parents share one sibling bar');
assert.ok(points(bars(vertical)[0]).every(([, y]) => y > H && y < 392), 'couple sibling bar lies in the generation gap, below parent cards');
assert.ok(vertical.elements.some(el => el.class === 'family-junction'), 'real branch joins have visible junction dots');
const heart = vertical.html.match(/<g class="spouse-heart"[^>]*>[\s\S]*?<\/g>/)[0];
assert.match(heart, /<rect x="-15" y="-13.5"/, 'heart background uses local coordinates instead of being displaced across the tree');

const horizontal = render([
  member('a', 0, 0, { spouseId: 'b' }), member('b', 0, 320, { spouseId: 'a' }),
  member('c', 312, 0, { parentIds: ['a', 'b'] }), member('d', 312, 320, { parentIds: ['a', 'b'] })
], 'horizontal');
assert.equal(bars(horizontal, false).length, 1);
assert.ok(points(bars(horizontal, false)[0]).every(([x]) => x > W && x < 312), 'horizontal sibling bar lies between generation columns');

const tallerParents = render(married, 'vertical', undefined, new Map([['a', 326], ['b', 346], ['c', 350]]));
assert.ok(points(bars(tallerParents)[0]).every(([, y]) => y > 346 && y < 392), 'measured metadata height keeps sibling bars below the actual parent cards');
const tallerSolo = render([member('a', 0, 0), member('c', 240, 392, { parentIds: ['a'] })], 'vertical', undefined, new Map([['a', 332]]));
assert.equal(points(tallerSolo.family[0])[0][1], 332, 'solo descent starts at the measured bottom edge');
const tallerHorizontal = render([
  member('a', 0, 0, { spouseId: 'b' }), member('b', 0, 360, { spouseId: 'a' }),
  member('c', 312, 0, { parentIds: ['a', 'b'] })
], 'horizontal', undefined, new Map([['a', 314], ['b', 340], ['c', 330]]));
assert.ok(points(tallerHorizontal.paths.find(p => p.class === 'edge spouse')).some(([, y]) => y === 314), 'horizontal spouse link starts at the measured primary edge');
assert.ok(tallerHorizontal.family.some(p => points(p).at(-1)[0] === 312 && points(p).at(-1)[1] === 165), 'horizontal descent enters the measured child center');

const crossingFamilies = Array.from({ length: 7 }, (_, i) => [
  member(`p${i}`, i * 240, 0), member(`c${i}`, (6 - i) * 240, 392, { parentIds: [`p${i}`] })
]).flat();
// Give the middle branch a small span as well, so every branch has a bar.
crossingFamilies.find(m => m.id === 'c3').x += 20;
const crossing = render(crossingFamilies);
const laneDepths = bars(crossing).map(p => points(p)[0][1]);
assert.equal(new Set(laneDepths).size, 7, 'seven overlapping families receive seven distinct lanes instead of wrapping at three');
assert.ok(laneDepths.every(y => y > H && y < 392), 'all routing lanes remain within the generation gap');
const measuredCrossing = render(crossingFamilies, 'vertical', undefined, new Map([314, 312, 320, 316, 318, 314, 322].map((height, i) => [`p${i}`, height])));
const measuredLanes = bars(measuredCrossing).map(p => points(p)[0][1]);
assert.equal(new Set(measuredLanes).size, 7, 'unequal measured parent heights still allocate distinct lanes within one generation');
assert.ok(measuredLanes.every(y => y > 322 && y < 392), 'all lanes clear the tallest measured parent in their generation');
for (const edge of crossing.family) {
  assert.ok(crossing.elements.some(el => el.class === 'edge-halo' && el.d === edge.d && el['data-m'] === edge['data-m']), 'each branch segment has a matching spotlight-aware crossing halo');
}
const filtered = render(crossingFamilies, 'vertical', ['p5', 'c5']);
const fullColor = crossing.family.find(p => p['data-m'] === 'p5 c5').style;
assert.equal(filtered.family[0].style, fullColor, 'filtering other families does not change branch color');
assert.ok(filtered.paths.every(p => p['data-m'].split(' ').every(id => ['p5', 'c5'].includes(id))), 'hidden people do not leave behind connectors');

const coparents = render([
  member('a', 0, 0), member('b', 240, 0), member('c', 120, 392, { parentIds: ['a', 'b'] })
]);
const entries = coparents.family.map(points).filter(([, end]) => end[1] === 392);
assert.equal(entries.length, 2, 'unmarried parents retain individual descent branches');
assert.notEqual(entries[0][1][0], entries[1][1][0], 'co-parent descent lines have distinct card entry ports');
assert.equal(coparents.paths.filter(p => p.class.includes('spouse')).length, 0, 'co-parenthood alone does not create a spouse relationship');

const formerPartners = [member('a', 0, 0, { exSpouseIds: ['c'] }), member('b', 240, 0), member('c', 480, 0, { exSpouseIds: ['a'] })];
const former = render(formerPartners);
const ex = former.paths.filter(p => p.class === 'edge spouse ex');
assert.equal(ex.length, 1, 'symmetric former-partner links render once');
assert.ok(points(ex[0]).some(([, y]) => y < 0), 'distant former partners route above the intervening card');
for (const [a, b] of points(ex[0]).slice(1).map((b, i) => [points(ex[0])[i], b])) {
  if (a[1] === b[1]) assert.ok(a[1] <= 0 || a[1] >= H, 'horizontal ex-partner segment does not cut through the middle card');
  if (a[0] === b[0]) assert.ok(a[0] <= 240 || a[0] >= 440, 'vertical ex-partner segment avoids the middle card');
}

const displaced = render([
  member('a', 0, 0, { spouseId: 'c' }), member('b', 240, 0), member('c', 480, 100, { spouseId: 'a' }),
  member('d', 240, 492, { parentIds: ['a', 'c'] })
]);
assert.ok(points(displaced.paths.find(p => p.class === 'edge spouse')).some(([, y]) => y > 380), 'manually displaced partners use a shared lane below both cards');
assert.ok(bars(displaced).every(p => points(p)[0][1] > 400), 'descendant trunk joins the routed spouse anchor without doubling back');

const siblings = render([member('a', 0, 0, { siblingLinkIds: ['b'] }), member('b', 240, 0, { siblingLinkIds: ['a'] })]);
assert.ok(siblings.paths.some(p => p.class === 'edge sibling'), 'parentless explicit siblings retain a dashed relationship bracket');
assert.equal(render([]).html, '', 'an empty tree clears stale edges');
console.log('Tree connector geometry: all regression cases passed.');
