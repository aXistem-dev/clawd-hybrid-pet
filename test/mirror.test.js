// Tests for n8n/clawd-mirror.js (the optional PNG mirror). Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const M = require('../n8n/clawd-mirror.js');
const E = require('../n8n/clawd-engine.js');

// Parse a PNG into chunks, checking the signature and every CRC. The CRC is recomputed with a
// separate implementation; reusing the module's own table would prove nothing.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
  return ~c >>> 0;
}
function parsePng(bytes) {
  const b = Buffer.from(bytes);
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 'PNG signature');
  const chunks = {};
  let off = 8;
  while (off < b.length) {
    const len = b.readUInt32BE(off), type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    assert.equal(b.readUInt32BE(off + 8 + len), crc32(b.subarray(off + 4, off + 8 + len)), `${type} CRC`);
    chunks[type] = data;
    off += 12 + len;
  }
  return chunks;
}
function decode(bytes) {
  const c = parsePng(bytes);
  const w = c.IHDR.readUInt32BE(0), h = c.IHDR.readUInt32BE(4);
  assert.deepEqual([c.IHDR[8], c.IHDR[9]], [8, 3], '8-bit palette');
  const raw = zlib.inflateSync(c.IDAT);
  assert.equal(raw.length, h * (w + 1));
  const pal = []; for (let i = 0; i < c.PLTE.length; i += 3) pal.push('#' + c.PLTE.subarray(i, i + 3).toString('hex').toUpperCase());
  return { w, h, at: (x, y) => { assert.equal(raw[y * (w + 1)], 0, 'filter byte'); return pal[raw[y * (w + 1) + 1 + x]]; } };
}
const led = (img, x, y) => img.at(x * 8 + 4, y * 8 + 4);   // centre of LED (x, y)

test('mirror: a valid 256x64 PNG with each LED in its drawn colour', () => {
  const img = decode(M.mirrorPng(M.mirrorFrame({ draw: [
    ['rectFill', 0, 0, 32, 8, '#000000'], ['pixel', 3, 2, '#FF0000'], ['line', 0, 7, 3, 7, '#1E4D1E'],
    ['pixels', '#00FF00', 10, 1, 11, 1], ['rect', 20, 0, 3, 3, '#0000FF']
  ] })));
  assert.equal(img.w, 256); assert.equal(img.h, 64);
  assert.equal(led(img, 3, 2), '#FF0000');
  assert.equal(led(img, 2, 7), '#1E4D1E');
  assert.equal(led(img, 11, 1), '#00FF00');
  assert.equal(led(img, 22, 2), '#0000FF');
  assert.equal(led(img, 21, 1), '#161616', 'inside an outline stays off');
  assert.equal(led(img, 0, 0), '#161616', 'black is an unlit LED');
  assert.equal(img.at(0, 0), '#050505', 'the gap between LEDs');
});

test('mirror: text uses the 3x5 font at AWTRIX spacing, and plain payload text works', () => {
  const fb = M.mirrorFrame({ draw: [['text', 11, 1, 'FEED', '#F0E6D8']] });
  const on = (x, y) => fb[y * 32 + x] !== null;
  assert.ok(on(11, 1) && on(13, 1) && !on(14, 1), 'E: 3 px wide, 1 px gap');
  assert.ok(on(15, 1), 'second letter starts 4 px later');
  const stats = M.mirrorFrame({ text: 'Clawd AGE 1d', textColor: '#F0E6D8' });
  assert.ok(stats.some((c) => c === '#F0E6D8'));
});

test('mirror: every frame the engine renders turns into a valid PNG', () => {
  const store = {};
  const cfg = { MIRROR: true };
  let t = Date.UTC(2026, 8, 27, 8, 0, 0);
  E.run({ event: 'tick' }, store, cfg, t);
  for (const extra of [{ st: 1, ev: 1 }, { st: 1, ev: 3, sl: 1 }, { st: 1, ev: 4, va: 0, ui: 1, mi: 2, dwell: t }, { st: 2 }, { st: 1, ev: 2, ui: 3, stat_open: t }]) {
    Object.assign(store.clawd, extra);
    t += 2000;
    const r = E.run({ event: 'tick' }, store, cfg, t);
    assert.ok(r.push && r.payload, 'on screen by default');
    const b64 = M.pngBase64(r.payload);
    decode(Buffer.from(b64, 'base64'));
  }
});

