// Unit tests for n8n/clawd-engine.js. Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../n8n/clawd-engine.js');

// 2026-09-27 10:00 Europe/Berlin (CEST, UTC+2) = 08:00 UTC
const T0 = Date.UTC(2026, 8, 27, 8, 0, 0);
const H = 3600 * 1000;

function alivePet(nowMs, extra) {
  const s = E.freshState(1, nowMs);
  Object.assign(s, { st: 1, ev: 1 }, extra || {});
  return s;
}
function noRandom(t, fn) {
  const orig = Math.random;
  Math.random = () => 0.999;           // no sickness, fixed potty timer
  try { return fn(); } finally { Math.random = orig; }
}
const ALLOWED_KEYS = new Set(['draw', 'text', 'textColor', 'repeat', 'scroll', 'durationMs', 'lifetimeMs', 'lifetimeExpiry']);
const SCROLL_KEYS = new Set(['mode', 'direction', 'entry', 'whenFits', 'speed', 'gap', 'holdMs']);
const CMD_ARGS = { pixel: 4, line: 6, rect: 6, rectFill: 6, circle: 5, circleFill: 5, text: 5, bitmap: 6 };
function assertValidPayload(p) {
  for (const k of Object.keys(p)) assert.ok(ALLOWED_KEYS.has(k), `unexpected payload key ${k}`);
  if ('scroll' in p) {
    assert.ok(p.scroll && typeof p.scroll === 'object' && !Array.isArray(p.scroll), 'scroll must be an object (AWTRIX NG rejects true)');
    for (const [k, v] of Object.entries(p.scroll)) {
      assert.ok(SCROLL_KEYS.has(k), `unknown scroll field ${k}`);
      if (['speed', 'gap', 'holdMs'].includes(k)) assert.ok(Number.isInteger(v) && v >= 0, `scroll.${k}`);
    }
  }
  assert.ok(JSON.stringify(p).length < 8192, 'payload over 8 KB');
  for (const c of p.draw || []) {
    assert.ok(Array.isArray(c) && typeof c[0] === 'string', 'command must be an array');
    if (c[0] === 'pixels') {
      assert.match(c[1], /^#[0-9A-F]{6}$/);
      assert.ok(c.length > 2 && (c.length - 2) % 2 === 0, 'pixels needs x,y pairs');
    } else {
      assert.ok(c[0] in CMD_ARGS, `unknown draw command ${c[0]}`);
      assert.equal(c.length, CMD_ARGS[c[0]], `${c[0]} argument count`);
    }
    for (const v of c.slice(1)) assert.ok(typeof v === 'string' || Number.isInteger(v), `non-integer argument in ${JSON.stringify(c)}`);
  }
}

test('config: defaults derive an ~30 s step for 12 h', () => {
  const cfg = E.makeConfig({});
  assert.equal(cfg.HUNGER_EMPTY_HOURS, 12);
  assert.equal(cfg.TZ, '', 'no zone: n8n\'s own (the n8n wrapper fills it in)');
  assert.ok(Math.abs(cfg.STEP_SEC - 30.24) < 0.01);
  assert.deepEqual(cfg.warnings, []);
});

test('config: bad values fall back and are reported', () => {
  const cfg = E.makeConfig({ TZ: 'Mars/Olympus', HUNGER_EMPTY_HOURS: 'lots', MODE: 'x', SOUND: 'yes', AWTRIX_HOST: 'http://10.0.0.5/' });
  assert.equal(cfg.TZ, '');
  assert.equal(cfg.HUNGER_EMPTY_HOURS, 12);
  assert.equal(cfg.MODE, 'push');
  assert.equal(cfg.SOUND, true);
  assert.equal(cfg.AWTRIX_HOST, '10.0.0.5');
  assert.ok(cfg.warnings.includes('TZ') && cfg.warnings.includes('HUNGER_EMPTY_HOURS') && cfg.warnings.includes('MODE'));
});

test('time zone: hours follow the configured zone, including DST', () => {
  assert.equal(E.hourIn('Europe/Berlin', Date.UTC(2026, 8, 27, 20, 30)), 22);   // summer, UTC+2
  assert.equal(E.hourIn('Europe/Berlin', Date.UTC(2026, 0, 15, 21, 30)), 22);   // winter, UTC+1
  assert.equal(E.hourIn('America/New_York', Date.UTC(2026, 0, 15, 21, 30)), 16);
  assert.equal(E.inWindow(23, 22, 8), true);
  assert.equal(E.inWindow(12, 22, 8), false);
  assert.equal(E.inWindow(9, 8, 17), true);
});

test('timing: hunger drains from full to empty in ~12 h while awake', () => {
  const cfg = E.makeConfig({ SLEEP_FROM: 0, SLEEP_TO: 0 });       // no auto-sleep
  const s = alivePet(T0);
  noRandom(null, () => {
    let t = T0, emptyAt = null;
    while (t < T0 + 24 * H) {
      t += 2000;
      E.advanceTime(s, cfg, t);
      if (s.h === 0 && emptyAt === null) emptyAt = t;
    }
    const hours = (emptyAt - T0) / H;
    assert.ok(hours > 11.8 && hours < 12.2, `hunger empty after ${hours.toFixed(2)} h`);
  });
});

test('timing: at the default speed a pet in bed at 60% hunger still has food at 08:00', () => {
  const cfg = E.makeConfig({ TZ: 'Europe/Berlin' });            // sleeps 22-8
  const bed = Date.parse('2026-09-28T22:00:00+02:00');
  const s = alivePet(bed);
  s.h = 6000;
  noRandom(null, () => {
    for (let t = bed + 60000; t < bed + 10 * H; t += 60000) E.advanceTime(s, cfg, t);
  });
  assert.equal(s.sl, 1, 'asleep all night');
  assert.ok(s.h > 1500, `hunger at 07:59: ${s.h}`);
  assert.equal(s.hp, 10000, 'no damage overnight');
});

test('timing: the original speed is reproduced with HUNGER_EMPTY_HOURS = 3.97', () => {
  const cfg = E.makeConfig({ HUNGER_EMPTY_HOURS: 10000 / 7 * 10 / 3600, SLEEP_FROM: 0, SLEEP_TO: 0 });
  assert.ok(Math.abs(cfg.STEP_SEC - 10) < 1e-9);
});

test('timing: catch-up after an outage runs at 30% of live speed, never faster', () => {
  const cfg = E.makeConfig({ SLEEP_FROM: 0, SLEEP_TO: 0 });
  const live = alivePet(T0), gap = alivePet(T0);
  noRandom(null, () => {
    for (let t = T0 + 2000; t <= T0 + 3 * H; t += 2000) E.advanceTime(live, cfg, t);
    E.advanceTime(gap, cfg, T0 + 3 * H);                         // one call after a 3 h gap
  });
  const liveDrop = 10000 - live.h, gapDrop = 10000 - gap.h;
  assert.ok(gapDrop > 0 && gapDrop < liveDrop, `catch-up ${gapDrop} vs live ${liveDrop}`);
  assert.ok(Math.abs(gapDrop / liveDrop - 0.3) < 0.02);
  assert.equal(gap.age, 3 * 3600);
});

test('sleep: auto-sleep uses the configured zone', () => {
  const cfg = E.makeConfig({});
  const s = alivePet(T0);
  E.advanceTime(s, cfg, T0 + 2000);                                   // 10:00 Berlin
  assert.equal(s.sl, 0);
  const late = Date.UTC(2026, 8, 27, 20, 30);                         // 22:30 Berlin
  s.last_ts = Math.floor(late / 1000) - 2;
  E.advanceTime(s, cfg, late);
  assert.equal(s.sl, 1);
  const ny = E.makeConfig({ TZ: 'America/New_York' });                // 16:30 in New York
  const s2 = alivePet(late); s2.last_ts = Math.floor(late / 1000) - 2;
  E.advanceTime(s2, ny, late);
  assert.equal(s2.sl, 0);
});

test('sleep: a manual override lasts until the next switch point', () => {
  const cfg = E.makeConfig({});
  const s = alivePet(T0);
  E.advanceTime(s, cfg, T0 + 2000);
  E.action(s, 5, cfg, T0 + 2000);                                     // put to sleep at 10:00
  assert.equal(s.sl, 1);
  E.advanceTime(s, cfg, T0 + 4000);
  assert.equal(s.sl, 1, 'override holds during the day');
  const night = Date.UTC(2026, 8, 27, 20, 1);                          // 22:01, schedule flips
  s.last_ts = Math.floor(night / 1000) - 2;
  E.advanceTime(s, cfg, night);
  assert.equal(s.slo, 0);
  assert.equal(s.sl, 1);
});

test('evolution and hatching follow the configured ages', () => {
  const cfg = E.makeConfig({ CHILD_AT_HOURS: 1, TEEN_AT_HOURS: 2, ADULT_AT_HOURS: 3, EGG_HATCH_MIN: 10 });
  const s = E.freshState(1, T0);
  E.action(s, 9, cfg, T0);                                            // warm the egg: +60 s
  assert.equal(s.warm, 60);
  E.advanceTime(s, cfg, T0 + 9 * 60 * 1000);                          // 9 min + 1 min warmth
  assert.equal(s.st, 1);
  assert.equal(s.ev, 1);
  assert.equal(s.ev_k, 4);
  s.cs = 250;
  noRandom(null, () => { for (let t = T0 + 9 * 60000; t <= T0 + 4 * H; t += 60000) E.advanceTime(s, cfg, t); });
  assert.equal(s.ev, 4);
  assert.equal(s.va, 0, 'high care score gives the happy adult');
});

test('push: buttons are ignored until Clawd is known to be on screen', () => {
  const store = {};
  let r = E.run({ event: 'button', btn: 'select', prefix: 'awtrixNG' }, store, {}, T0);
  assert.equal(r.ignore, true);
  assert.equal(store.clawd.ui, 0);
  r = E.run({ event: 'active', app: 'clawd', prefix: 'awtrixNG' }, store, {}, T0 + 100);
  assert.equal(r.push, true, 'a fresh frame is sent when Clawd comes on screen');
  store.clawd.st = 1; store.clawd.ev = 1;
  r = E.run({ event: 'button', btn: 'select', prefix: 'awtrixNG' }, store, {}, T0 + 200);
  assert.equal(r.ignore, false);
  assert.equal(store.clawd.ui, 1, 'menu opened');
  assert.equal(r.switchTo, false, 'physical buttons never switch apps');
});

test('push: left/right close the menu and never switch back to Clawd', () => {
  const store = {};
  E.run({ event: 'active', app: 'clawd' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 100);
  const r = E.run({ event: 'button', btn: 'right' }, store, {}, T0 + 200);
  assert.equal(store.clawd.ui, 0);
  assert.equal(r.switchTo, false);
  const r2 = E.run({ event: 'active', app: 'Time' }, store, {}, T0 + 300);
  assert.equal(store.dev.fg, false);
  assert.equal(r2.switchTo, false);
  assert.equal(E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 400).ignore, true, 'select on another app does nothing');
});

test('push: leaving the screen closes an open menu', () => {
  const store = {};
  E.run({ event: 'active', app: 'clawd' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 100);
  E.run({ event: 'active', app: 'Time' }, store, {}, T0 + 500);
  assert.equal(store.clawd.ui, 0);
});

test('push: messages from another AWTRIX prefix are ignored', () => {
  const store = {};
  const r = E.run({ event: 'active', app: 'clawd', prefix: 'otherClock' }, store, {}, T0);
  assert.equal(r.ignore, true);
  assert.equal(store.dev.fg, null);
});

test('Home Assistant actions apply and bring Clawd on screen', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1, h: 5000 });
  const r = E.run({ event: 'action', name: 'feed' }, store, {}, T0 + 1000);
  assert.equal(store.clawd.h, 9000);
  assert.equal(r.switchTo, true);
  assert.equal(E.run({ event: 'action', name: 'dance' }, store, {}, T0 + 2000).ignore, true);
});

