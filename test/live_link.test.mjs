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
  const requests = [], elements = new Map();
  const map = { setView() { return this; }, removeLayer() {} };
  const layer = { addTo() { return this; }, setLatLng() {} };
  const context = vm.createContext({
    location: new URL('https://adlmar87.github.io/skybuddy-live-viewer/' + suffix),
    URLSearchParams, atob, btoa, encodeURIComponent, console,
    setInterval() {},
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', style: {} });
      return elements.get(id);
    } },
    L: { map: () => map, tileLayer: () => layer, marker: () => layer, polyline: () => layer },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => data }; },
  });
  vm.runInContext(script, context);
  await tick();
  return { requests, elements };
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
  assert.equal(elements.get('status').textContent, 'Aktuell kein freigegebener Flug.');
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