test('engine: mirror is opt-in and only set on pushed frames', () => {
  const t = Date.UTC(2026, 8, 27, 8, 0, 0);
  assert.equal(E.run({ event: 'tick' }, {}, {}, t).mirror, null, 'off by default');
  const on = E.run({ event: 'tick' }, {}, { MIRROR: true, MIRROR_TOPIC: 'home/clawd/png' }, t);
  assert.equal(on.push, true);
  assert.equal(on.mirror, 'home/clawd/png');
  assert.equal(E.run({ event: 'tick' }, {}, { MODE: 'view', MIRROR: true }, t).mirror, null, 'not in view mode');
});

test('view mirror: the clock\'s framebuffer becomes the same PNG', () => {
  const px = new Array(256).fill(0);
  px[2 * 32 + 3] = 0xFF0000; px[6 * 32 + 19] = 0x803020; px[7 * 32 + 31] = 0x0000FF;
  const img = decode(Buffer.from(M.screenPngBase64({ pixels: px }), 'base64'));
  assert.equal(img.w, 256); assert.equal(img.h, 64);
  assert.equal(led(img, 3, 2), '#FF0000');
  assert.equal(led(img, 19, 6), '#803020');
  assert.equal(led(img, 31, 7), '#0000FF', 'rows run left to right, top to bottom');
  assert.equal(led(img, 0, 0), '#161616', '0 is an unlit LED');
  // Same picture whether it comes from draw commands or the framebuffer.
  assert.deepEqual(M.screenFrame(px), M.mirrorFrame({ draw: [['pixel', 3, 2, '#FF0000'], ['pixel', 19, 6, '#803020'], ['pixel', 31, 7, '#0000FF']] }));
  for (const bad of [null, {}, { pixels: [1, 2] }, { pixels: new Array(256).fill('x') }, { pixels: new Array(256).fill(-1) }, { error: { message: 'timeout' } }]) {
    assert.equal(M.screenPngBase64(bad), null, JSON.stringify(bad).slice(0, 40));
  }
});

test('view mirror: reads the screen only on ticks while MIRROR is on and Clawd is shown', () => {
  const cfg = { MIRROR: true, AWTRIX_HOST: 'http://clock.local/', MQTT_PREFIX: 'awtrix' };
  const store = {};
  assert.equal(M.mirrorGate({ event: 'tick' }, store, cfg), null, 'unknown: not shown');
  assert.equal(M.mirrorGate({ event: 'active', app: 'clawd', prefix: 'awtrix' }, store, cfg), null, 'an app change never reads');
  assert.equal(store.mirrorFg, true);
  assert.deepEqual(M.mirrorGate({ event: 'tick' }, store, cfg), { url: 'http://clock.local/api/v1/display/screen', topic: 'clawd/screen' });
  M.mirrorGate({ event: 'active', app: 'clawd', prefix: 'otherclock' }, store, cfg);
  assert.equal(store.mirrorFg, true, 'another clock\'s app changes are ignored');
  M.mirrorGate({ event: 'active', app: 'weather', prefix: 'awtrix' }, store, cfg);
  assert.equal(M.mirrorGate({ event: 'tick' }, store, cfg), null, 'Clawd left the screen');
  // Off by default, and a tick writes nothing to the static data.
  const s2 = { mirrorFg: true };
  assert.equal(M.mirrorConfig({}).MIRROR, false);
  assert.equal(M.mirrorGate({ event: 'tick' }, s2, {}), null);
  const watched = new Proxy({ mirrorFg: true }, { set() { throw new Error('tick wrote static data'); } });
  assert.ok(M.mirrorGate({ event: 'tick' }, watched, cfg));
  const same = new Proxy({ mirrorFg: true }, { set() { throw new Error('unchanged app wrote static data'); } });
  M.mirrorGate({ event: 'active', app: 'clawd', prefix: 'awtrix' }, same, cfg);
});