test('Home Assistant commands on HA_TOPIC apply and bring Clawd on screen, in both modes', () => {
  for (const MODE of ['push', 'view']) {
    const store = {};
    const cfg = { MODE };
    E.run({ event: 'tick' }, store, cfg, T0);
    Object.assign(store.clawd, { st: 1, ev: 1, h: 5000 });
    const r = E.run({ event: 'cmd', payload: 'feed', topic: 'clawd/ha' }, store, cfg, T0 + 1000);
    assert.equal(r.ignore, false, MODE);
    assert.equal(store.clawd.h, 9000, MODE);
    assert.equal(r.switchTo, true, MODE);
    assert.equal(E.run({ event: 'cmd', payload: '{"a":"clean"}', topic: 'clawd/ha' }, store, cfg, T0 + 2000).switchTo, true, MODE);
    assert.equal(E.run({ event: 'cmd', payload: 'dance', topic: 'clawd/ha' }, store, cfg, T0 + 3000).ignore, true, MODE);
  }
  // A renamed topic follows the setting.
  const store = {};
  E.run({ event: 'tick' }, store, { HA_TOPIC: 'home/pet' }, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  assert.equal(E.run({ event: 'cmd', payload: 'feed', topic: 'home/pet' }, store, { HA_TOPIC: 'home/pet' }, T0 + 1000).switchTo, true);
  assert.equal(E.run({ event: 'cmd', payload: 'feed', topic: 'clawd/ha' }, store, { HA_TOPIC: 'home/pet' }, T0 + 2000).switchTo, false);
});

test('the clock\'s own commands on CMD_TOPIC apply but never switch apps', () => {
  for (const MODE of ['push', 'view']) {
    const store = {};
    const cfg = { MODE };
    E.run({ event: 'tick' }, store, cfg, T0);
    Object.assign(store.clawd, { st: 1, ev: 1, h: 5000 });
    const r = E.run({ event: 'cmd', payload: 'feed', topic: 'clawd/cmd' }, store, cfg, T0 + 1000);
    assert.equal(store.clawd.h, 9000, MODE);
    assert.equal(r.switchTo, false, MODE);
    assert.equal(E.run({ event: 'cmd', payload: 'clean' }, store, cfg, T0 + 2000).switchTo, false, `${MODE}, no topic`);
  }
});

test('HA_TOPIC may not equal CMD_TOPIC', () => {
  const cfg = E.makeConfig({ HA_TOPIC: 'clawd/cmd' });
  assert.ok(cfg.warnings.includes('HA_TOPIC'));
  assert.equal(cfg.HA_TOPIC, 'clawd/ha');
  assert.equal(E.makeConfig({ CMD_TOPIC: 'clawd/ha' }).HA_TOPIC, '', 'default taken by CMD_TOPIC: HA topic off');
});

test('push: the state line is published too, for Home Assistant', () => {
  const store = {};
  const cfg = { SLEEP_FROM: 0, SLEEP_TO: 0 };
  const first = E.run({ event: 'tick' }, store, cfg, T0);
  assert.equal(first.publish.topic, 'clawd/state');
  assert.equal(first.publish.retain, true);
  assert.ok(first.publish.message.startsWith('2,0,'), 'egg state line');
  Object.assign(store.clawd, { st: 1, ev: 1 });
  noRandom(null, () => {
    E.run({ event: 'tick' }, store, cfg, T0 + 2000);
    assert.equal(E.run({ event: 'tick' }, store, cfg, T0 + 4000).publish, null, 'nothing changed');
    assert.ok(E.run({ event: 'tick' }, store, cfg, T0 + 64000).publish, 'once a minute');
  });
  assert.ok(E.run({ event: 'cmd', payload: 'clean' }, store, cfg, T0 + 65000).publish, 'a command publishes at once');
});

test('big events switch to Clawd unless SWITCH_ON_EVENTS is off', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  store.clawd.warm = 900; store.clawd.age = 30 * 60;
  const r = E.run({ event: 'tick' }, store, { SWITCH_ON_EVENTS: true }, T0 + 2000);
  assert.equal(store.clawd.st, 1);
  assert.equal(r.switchTo, true, 'hatching switches');
  const store2 = {};
  E.run({ event: 'tick' }, store2, {}, T0);
  store2.clawd.warm = 900; store2.clawd.age = 30 * 60;
  assert.equal(E.run({ event: 'tick' }, store2, { SWITCH_ON_EVENTS: false }, T0 + 2000).switchTo, false);
});

