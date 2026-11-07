import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(process.env.LIVE_VIEWER_HTML ??
  new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).join('\n');
const sequence = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function openViewer(suffix, data = { status: 'unavailable' }) {
  const requests = [], elements = new Map(), lines = [];
  const map = { setView() { return this; }, removeLayer() {} };
  const layer = { addTo() { return this; }, setLatLng() {}, setOpacity() {}, bindTooltip() {} };
  const context = vm.createContext({
    location: new URL('https://adlmar87.github.io/skybuddy-live-viewer/' + suffix),
    URLSearchParams, atob, btoa, encodeURIComponent, console,
    setInterval() {}, setTimeout: (fn,ms) => { const timer=setTimeout(fn,ms); timer.unref(); return timer; }, clearTimeout, AbortController,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', style: {}, dataset: {} });
      return elements.get(id);
    } },
    L: { map: () => map, tileLayer: () => layer, marker: () => layer, polyline: (coords) => { lines.push(coords); return layer; } },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => data }; },
  });
  vm.runInContext(script, context);
  await tick();
  return { requests, elements, context, lines };
}

test('compact links preserve the exact 256-bit key sent to the existing API', async () => {
  for (const bytes of [sequence, Buffer.alloc(32), Buffer.alloc(32, 255)]) {
    const { requests } = await openViewer('#' + bytes.toString('base64url'));
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).searchParams.get('token'), bytes.toString('hex'));
    assert.equal(requests[0].options.cache, 'no-store');
    assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  }
});

test('previously shared token-query links remain supported', async () => {
  const token = sequence.toString('hex');
  const { requests } = await openViewer('?token=' + token);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.get('token'), token);
});

test('missing malformed truncated and noncanonical keys make no API request', async () => {
  const compact = sequence.toString('base64url');
  for (const suffix of ['', '#abc', '#' + compact.slice(1), '#' + compact + 'A',
    '#' + compact.slice(0, -1) + '9', '#' + '!'.repeat(43), '?token=invalid']) {
    const { requests, elements } = await openViewer(suffix);
    assert.equal(requests.length, 0, suffix);
    assert.equal(elements.get('status').textContent, 'Ungültiger Tracking-Link.');
  }
});

test('legacy query cannot be silently replaced by a different fragment key', async () => {
  const legacy = Buffer.alloc(32, 255).toString('hex');
  const suffix = '#' + sequence.toString('base64url');
  const valid = await openViewer('?token=' + legacy + suffix);
  assert.equal(new URL(valid.requests[0].url).searchParams.get('token'), legacy);
  const invalid = await openViewer('?token=invalid' + suffix);
  assert.equal(invalid.requests.length, 0);
});

test('an unavailable flight still clears values and shows no released flight', async () => {
  const { elements } = await openViewer('#' + sequence.toString('base64url'));
  assert.equal(elements.get('status').textContent, 'Live-Link derzeit nicht freigegeben');
  assert.equal(elements.get('alt').textContent, '—');
  assert.equal(elements.get('speed').textContent, '—');
});

test('compact link still renders active flight measurements', async () => {
  const { elements } = await openViewer('#' + sequence.toString('base64url'), {
    status: 'active', last_at: new Date().toISOString(), lat: 47.2, lon: 9.7,
    altitude: 1200, speed: 32, climb: 1.5, points: [],
  });
  assert.equal(elements.get('alt').textContent, '1200 m');
  assert.equal(elements.get('speed').textContent, '32 km/h');
  if (elements.has('climb')) assert.equal(elements.get('climb').textContent, '+1.5 m/s');
});


 test('age keeps advancing without a successful refresh and hides stale instruments', async () => {
  const {elements,context}=await openViewer('#'+sequence.toString('base64url'),{
    status:'active',last_at:new Date(Date.now()-20000).toISOString(),lat:47,lon:9,
    altitude:1200,speed:32,climb:2,points:[]});
  assert.match(elements.get('status').textContent,/Position aktuell/);
  vm.runInContext('snapshot.last_at=new Date(Date.now()-120000).toISOString();renderStatus()',context);
  assert.match(elements.get('position-age').textContent,/2 Min/);
  assert.match(elements.get('status').textContent,/Keine neue Position/);
  assert.equal(elements.get('speed').textContent,'—');
  vm.runInContext('networkFailed=true;renderStatus()',context);
  assert.match(elements.get('status').textContent,/Live-Anzeige unterbrochen/);
  assert.match(elements.get('position-age').textContent,/2 Min/);
 });
 test('missing and invalid timestamps never claim live',async()=>{
  for(const time of [null,'invalid',new Date(Date.now()+120000).toISOString()]){
   const {elements}=await openViewer('#'+sequence.toString('base64url'),{
    status:'active',last_at:time,lat:47,lon:9,altitude:1200,points:[]});
   assert.doesNotMatch(elements.get('status').textContent,/Position aktuell/);
   assert.equal(elements.get('alt').textContent,'—');
  }
 });
 test('ending sharing clears old measurements and age',async()=>{
  const {elements,context}=await openViewer('#'+sequence.toString('base64url'),{
   status:'active',last_at:new Date().toISOString(),lat:47,lon:9,altitude:1200,points:[]});
  vm.runInContext("snapshot={status:'inactive'};reset();renderStatus()",context);
  assert.equal(elements.get('alt').textContent,'—');
  assert.equal(elements.get('position-age').textContent,'');
  assert.equal(elements.get('status').textContent,'Aktuell kein freigegebener Flug.');
 });

 test('route is chronological and does not bridge GPS gaps',async()=>{
  const start=Date.now()-120000;
  const p=(seconds,lat)=>({at:new Date(start+seconds*1000).toISOString(),lat,lon:9});
  const {lines}=await openViewer('#'+sequence.toString('base64url'),{
   status:'active',last_at:new Date().toISOString(),lat:47,lon:9,
   points:[p(100,47.3),p(10,47.1),p(90,47.2),p(0,47)]});
  assert.deepEqual(JSON.parse(JSON.stringify(lines[0])),[[[47,9],[47.1,9]],[[47.2,9],[47.3,9]]]);
 });
 test('overlapping refreshes do not start concurrent requests',async()=>{
  const {context}=await openViewer('#'+sequence.toString('base64url'));
  vm.runInContext("globalThis.calls=0;fetch=()=>{calls++;return new Promise(()=>{});};refresh();refresh()",context);
  assert.equal(vm.runInContext('calls',context),1);
 });