test('engine, view mode: MIRROR_SOURCE "render" draws the frame in n8n, on change and at least every MIRROR_EVERY_SEC', () => {
  const t = Date.UTC(2026, 8, 27, 8, 0, 0);
  const cfg = { MODE: 'view', MIRROR: true, MIRROR_SOURCE: 'render', MIRROR_EVERY_SEC: 30 };
  assert.equal(E.run({ event: 'tick' }, {}, { MODE: 'view', MIRROR: true }, t).mirror, null, '"clock" (the default) leaves it to the mirror workflow');
  assert.equal(E.run({ event: 'tick' }, {}, Object.assign({}, cfg, { MIRROR: false }), t).mirror, null, 'MIRROR off: nothing');
  const store = {};
  const first = E.runN8n({ event: 'tick' }, store, cfg, t);
  assert.equal(first.mirror, 'clawd/screen');
  assert.equal(first.push, false, 'nothing is pushed to a clock');
  const img = decode(Buffer.from(M.pngBase64(first.payload), 'base64'));
  assert.equal(img.w, 256);
  // Unchanged pet: quiet until MIRROR_EVERY_SEC has passed, then again.
  assert.equal(E.runN8n({ event: 'tick' }, store, cfg, t + 15000).mirror, null);
  assert.equal(E.runN8n({ event: 'tick' }, store, cfg, t + 31000).mirror, 'clawd/screen');
  // An action shows at once.
  assert.equal(E.runN8n({ event: 'cmd', payload: 'feed', topic: 'clawd/ha' }, store, cfg, t + 33000).mirror, 'clawd/screen');
  // Range: at least 10 s.
  assert.equal(E.makeConfig({ MIRROR_EVERY_SEC: 2 }).MIRROR_EVERY_SEC, 10);
  assert.ok(E.makeConfig({ MIRROR_SOURCE: 'tv' }).warnings.includes('MIRROR_SOURCE'));
});

test('engine, view mode: CLOCK false never calls the clock', () => {
  const t = Date.UTC(2026, 8, 27, 8, 0, 0);
  const on = E.run({ event: 'cmd', payload: 'feed', topic: 'clawd/ha' }, {}, { MODE: 'view' }, t);
  assert.equal(on.switchTo, true, 'with a clock, Home Assistant brings Clawd on screen');
  const off = E.run({ event: 'cmd', payload: 'feed', topic: 'clawd/ha' }, {}, { MODE: 'view', CLOCK: false, NOTIFY: true }, t);
  assert.equal(off.switchTo, false);
  assert.equal(off.notify, null);
  assert.ok(off.publish, 'the state line still goes out');
  assert.equal(JSON.parse(off.config.message).CLOCK, false, 'and the settings say so');
});

test('view mirror: stands down while the view workflow draws the frame itself', () => {
  const cfg = { MIRROR: true, AWTRIX_HOST: 'clock.local', MQTT_PREFIX: 'awtrix' };
  const store = { mirrorFg: true };
  assert.ok(M.mirrorGate({ event: 'tick' }, store, cfg), 'reads the clock by default');
  M.mirrorGate({ event: 'config', mirror: true, source: 'render' }, store, cfg);
  assert.equal(M.mirrorGate({ event: 'tick' }, store, cfg), null);
  M.mirrorGate({ event: 'config', mirror: true, source: 'clock' }, store, cfg);
  assert.ok(M.mirrorGate({ event: 'tick' }, store, cfg));
  M.mirrorGate({ event: 'config', mirror: true }, store, cfg);
  assert.ok(M.mirrorGate({ event: 'tick' }, store, cfg), 'an older view workflow (no MIRROR_SOURCE) means the clock');
});