test('sound and notifications are opt-in and use the right effect', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1, h: 1000 });
  let r = E.run({ event: 'action', name: 'feed' }, store, {}, T0 + 1000);
  assert.equal(r.sound, null);
  assert.equal(r.notify, null);
  r = E.run({ event: 'action', name: 'feed' }, store, { SOUND: true }, T0 + 2000);
  assert.equal(r.sound, E.SND[1], 'a second feed plays again');
  store.clawd.h = 1000; store.clawd.lastNotify = 0;
  r = E.run({ event: 'tick' }, store, { NOTIFY: true }, T0 + 3000);
  assert.equal(r.notify.text, 'Clawd needs you!');
  r = E.run({ event: 'tick' }, store, { NOTIFY: true }, T0 + 5000);
  assert.equal(r.notify, null, '30 min cooldown');
});

test('a notification never carries a sound key; in push mode its tune goes to audio/play', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1, h: 1000, lastNotify: 0 });
  let r = E.run({ event: 'tick' }, store, { NOTIFY: true, SOUND: true, MODE: 'push' }, T0 + 1000);
  assert.deepEqual(Object.keys(r.notify).sort(), ['text', 'textColor']);
  assert.ok(r.sound, 'push mode plays a tune with it');
  store.clawd.lastNotify = 0;
  r = E.run({ event: 'tick' }, store, { NOTIFY: true, SOUND: true, MODE: 'view' }, T0 + 2000);
  assert.deepEqual(Object.keys(r.notify).sort(), ['text', 'textColor']);
  assert.equal(r.sound, null, 'view mode: the clock plays its own tunes');
});

test('push: every rendered payload is valid for AWTRIX NG', () => {
  const cfg = E.makeConfig({});
  const cases = [];
  const base = alivePet(T0);
  cases.push(E.freshState(1, T0));
  for (const ev of [1, 2, 3, 4]) for (const va of [0, 1, 2]) cases.push(Object.assign({}, base, { ev, va }));
  cases.push(Object.assign({}, base, { ev: 4, pp: 3, sk: 1, sl: 1, h: 100, ha: 0 }));
  cases.push(Object.assign({}, base, { st: 2 }));
  cases.push(Object.assign({}, base, { ui: 1, mi: 5, sl: 1, dwell: T0 - 1000 }));
  cases.push(Object.assign({}, base, { st: 2, ui: 5, rp: 1, dwell: T0 - 1000 }));
  cases.push(Object.assign({}, base, { ui: 3 }));
  for (let k = 1; k <= 9; k++) cases.push(Object.assign({}, base, { ev_k: k, ev_t0: T0 - 100, hits: 3 }));
  let biggest = 0;
  for (const s of cases) {
    for (const dt of [0, 450, 1300, 7000]) {
      const p = E.render(s, cfg, T0 + dt);
      assertValidPayload(p);
      biggest = Math.max(biggest, JSON.stringify(p).length);
    }
  }
  assert.ok(biggest < 3000, `largest frame ${biggest} bytes`);
});

test('push: stats scroll once and return to the pet within Clawd\'s turn', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  const r = E.run({ event: 'action', name: 'stats' }, store, {}, T0 + 1000);
  assertValidPayload(r.payload);
  // AWTRIX ends the page, and the app's turn, when `repeat` runs out - before
  // the pet frame could replace the text. Found on a real clock.
  assert.ok(!('repeat' in r.payload), 'no repeat');
  assert.deepEqual(r.payload.scroll, { mode: 'wrap', speed: 100, holdMs: E.STATS_HOLD_MS });
  // AWTRIX hands over when the dwell is up, wherever the text is (default 7 s),
  // so the page must ask for enough time: the whole pass plus the pet after it.
  assert.ok(r.payload.durationMs >= store.clawd.stat_ms + 2000, `durationMs ${r.payload.durationMs} vs stats ${store.clawd.stat_ms}`);
  E.run({ event: 'tick' }, store, {}, T0 + 1000 + store.clawd.stat_ms + 10);
  assert.equal(store.clawd.ui, 0);
});

test('push: stats keep the turn open however long Clawd has already been on screen', () => {
  // Measured on the clock (AWTRIX NG 1.1.2): a turn ends when the time since the
  // app came on screen reaches the current page's durationMs, or the global app
  // time when the page has none. Model that and check the whole pass stays visible.
  const REAL_PX_S = 23;
  for (const appMs of [7000, 30000]) {
    for (const openAt of [0, 3000, 12000, 25000, 29000]) {
      const store = {};
      E.run({ event: 'tick' }, store, {}, T0);
      Object.assign(store.clawd, { st: 1, ev: 1 });
      E.run({ event: 'active', app: 'clawd', prefix: 'awtrixNG' }, store, {}, T0);         // turn starts at T0
      if (openAt >= appMs) continue;                                                       // turn already over
      for (const via of ['menu', 'home assistant']) {
        const st = JSON.parse(JSON.stringify(store));
        let r;
        if (via === 'menu') {                                    // STATS highlighted, runs after the 2 s dwell
          Object.assign(st.clawd, { ui: 1, mi: 6, dwell: T0 + openAt - 2000 });
          r = E.run({ event: 'tick' }, st, {}, T0 + openAt);
        } else r = E.run({ event: 'cmd', payload: 'stats', topic: 'clawd/ha' }, st, {}, T0 + openAt);
        assert.equal(st.clawd.ui, 3, via);
        // A switch (fast:true) restarts the turn on the clock; a menu pick does not.
        const turnStart = r.switchTo ? openAt : 0;
        const passEnd = openAt + E.STATS_HOLD_MS + (r.payload.text.length * 4 - 1) / REAL_PX_S * 1000;
        const turnEnd = turnStart + r.payload.durationMs;
        assert.ok(turnEnd >= passEnd, `${via}, app ${appMs}, opened at ${openAt}: turn ends at ${turnEnd}, pass at ${Math.round(passEnd)}`);
        assert.ok(turnEnd <= passEnd + 8000, `${via}, app ${appMs}, opened at ${openAt}: turn held ${Math.round(turnEnd - passEnd)} ms past the pass`);
      }
    }
  }
  // Opened from Home Assistant while another app shows: the switch starts a new turn.
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  E.run({ event: 'active', app: 'Time', prefix: 'awtrixNG' }, store, {}, T0);
  const r = E.run({ event: 'cmd', payload: 'stats', topic: 'clawd/ha' }, store, {}, T0 + 60000);
  assert.equal(r.switchTo, true);
  assert.equal(r.payload.durationMs, store.clawd.stat_ms + E.STATS_AFTER_MS);
});

test('push: stats close after the pass and before a second one, whatever the tick phase', () => {
  // Measured on the clock: rests holdMs, scrolls at ~23 px/s (docs: 21), then
  // rests holdMs again at the start before scrolling a second time.
  const REAL_PX_S = 23, TICK = 2000, PUSH_MS = 300;
  for (const name of ['Clawd', 'Mr Pinchy', 'AAAAAAAAAAAA']) {
    for (const age of [0, 5 * 3600, 400 * 86400]) {
      const text = E.statsText({ age, gen: 12, cs: -1234, hp: 10000 }, E.makeConfig({ PET_NAME: name }));
      const pass = (text.length * 4 - 1) / REAL_PX_S * 1000;
      const passEnd = E.STATS_HOLD_MS + pass, secondStart = passEnd + E.STATS_HOLD_MS;
      const statMs = E.statsScrollMs(text);
      for (let phase = 0; phase < TICK; phase += 250) {
        const closeTick = Math.ceil((statMs - phase) / TICK) * TICK + phase;   // first tick at/after stat_ms
        assert.ok(closeTick >= passEnd, `${name}/${age}: closes before the pass ended`);
        assert.ok(closeTick + PUSH_MS < secondStart, `${name}/${age}: second pass visible (${Math.round(closeTick + PUSH_MS - secondStart)} ms)`);
      }
    }
  }
});

test('push: off screen, plain ticks only push on change or every 30 s', () => {
  const store = {};
  E.run({ event: 'active', app: 'Time' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  store.dev.lastPush = T0; store.dev.sig = E.signature(store.clawd, E.makeConfig({}), T0);
  noRandom(null, () => {
    assert.equal(E.run({ event: 'tick' }, store, {}, T0 + 2000).push, false);
    assert.equal(E.run({ event: 'tick' }, store, {}, T0 + 31000).push, true);
  });
  store.clawd.pp = 1;
  assert.equal(E.run({ event: 'tick' }, store, {}, T0 + 33000).push, true, 'a new poop shows at once');
});

test('push: an effect sends a burst of frames; menu presses and plain ticks do not', () => {
  const store = {};
  E.run({ event: 'active', app: 'clawd' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1, h: 5000 });
  const menu = E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 100);
  assert.equal(menu.frames.length, 0, 'no burst for the menu');
  const r = E.run({ event: 'action', name: 'clean' }, store, {}, T0 + 200);
  assert.ok(r.frames.length >= 4 && r.frames.length <= 6, `${r.frames.length} frames for a 1.2 s effect`);
  const sweep = (p) => (p.draw.find((c) => c[0] === 'line' && c[5] === '#F2E3C8') || [])[1];
  assert.ok(sweep(r.frames[r.frames.length - 2]) > sweep(r.frames[0]), 'the broom moves');
  const tick = E.run({ event: 'tick' }, store, {}, T0 + 300);
  assert.equal(tick.frames.length, 0, 'plain ticks send no burst');
  const off = E.run({ event: 'action', name: 'clean' }, store, { BURST: false }, T0 + 400);
  assert.equal(off.frames.length, 0);
});

test('push: the menu runs the highlighted item after 2 s', () => {
  const store = {};
  E.run({ event: 'active', app: 'clawd' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 1, h: 5000 });
  E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 100);    // EXIT
  E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 600);    // FEED
  E.run({ event: 'tick' }, store, {}, T0 + 2000);
  assert.equal(store.clawd.ui, 1, 'still waiting');
  E.run({ event: 'tick' }, store, {}, T0 + 2700);
  assert.equal(store.clawd.ui, 0);
  assert.equal(store.clawd.h, 9000);
});

test('dead pet: two presses and a 3 s hold start a new egg', () => {
  const store = {};
  E.run({ event: 'active', app: 'clawd' }, store, {}, T0);
  Object.assign(store.clawd, { st: 2, gen: 3 });
  E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 100);
  E.run({ event: 'button', btn: 'select' }, store, {}, T0 + 500);
  E.run({ event: 'tick' }, store, {}, T0 + 3600);
  assert.equal(store.clawd.st, 0);
  assert.equal(store.clawd.gen, 4);
});

test('a state saved by the previous version keeps its values', () => {
  const old = { st: 1, ev: 3, va: 1, h: 4321, ha: 5000, en: 6000, cl: 7000, hp: 8000, sl: 0, slo: 0, sk: 0,
    age: 200000, warm: 900, cs: 55, gen: 2, pp: 1, pt: 100, cf: 0, ui: 0, mi: 0, dwell: 0, rp: 0,
    ev_k: 0, ev_t0: 0, stat_open: 0, lastNotify: 0, decAcc: 12, aslast: false, last_ts: Math.floor(T0 / 1000) };
  const store = { clawd: old };
  E.run({ event: 'tick' }, store, {}, T0 + 2000);
  assert.equal(store.clawd.gen, 2);
  assert.equal(store.clawd.cs, 55);
  assert.equal(store.clawd.ev, 3);
  assert.equal(store.clawd.fx, 0);
  assert.equal(store.clawd.v, 2);
});

test('view: device commands apply, including a Star Catch result', () => {
  const store = {};
  const cfg = { MODE: 'view' };
  E.run({ event: 'tick' }, store, cfg, T0);
  Object.assign(store.clawd, { st: 1, ev: 1, ha: 1000, cs: 0 });
  const r = E.run({ event: 'cmd', payload: '{"a":"play","hits":3}' }, store, cfg, T0 + 1000);
  assert.equal(store.clawd.ha, 4500);
  assert.equal(store.clawd.cs, 10);
  assert.equal(store.clawd.hits, 3);
  assert.equal(r.switchTo, false);
  assert.equal(r.publish.topic, 'clawd/state');
  assert.equal(r.publish.retain, true);
  assert.equal(r.publish.message.split(',').length, 27);
  assert.equal(r.publish.message.split(',')[22], '0', 'field 22: not passed away of old age');
  assert.equal(E.run({ event: 'cmd', payload: '{"a":"rm -rf"}' }, store, cfg, T0 + 2000).ignore, true);
  assert.equal(E.run({ event: 'cmd', payload: 'not json {' }, store, cfg, T0 + 2000).ignore, true);
  assert.equal(E.run({ event: 'button', btn: 'select' }, store, cfg, T0 + 2000).ignore, true, 'buttons belong to the device');
});

test('view: state is published on change and at least once a minute', () => {
  const store = {};
  const cfg = { MODE: 'view', SLEEP_FROM: 0, SLEEP_TO: 0 };
  E.run({ event: 'tick' }, store, cfg, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  noRandom(null, () => {
    E.run({ event: 'tick' }, store, cfg, T0 + 2000);
    assert.equal(E.run({ event: 'tick' }, store, cfg, T0 + 4000).publish, null);
    assert.ok(E.run({ event: 'tick' }, store, cfg, T0 + 64000).publish);
  });
  const r = E.run({ event: 'cmd', payload: 'clean' }, store, cfg, T0 + 65000);
  assert.ok(r.publish, 'a command publishes at once');
});

test('view: new egg only works on a dead pet', () => {
  const store = {};
  const cfg = { MODE: 'view' };
  E.run({ event: 'tick' }, store, cfg, T0);
  Object.assign(store.clawd, { st: 1, ev: 2 });
  E.run({ event: 'cmd', payload: 'newegg' }, store, cfg, T0 + 1000);
  assert.equal(store.clawd.st, 1);
  store.clawd.st = 2;
  E.run({ event: 'cmd', payload: 'newegg' }, store, cfg, T0 + 2000);
  assert.equal(store.clawd.st, 0);
  assert.equal(store.clawd.gen, 2);
});

test('n8n: plain ticks that change nothing do not rewrite the stored state', () => {
  const cfg = { SLEEP_FROM: 0, SLEEP_TO: 0 };
  const sd = {};
  E.runN8n({ event: 'tick' }, sd, cfg, T0);
  Object.assign(sd.clawd, { st: 1, ev: 1 });
  E.runN8n({ event: 'active', app: 'clawd' }, sd, cfg, T0 + 100);
  const ref = sd.clawd;
  noRandom(null, () => {
    const r = E.runN8n({ event: 'tick' }, sd, cfg, T0 + 2000);
    assert.equal(r.commit, false);
    assert.equal(r.push, true, 'still pushes a frame');
    assert.equal(sd.clawd, ref, 'stored object untouched');
    // time keeps counting from the last saved timestamp
    let committed = 0;
    for (let t = T0 + 4000; t <= T0 + 120000; t += 2000) if (E.runN8n({ event: 'tick' }, sd, cfg, t).commit) committed++;
    assert.ok(committed >= 2 && committed <= 5, `${committed} saves in 2 minutes`);
    assert.ok(sd.clawd.h < 10000, 'decay steps were saved');
  });
  const r = E.runN8n({ event: 'button', btn: 'select' }, sd, cfg, T0 + 121000);
  assert.equal(r.commit, true);
  assert.equal(sd.clawd.ui, 1);
});

test('review fixes: egg outage capped, view stats, monotonic effects, clamp warnings', () => {
  const cfg = E.makeConfig({});
  const egg = E.freshState(1, T0);
  E.advanceTime(egg, cfg, T0 + 3 * 24 * H);                 // n8n down for 3 days
  assert.equal(egg.age, 43200, 'an outage counts 12 h at most');
  assert.equal(egg.ev, 1, 'hatched once, no instant evolutions');

  const store = {};
  E.run({ event: 'tick' }, store, { MODE: 'view' }, T0);
  Object.assign(store.clawd, { st: 1, ev: 1 });
  const r = E.run({ event: 'action', name: 'stats' }, store, { MODE: 'view' }, T0 + 1000);
  assert.equal(store.clawd.ui, 0, 'view mode keeps no UI state');
  assert.equal(r.publish.message.split(',')[16], '10', 'device is told to show the stats');
  assert.equal(r.switchTo, true);

  const d = {};
  E.run({ event: 'tick' }, d, {}, T0);
  Object.assign(d.clawd, { st: 2, fx: 41 });
  E.run({ event: 'action', name: 'reset' }, d, {}, T0 + 1000);
  assert.equal(d.clawd.fx, 42, 'effect counter keeps counting after a new egg');

  const w = E.makeConfig({ SLEEP_FROM: 25, HUNGER_EMPTY_HOURS: 0 }).warnings;
  assert.ok(w.includes('SLEEP_FROM') && w.includes('HUNGER_EMPTY_HOURS'), 'clamped values are reported');
});

// ---- live settings -----------------------------------------------------------------
const setMsg = (payload) => ({ event: 'cmd', topic: 'clawd/config/set', payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const settingsOf = (r) => JSON.parse(r.config.message);

test('settings: a change over MQTT is checked, kept and used, in both modes', () => {
  for (const MODE of ['push', 'view']) {
    const store = {};
    const cfg = { MODE };
    E.run({ event: 'tick' }, store, cfg, T0);
    const r = E.run(setMsg({ SOUND: true, HUNGER_EMPTY_HOURS: 6, PET_NAME: '  Krabbie  ', TZ: 'America/New_York' }), store, cfg, T0 + 1000);
    assert.deepEqual(r.settings, { accepted: ['SOUND', 'HUNGER_EMPTY_HOURS', 'PET_NAME', 'TZ'], rejected: [] }, MODE);
    const now = settingsOf(r);
    assert.equal(now.SOUND, true); assert.equal(now.HUNGER_EMPTY_HOURS, 6); assert.equal(now.PET_NAME, 'Krabbie'); assert.equal(now.TZ, 'America/New_York');
    assert.equal(r.config.topic, 'clawd/config'); assert.equal(r.config.retain, true);
    const eff = E.effectiveConfig(cfg, store);
    assert.ok(Math.abs(eff.STEP_SEC - 15.12) < 0.01, 'the new speed drives the decay');
    assert.match(E.statsText(store.clawd, eff), /^Krabbie  EGG  AGE/, 'the new name is used');
  }
});

test('settings: refused values, unknown or fixed keys; null and reset undo changes', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  let r = E.run(setMsg({ SOUND: 'maybe', HUNGER_EMPTY_HOURS: 9999, TZ: 'Mars/Olympus', PET_NAME: '   ', AWTRIX_HOST: '1.2.3.4', MQTT_PREFIX: 'x', HA_TOPIC: 'y', BOGUS: 1 }), store, {}, T0 + 1000);
  assert.deepEqual(r.settings.accepted, []);
  assert.deepEqual(r.settings.rejected.sort(), ['AWTRIX_HOST', 'BOGUS', 'HA_TOPIC', 'HUNGER_EMPTY_HOURS', 'MQTT_PREFIX', 'PET_NAME', 'SOUND', 'TZ']);
  assert.deepEqual(store.cfg, {});
  assert.ok(r.config, 'refusals are answered with the settings in use, so controls snap back');
  assert.equal(E.run(setMsg('not json'), store, {}, T0 + 1500).settings.rejected[0], '(not JSON)');

  // growth ages are checked together: moving all three in one message works, one alone out of order does not
  r = E.run(setMsg({ CHILD_AT_HOURS: 48 }), store, {}, T0 + 2000);
  assert.deepEqual(r.settings.rejected, ['CHILD_AT_HOURS'], 'child after teen is refused');
  r = E.run(setMsg({ CHILD_AT_HOURS: 48, TEEN_AT_HOURS: 96, ADULT_AT_HOURS: 144 }), store, {}, T0 + 3000);
  assert.deepEqual(r.settings.accepted, ['CHILD_AT_HOURS', 'TEEN_AT_HOURS', 'ADULT_AT_HOURS']);

  E.run(setMsg({ SOUND: true, NOTIFY: true }), store, {}, T0 + 4000);
  r = E.run(setMsg({ SOUND: null }), store, {}, T0 + 5000);
  assert.equal(settingsOf(r).SOUND, false, 'null goes back to the Settings node value');
  assert.equal(settingsOf(r).NOTIFY, true);
  r = E.run(setMsg({ reset: true }), store, { NOTIFY: false }, T0 + 6000);
  assert.deepEqual(store.cfg, {});
  assert.equal(settingsOf(r).NOTIFY, false); assert.equal(settingsOf(r).CHILD_AT_HOURS, 12);
});

test('settings: the Settings node gives the defaults; stored changes win until cleared', () => {
  const store = {};
  E.run({ event: 'tick' }, store, { SOUND: true }, T0);
  E.run(setMsg({ SOUND: false }), store, { SOUND: true }, T0 + 1000);
  assert.equal(E.effectiveConfig({ SOUND: true }, store).SOUND, false);
  assert.equal(E.effectiveConfig({ SOUND: true, NOTIFY: true }, store).NOTIFY, true, 'other node values still apply');
});

test('settings: published once when they change, on every settings message, and every 6 h', () => {
  const store = {};
  assert.ok(E.run({ event: 'tick' }, store, {}, T0).config, 'first run publishes');
  assert.equal(E.run({ event: 'tick' }, store, {}, T0 + 2000).config, null, 'not on plain ticks');
  assert.ok(E.run({ event: 'tick' }, store, { NOTIFY: true }, T0 + 4000).config, 'a Settings node edit is published');
  assert.ok(E.run(setMsg({}), store, { NOTIFY: true }, T0 + 6000).config, 'an empty settings message is answered');
  assert.ok(E.run({ event: 'tick' }, store, { NOTIFY: true }, T0 + 6 * H + 7000).config, 'and again after 6 h');
});

test('settings: kept in the workflow static data between runs', () => {
  const sd = {};
  E.runN8n({ event: 'tick' }, sd, {}, T0);
  E.runN8n(setMsg({ SOUND: true }), sd, {}, T0 + 1000);
  assert.deepEqual(sd.cfg, { SOUND: true });
  assert.equal(JSON.parse(E.runN8n(setMsg({}), sd, {}, T0 + 2000).config.message).SOUND, true);
});

test('settings: the webhook and a live MIRROR switch work too', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  const r = E.run({ event: 'config', payload: { MIRROR: true } }, store, {}, T0 + 1000);
  assert.deepEqual(r.settings.accepted, ['MIRROR']);
  const f = E.run({ event: 'active', app: 'clawd', prefix: 'awtrixNG' }, store, {}, T0 + 2000);
  assert.equal(f.mirror, 'clawd/screen', 'push mode mirrors once MIRROR is switched on live');
});

test('view: n8n never changes the clock app\'s settings; the state line carries sound and name, and a change made on the clock is taken', () => {
  const cfg = { MODE: 'view' };
  const rep = (sound, name) => ({ event: 'cmd', topic: 'clawd/cmd', payload: JSON.stringify({ a: 'cfg', sound, name }) });
  const line = (r) => r.publish.message.split(',');
  const store = {};
  let r = E.run({ event: 'tick' }, store, cfg, T0);
  assert.deepEqual([line(r)[25], line(r)[26]], ['0', 'Clawd'], 'fields 25 and 26: sound and name');
  assert.equal(r.devicePatch, undefined, 'nothing is ever sent to the app');

  r = E.run(rep(true, 'Clawd'), store, cfg, T0 + 1000);
  assert.equal(E.effectiveConfig(cfg, store).SOUND, false, 'first report: only noted, n8n keeps its value');
  r = E.run(rep(true, 'Clawd'), store, cfg, T0 + 2000);
  assert.equal(E.effectiveConfig(cfg, store).SOUND, false, 'the same report again: nothing changed on the clock');

  r = E.run(rep(false, 'Krabbie'), store, cfg, T0 + 3000);   // changed in the clock's web UI
  const now = JSON.parse(r.config.message);
  assert.equal(now.SOUND, false); assert.equal(now.PET_NAME, 'Krabbie', 'a change made on the clock is taken');
  r = E.run(setMsg({ SOUND: true, PET_NAME: 'Mr "P", Jr' }), store, cfg, T0 + 4000);
  assert.deepEqual([line(r)[25], line(r)[26]], ['1', 'Mr P Jr'], 'the line follows n8n; no commas or quotes in the name field');
  r = E.run(rep(false, 'Krabbie'), store, cfg, T0 + 5000);   // the app restarts, its own values unchanged
  assert.equal(E.effectiveConfig(cfg, store).SOUND, true, 'an unchanged clock setting does not undo a change from Home Assistant');

  const push = {};
  E.run({ event: 'tick' }, push, {}, T0);
  assert.equal(E.run(rep(true, 'X'), push, {}, T0 + 1000).ignore, true, 'push mode has no clock app');
});

test('time zone: empty means the local clock, and clearing it over MQTT goes back to that', () => {
  assert.equal(E.hourIn('', Date.UTC(2026, 8, 27, 20, 30)), new Date(Date.UTC(2026, 8, 27, 20, 30)).getHours());
  const store = {};
  E.run({ event: 'tick' }, store, { TZ: 'Asia/Tokyo' }, T0);
  E.run(setMsg({ TZ: 'America/New_York' }), store, { TZ: 'Asia/Tokyo' }, T0 + 1000);
  const r = E.run(setMsg({ TZ: '' }), store, { TZ: 'Asia/Tokyo' }, T0 + 2000);
  assert.equal(JSON.parse(r.config.message).TZ, 'Asia/Tokyo', 'blank clears the change');
});

test('n8n wrapper: without a TZ setting the pet uses n8n\'s time zone ($now.zoneName)', () => {
  const wf = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'n8n', 'clawd-workflow-view.json'), 'utf8'));
  const js = wf.nodes.find((n) => n.name === 'Clawd Engine').parameters.jsCode;
  const vm = require('vm');
  const sd = {};
  const ctx = { $input: { all: () => [{ json: { event: 'tick', cfg: { MODE: 'view', TZ: '' } } }] }, $getWorkflowStaticData: () => sd,
    $now: { zoneName: 'Pacific/Auckland' }, Intl, Date, Math, JSON, String, Number, Object, Array, Map, Set, parseInt, parseFloat, module: { exports: {} } };
  vm.createContext(ctx);
  const out = vm.runInContext(`(function(){${js}\n})()`, ctx);
  assert.equal(JSON.parse(out[0].json.config.message).TZ, 'Pacific/Auckland');
});

// ---- difficulty presets -----------------------------------------------------------------
const LEVELS = ['I Can Win', 'Easy', 'Medium', 'Hard', 'Nightmare'];

test('difficulty: five Quake III levels fill in the values, Medium is the default game, a set value wins', () => {
  assert.deepEqual(Object.keys(E.PRESETS), LEVELS);
  const n = E.makeConfig({});
  assert.equal(n.DIFFICULTY, 'Medium');
  for (const [k, v] of Object.entries(E.PRESETS.Medium)) assert.equal(n[k], v, k);
  assert.deepEqual([n.HUNGER_EMPTY_HOURS, n.CHILD_AT_HOURS, n.ADULT_AT_HOURS, n.SICK_CHANCE_PCT, n.CARE_HAPPY], [12, 12, 72, 2, 200], 'medium is the game as it was');
  assert.equal(n.CARE_GRUMPY, 60, 'except grumpy: the original -100 was out of reach for a pet that survives (see balance.test.js)');
  const h = E.makeConfig({ DIFFICULTY: 'Hard', HUNGER_EMPTY_HOURS: '', CHILD_AT_HOURS: '' });
  assert.equal(h.DIFFICULTY, 'Hard');
  assert.equal(h.HUNGER_EMPTY_HOURS, 8, 'an empty Settings value follows the difficulty');
  assert.equal(E.makeConfig({ DIFFICULTY: 'Easy', HUNGER_EMPTY_HOURS: 10 }).HUNGER_EMPTY_HOURS, 10, 'a filled-in value wins');
  const bad = E.makeConfig({ DIFFICULTY: 'insane' });
  assert.equal(bad.DIFFICULTY, 'Medium'); assert.ok(bad.warnings.includes('DIFFICULTY'));
  assert.ok(E.makeConfig({ ADULT_AT_HOURS: 200 }).warnings.includes('GROWTH_AGES'), 'an adult older than an elder is refused');
  assert.ok(E.makeConfig({ CARE_HAPPY: -200 }).warnings.includes('CARE_LEVELS'));
  assert.ok(E.makeConfig({ CARE_LEGEND: 100 }).warnings.includes('CARE_LEVELS'), 'a legend needs at least a happy adult\'s care');
  for (const d of LEVELS) {
    assert.ok(E.PRESETS[d].CARE_LEGEND > E.PRESETS[d].CARE_HAPPY, d);
    assert.deepEqual(E.makeConfig({ DIFFICULTY: d }).warnings, [], `${d} is valid on its own`);
  }
});

test('difficulty: names are forgiving, and the old three-level names still work', () => {
  for (const [typed, name] of [['i can win', 'I Can Win'], ['ICANWIN', 'I Can Win'], ['easy', 'Easy'], ['normal', 'Medium'], ['MEDIUM', 'Medium'], ['hard', 'Hard'], ['nightmare', 'Nightmare']]) {
    assert.equal(E.presetName(typed), name, typed);
    assert.equal(E.makeConfig({ DIFFICULTY: typed }).DIFFICULTY, name, typed);
  }
  assert.equal(E.presetName('insane'), null);
});

test('difficulty: every level is harder than the one before, in every value', () => {
  const p = LEVELS.map((d) => E.PRESETS[d]);
  for (let i = 1; i < p.length; i++) {
    for (const k of ['HUNGER_EMPTY_HOURS', 'ELDER_LIFE_HOURS']) assert.ok(p[i][k] < p[i - 1][k], `${LEVELS[i]} ${k}`);
    for (const k of ['EGG_HATCH_MIN', 'CHILD_AT_HOURS', 'TEEN_AT_HOURS', 'ADULT_AT_HOURS', 'ELDER_AT_HOURS', 'LEGEND_AFTER_HOURS', 'SICK_CHANCE_PCT', 'CARE_HAPPY', 'CARE_GRUMPY', 'CARE_LEGEND']) {
      assert.ok(p[i][k] > p[i - 1][k], `${LEVELS[i]} ${k}`);
    }
  }
});

test('difficulty: choosing one live applies it, clearing earlier changes to its values only', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  E.run(setMsg({ HUNGER_EMPTY_HOURS: 20, SOUND: true }), store, {}, T0 + 1000);
  let r = E.run(setMsg({ DIFFICULTY: 'nightmare' }), store, {}, T0 + 2000);
  let now = JSON.parse(r.config.message);
  assert.equal(now.DIFFICULTY, 'Nightmare'); assert.equal(now.HUNGER_EMPTY_HOURS, 4, 'the preset really applies');
  assert.equal(now.SOUND, true, 'other settings stay');
  r = E.run(setMsg({ EGG_HATCH_MIN: 5 }), store, {}, T0 + 3000);
  now = JSON.parse(r.config.message);
  assert.equal(now.DIFFICULTY, 'Nightmare'); assert.equal(now.EGG_HATCH_MIN, 5); assert.equal(now.CHILD_AT_HOURS, 20, 'one value changed, the rest still nightmare');
  assert.deepEqual(E.run(setMsg({ DIFFICULTY: 'insane' }), store, {}, T0 + 4000).settings.rejected, ['DIFFICULTY']);
  assert.deepEqual(E.run(setMsg({ CARE_HAPPY: -500 }), store, {}, T0 + 5000).settings.rejected, ['CARE_HAPPY'], 'happy must stay above grumpy');
});

test('difficulty: a pet in bed at 60% hunger - food left up to Medium, hungry on Hard; on Nightmare it needs a night feed', () => {
  const bed = Date.parse('2026-09-28T22:00:00+02:00');
  const night = (d, feedAt) => {
    const cfg = E.makeConfig({ TZ: 'Europe/Berlin', DIFFICULTY: d });
    const s = alivePet(bed);
    s.h = 6000;
    noRandom(null, () => {
      for (let t = bed + 60000; t < bed + 10 * H; t += 60000) {
        E.advanceTime(s, cfg, t);
        if (feedAt.includes((t - bed) / 60000) && s.st === 1) {        // wake it, feed it, back to bed
          E.action(s, 8, cfg, t); E.action(s, 1, cfg, t); if (s.h < 7000) E.action(s, 1, cfg, t); E.action(s, 5, cfg, t);
        }
      }
    });
    return s;
  };
  const left = {};
  for (const d of ['I Can Win', 'Easy', 'Medium', 'Hard']) {
    const s = night(d, []);
    assert.equal(s.st, 1, `${d}: alive`);
    left[d] = s.h;
  }
  assert.ok(left['I Can Win'] > left.Easy && left.Easy > left.Medium && left.Medium > 1500, JSON.stringify(left));
  assert.ok(left.Hard < 1500 && left.Hard > 0, 'hard: hungry by morning');
  assert.equal(night('Nightmare', []).st, 2, 'nightmare: an unfed night is fatal');
  const fed = night('Nightmare', [180, 360]);                          // feeds at 01:00 and 04:00
  assert.equal(fed.st, 1, 'nightmare: two night feeds and it wakes up fine');
  assert.ok(fed.h > 0, 'and not starving');
});

// ---- elder, legend, old age -----------------------------------------------------------------
function agedPet(extra) { return alivePet(T0, Object.assign({ ev: 4, va: 1, age: 100 * H / 1000 }, extra)); }

test('elder: a happy or normal adult becomes an elder at ELDER_AT_HOURS and lives by how it was raised', () => {
  const cfg = E.makeConfig({});
  const s = agedPet({ age: 168 * 3600 - 1 });
  E.checkEvolution(s, cfg, T0);
  assert.equal(s.ev, 4);
  s.age += 1;
  E.checkEvolution(s, cfg, T0);
  assert.equal(s.ev, 5); assert.equal(s.eld, 168 * 3600); assert.equal(s.ev_k, 3, 'the evolve flash');
  for (const [va, hours] of [[0, 144], [1, 96]]) {
    const e = agedPet({ ev: 5, va, eld: 168 * 3600, age: (168 + hours) * 3600 - 1 });
    E.checkEvolution(e, cfg, T0);
    assert.equal(e.st, 1, `type ${va}: still alive just before ${hours} h`);
    e.age += 1;
    E.checkEvolution(e, cfg, T0);
    assert.deepEqual([e.st, e.old, e.ev_k], [2, 1, 11], `type ${va}: passes away of old age after ${hours} h as an elder`);
  }
});

test('elder: a grumpy (neglected) adult never becomes an elder and passes away as an adult', () => {
  const cfg = E.makeConfig({});
  const g = agedPet({ va: 2, age: 168 * 3600 });
  E.checkEvolution(g, cfg, T0);
  assert.equal(g.ev, 4, 'still an adult at elder age');
  g.age = (168 + 48) * 3600 - 1;
  E.checkEvolution(g, cfg, T0);
  assert.equal(g.st, 1, 'alive just before elder age + half an elder\'s lifespan');
  g.age += 1;
  E.checkEvolution(g, cfg, T0);
  assert.deepEqual([g.st, g.ev, g.old], [2, 4, 1], 'passes away of old age as an adult');
  const h = E.makeConfig({ DIFFICULTY: 'Hard' });
  assert.equal(E.lifeEnd(agedPet({ va: 2 }), h), (192 + 36) * 3600, 'follows the difficulty');
});

test('legend: only a happy elder that stays healthy and well cared for; it lives longest', () => {
  const cfg = E.makeConfig({ LEGEND_AFTER_HOURS: 2, SLEEP_FROM: 0, SLEEP_TO: 0 });
  const grow = (extra, hours) => {
    const s = agedPet(Object.assign({ ev: 5, eld: 168 * 3600, age: 168 * 3600, cs: 450 }, extra));
    noRandom(null, () => { for (let t = T0 + 60000; t <= T0 + hours * H; t += 60000) { s.h = 10000; E.advanceTime(s, cfg, t); } });
    return s;
  };
  assert.equal(grow({ va: 0 }, 3).ev, 6, 'happy and healthy: legend');
  assert.equal(grow({ va: 1 }, 3).ev, 5, 'a normal elder never');
  assert.equal(grow({ va: 0, sk: 1 }, 3).ev, 5, 'not while sick');
  assert.equal(grow({ va: 0, cs: 399 }, 3).ev, 5, 'not below CARE_LEGEND (400 on normal): it has to stay well raised');
  assert.equal(grow({ va: 0, cs: 400 }, 3).ev, 6, 'exactly at CARE_LEGEND is enough');
  const lg = grow({ va: 0 }, 3);
  assert.ok(lg.lgd > 0);
  assert.equal(E.lifeEnd(lg, cfg), lg.lgd + cfg.ELDER_LIFE_HOURS * 3600 * 1.5);
  assert.ok(E.lifeEnd(lg, cfg) > lg.eld + cfg.ELDER_LIFE_HOURS * 3600 * 1.5, 'longer than a happy elder');
});

test('old age: shown as a spirit, published in field 22, switches Clawd on screen, and a legend\'s egg gets a head start', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 6, va: 0, eld: 100, lgd: 200, age: 200 + 144 * 3600 - 1, gen: 3 });
  const r = E.run({ event: 'tick' }, store, {}, T0 + 2000);
  assert.deepEqual([store.clawd.st, store.clawd.old], [2, 1]);
  assert.equal(r.switchTo, true);
  assert.equal(r.publish.message.split(',')[22], '1');
  const halo = r.payload.draw.find((c) => c[0] === 'pixels' && c[1] === '#FFD34D');
  assert.ok(halo, 'a gold halo instead of the tombstone');
  assert.ok(!r.payload.draw.some((c) => c[0] === 'pixels' && c[1] === '#9AA0A6' && c.length > 20), 'no tombstone');
  E.run({ event: 'action', name: 'reset' }, store, {}, T0 + 3000);
  assert.deepEqual([store.clawd.st, store.clawd.gen, store.clawd.cs, store.clawd.warm], [0, 4, 50, 900], 'legend\'s egg: half the hatch time, care +50');
  E.run({ event: 'cmd', payload: 'warm', topic: 'clawd/ha' }, store, {}, T0 + 4000);
  assert.equal(store.clawd.warm, 900, 'warming never takes warmth away');
});

test('elder and legend: stats name the stage, the old save format upgrades', () => {
  const cfg = E.makeConfig({});
  assert.match(E.statsText(agedPet({ ev: 1 }), cfg), /^Clawd  BABY  AGE/);
  assert.match(E.statsText(agedPet({ ev: 4 }), cfg), /^Clawd  ADULT  AGE/);
  assert.match(E.statsText(agedPet({ ev: 5 }), cfg), /^Clawd  ELDER  AGE/);
  assert.match(E.statsText(agedPet({ ev: 6 }), cfg), /^Clawd  LEGEND  AGE/);
  const old = { st: 1, ev: 4, va: 0, h: 5000, ha: 5000, en: 5000, cl: 5000, hp: 10000, age: 300000, gen: 1, cs: 250 };
  E.upgradeState(old, T0);
  assert.deepEqual([old.eld, old.lgd, old.lgh, old.old], [0, 0, 0, 0]);
});

test('next stage: n8n works out what comes next and when, from the settings in use', () => {
  const cfg = E.makeConfig({});
  const eggS = Object.assign(E.freshState(1, T0), { age: 600, warm: 120 });
  assert.deepEqual(E.nextStep(eggS, cfg), [30 * 60 - 720, 1], 'egg: hatches');
  assert.deepEqual(E.nextStep(agedPet({ ev: 2, age: 20 * 3600 }), cfg), [16 * 3600, 3], 'child: teen at 36 h');
  assert.deepEqual(E.nextStep(agedPet({ ev: 4, va: 1, age: 100 * 3600 }), cfg), [68 * 3600, 5], 'adult: elder at 168 h');
  assert.deepEqual(E.nextStep(agedPet({ ev: 4, va: 2, age: 100 * 3600 }), cfg), [116 * 3600, 9], 'grumpy adult: passes away at 168 + 48 h');
  assert.deepEqual(E.nextStep(agedPet({ ev: 5, va: 1, eld: 168 * 3600, age: 170 * 3600 }), cfg), [94 * 3600, 9], 'normal elder: old age');
  assert.deepEqual(E.nextStep(agedPet({ ev: 5, va: 0, eld: 168 * 3600, age: 170 * 3600, lgh: 3600 }), cfg), [47 * 3600, 6], 'happy elder: legend first');
  assert.deepEqual(E.nextStep(agedPet({ ev: 6, va: 0, lgd: 200 * 3600, age: 210 * 3600 }), cfg), [134 * 3600, 9], 'legend: old age');
  assert.deepEqual(E.nextStep(agedPet({ st: 2 }), cfg), [-1, 0], 'dead: nothing');
  const fast = E.makeConfig({ CHILD_AT_HOURS: 1, TEEN_AT_HOURS: 1, ADULT_AT_HOURS: 1, ELDER_AT_HOURS: 1 });
  assert.deepEqual(E.nextStep(agedPet({ ev: 4, va: 0, age: 1800 }), fast), [1800, 5], 'follows changed settings');
  const line = E.stateLine(agedPet({ ev: 4, va: 1, age: 100 * 3600 }), cfg, T0).split(',');
  assert.deepEqual([line[23], line[24]], [String(68 * 3600), '5'], 'fields 23 and 24');
});

test('next stage: the countdown alone does not republish the state line', () => {
  const store = {};
  E.run({ event: 'tick' }, store, {}, T0);
  Object.assign(store.clawd, { st: 1, ev: 2, age: 20 * 3600 });
  E.run({ event: 'tick' }, store, {}, T0 + 2000);
  assert.equal(E.run({ event: 'tick' }, store, {}, T0 + 20000).publish, null, 'seconds ticking down is not a change');
});
