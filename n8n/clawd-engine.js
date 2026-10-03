// ============================================================================
// Clawd Engine — the pet's rules, shared by the n8n workflows and the tests.
//
// A port of Blueforcer's AWTRIX Berry script "Clawd" (v1.1). The same state
// fields, formulas and thresholds as the original, with the timing driven by
// one setting (HUNGER_EMPTY_HOURS) instead of a fixed 10-second step.
//
// This file is the single source of truth. `node scripts/build.js`
// embeds it into the n8n Code nodes, so never edit the copies inside the
// workflow JSON by hand. It has no dependencies and runs in Node >= 18 and in
// n8n's Code node alike.
//
// Two modes:
//   push - n8n renders every frame and pushes it to AWTRIX as a pushed app.
//   view - the on-device script awtrix/clawd-view.ax draws and handles the
//          buttons; n8n only keeps the rules and publishes the pet's state
//          over MQTT.
// ============================================================================

const ENGINE_VERSION = '2.1.0';

// ---- settings --------------------------------------------------------------
// Every value can be overridden from the workflow's "Settings" node.
const DEFAULTS = {
  MODE: 'push',               // 'push' | 'view'
  AWTRIX_HOST: '192.168.1.50',// IP or host name of the clock, no http://
  MQTT_PREFIX: 'awtrixNG',    // AWTRIX NG's MQTT prefix
  APP_NAME: 'clawd',          // pushed app name (push) / script name (view)
  PET_NAME: 'Clawd',
  TZ: '',                     // any IANA time zone; empty: n8n's own time zone
  DIFFICULTY: 'Medium',       // I Can Win | Easy | Medium | Hard | Nightmare: fills in the values below (see PRESETS)
  HUNGER_EMPTY_HOURS: 12,     // awake, full -> empty. The original was ~4 h: an unfed night could starve it.
  EGG_HATCH_MIN: 30,
  CHILD_AT_HOURS: 12,
  TEEN_AT_HOURS: 36,
  ADULT_AT_HOURS: 72,
  ELDER_AT_HOURS: 168,        // adult -> elder
  ELDER_LIFE_HOURS: 96,       // an elder's life, x1.5 if raised happy (a grumpy adult never becomes an elder: it passes away at elder age + half this)
  LEGEND_AFTER_HOURS: 48,     // healthy hours a happy elder needs to become a legend
  SICK_CHANCE_PCT: 2,         // chance per decay step to fall ill while neglected (the original: 2)
  CARE_HAPPY: 200,            // care score for a happy adult (the original: 200) ...
  CARE_GRUMPY: -100,          // ... and for a grumpy one (the original: -100)
  CARE_LEGEND: 400,           // care a happy elder must keep: its hours towards legend only count at or above it
  SLEEP_FROM: 22, SLEEP_TO: 8,   // auto-sleep window, local hours
  NIGHT_FROM: 20, NIGHT_TO: 6,   // night scenery window, local hours
  SOUND: false,               // play RTTTL effects (off by default, like the original)
  NOTIFY: false,              // "<name> needs you!" notifications
  SWITCH_ON_EVENTS: true,     // bring Clawd on screen when it hatches, evolves, falls ill or dies
  STATE_TOPIC: 'clawd/state', // n8n -> device (view) and Home Assistant (both modes)
  CMD_TOPIC: 'clawd/cmd',     // the clock's view app -> n8n (view mode)
  HA_TOPIC: 'clawd/ha',       // Home Assistant -> n8n (both modes): apply and bring Clawd on screen
  CONFIG_TOPIC: 'clawd/config',          // n8n -> anyone: the settings in use (retained JSON)
  CONFIG_SET_TOPIC: 'clawd/config/set',  // anyone -> n8n: change settings, e.g. {"SOUND":true}
  OFFSCREEN_REFRESH_SEC: 30,  // push mode: refresh the frame this often while Clawd is not shown
  STALE_AFTER_SEC: 90,        // push mode: AWTRIX draws a red frame if no update arrives in time
  BURST: true,                // push mode: extra frames while an effect plays
  MIRROR: false,              // also publish the pet as a PNG (e.g. an HA camera); see MIRROR_SOURCE
  MIRROR_TOPIC: 'clawd/screen',
  MIRROR_SOURCE: 'clock',     // view mode: 'clock' = the mirror workflow reads the clock's screen,
                              // 'render' = this workflow draws the frame itself, no clock involved
  MIRROR_EVERY_SEC: 30,       // view mode with MIRROR_SOURCE 'render': publish at least this often (and on every change)
  CLOCK: true                 // view mode: false = no clock at all; never call it (switch to Clawd, notifications)
};

// Difficulty presets, the five skill levels of Quake III Arena. Medium is the
// default game (the original's rules at a friendlier speed); the Settings node
// and live changes can still set any single value on top of a preset.
// The care levels are set from whole-life simulations (test/balance.test.js):
// care builds up faster on faster levels (more meals, more cleaning), so each
// level's thresholds follow its own pace. On every level a caring player (in
// every 2 h) raises a happy adult and a legend; the least careful players who
// still keep the pet alive raise a grumpy one; a legend's time always fits in a
// happy elder's life.
const P = (h, egg, c, t, a, e, life, leg, sick, happy, grumpy, legend) => ({
  HUNGER_EMPTY_HOURS: h, EGG_HATCH_MIN: egg, CHILD_AT_HOURS: c, TEEN_AT_HOURS: t, ADULT_AT_HOURS: a, ELDER_AT_HOURS: e,
  ELDER_LIFE_HOURS: life, LEGEND_AFTER_HOURS: leg, SICK_CHANCE_PCT: sick, CARE_HAPPY: happy, CARE_GRUMPY: grumpy, CARE_LEGEND: legend });
const PRESETS = {
  //                  hungry egg child teen adult elder lifespan legend sick  care: happy grumpy legend
  'I Can Win': P(24,  10,  6, 18,  36, 120, 192, 12, 0,   60,  30,  180),
  'Easy':      P(18,  15,  8, 24,  48, 144, 144, 24, 1,  100,  40,  300),
  'Medium':    P(12,  30, 12, 36,  72, 168,  96, 48, 2,  200,  60,  400),
  'Hard':      P( 8,  45, 16, 48,  96, 192,  72, 60, 3,  330, 240,  550),
  'Nightmare': P( 4,  60, 20, 60, 120, 216,  56, 66, 5,  960, 850, 1400)
};
// A difficulty as typed anywhere ("medium", "I CAN WIN", the old "normal") -> its name, or null.
function presetName(v) {
  const k = String(v === undefined || v === null ? '' : v).toLowerCase().replace(/[^a-z]/g, '');
  return { icanwin: 'I Can Win', easy: 'Easy', medium: 'Medium', normal: 'Medium', hard: 'Hard', nightmare: 'Nightmare' }[k] || null;
}
const PRESET_KEYS = Object.keys(PRESETS.Medium);

// ---- palette and sprites (same as the original) -----------------------------
const CM = {
  o: '#D97757', O: '#E58963', q: '#A8553C', d: '#A94F38', c: '#F0906B',
  x: '#C4694D', w: '#FFFFFF', r: '#E05540', e: '#F2E3C8', s: '#C96F4A',
  y: '#FFD34D', m: '#8B5A2B', g: '#93A7C4', t: '#9AA0A6'
};

const SPR = {
  egg:   ['.eee.', 'eeeee', 'esees', 'eeeee', 'eseee', '.eee.'],
  b1: { a: ['c...c', '.ooo.', 'owowo', '.d.d.'],
        b: ['.....', 'coooc', 'owowo', 'd...d'] },                                   // baby
  b2: { a: ['c....c', '.oooo.', 'owoowo', '.oooo.', '.d..d.'],
        b: ['......', 'cooooc', 'owoowo', '.oooo.', 'd....d'] },                     // child
  b3: { a: ['c.....c', 'c.ooo.c', '.ooooo.', 'owooowo', '.ooooo.', '.d.d.d.'],
        b: ['.......', 'c.ooo.c', 'coooooc', 'owooowo', '.ooooo.', 'd.d.d.d'] },     // teen
  a0: { a: ['.y.yy.y.', 'c.OOOO.c', '.OOOOOO.', 'OOwOOwOO', '.OOOOOO.', '..OOOO..', '.d.d.d.d'],
        b: ['..y..y..', 'ccOOOOcc', '.OOOOOO.', 'OOwOOwOO', '.OOOOOO.', '..OOOO..', 'd.d.d.d.'] }, // adult, happy
  a1: { a: ['cc....cc', 'c.oooo.c', '.oooooo.', 'oowoowoo', '.oooooo.', '..oooo..', '.d.d.d.d'],
        b: ['........', 'ccoooocc', '.oooooo.', 'oowoowoo', '.oooooo.', '..oooo..', 'd.d.d.d.'] }, // adult, normal
  a2: { a: ['xx....xx', 'x.qqqq.x', '.qqqqqq.', 'qqrqqrqq', '.qqqqqq.', '..dddd..', '.d.d.d.d'],
        b: ['........', 'xxqqqqxx', '.qqqqqq.', 'qqrqqrqq', '.qqqqqq.', '..dddd..', 'd.d.d.d.'] }, // adult, grumpy
  // elder: stooped, silver brows, a cream beard and a cane; keeps the adult's type
  e0: { a: ['.........t', '..t..t..tt', 'c.OOOO.c.t', 'OtOOOOtO.t', 'OOwOOwOO.t', '.OOeeOO..t', '.d.d..d..t'],
        b: ['.........t', '..t..t..tt', 'c.OOOO.c.t', 'OtOOOOtO.t', 'OOwOOwOO.t', '.OOeeOO..t', 'd.d...d..t'] },  // elder, happy
  e1: { a: ['.........t', '........tt', 'c.oooo.c.t', 'otooooto.t', 'oowoowoo.t', '.ooeeoo..t', '.d.d..d..t'],
        b: ['.........t', '........tt', 'c.oooo.c.t', 'otooooto.t', 'oowoowoo.t', '.ooeeoo..t', 'd.d...d..t'] },  // elder, normal
  lg: { a: ['..ywwy..', 'c.yyyy.c', '.yyyyyy.', 'yymyymyy', '.yyyyyy.', '..yyyy..', '.O.O.O.O'],
        b: ['...ww...', 'ccyyyycc', '.yyyyyy.', 'yymyymyy', '.yyyyyy.', '..yyyy..', 'O.O.O.O.'] },    // legend
  spirit: ['.yyyy.', '......', 'e.ee.e', 'eteete', '.eeee.', '.e..e.'],               // passed away of old age
  ghost: ['.gggg.', 'gwggwg', 'gggggg', 'gggggg', 'g.g.g.'],
  tomb:  ['.ttt.', 'ttttt', 'tt.tt', 'tt.tt', 'ttttt', 'ttttt'],
  poop:  ['.m.', 'mmm'],
  food:  ['.yy.', 'mmmm', '.ee.'],
  heart: ['r.r', 'rrr', '.r.']
};

const GLY = [
  ['.r....r.', '..r..r..', '...rr...', '...rr...', '..r..r..', '.r....r.'],   // 0 EXIT
  ['........', '..yyyy..', '.yyyyyy.', '.mmmmmm.', '.rrrrrr.', '.eeeeee.'],   // 1 FEED
  ['...y....', '..yyy...', 'yyyyyyy.', '.yyyyy..', '..y.y...', '.y...y..'],   // 2 PLAY
  ['......ee', '.....ee.', '....ee..', '.yee....', 'yyy.....', 'yy......'],   // 3 CLEAN
  ['...rr...', '...rr...', '.rrrrrr.', '.rrrrrr.', '...rr...', '...rr...'],   // 4 MED
  ['..eee...', '.ee.....', '.ee.....', '.ee.....', '.ee.....', '..eee...'],   // 5 SLEEP
  ['......w.', '......w.', '...w..w.', '...w..w.', 'w..w..w.', 'w..w..w.'],   // 6 STATS
  ['.y.y.y..', '..yyy...', 'yyyyyyy.', '..yyy...', '.y.y.y..']                // 7 WAKE
];
const MLAB = ['EXIT', 'FEED', 'PLAY', 'CLEAN', 'MED', 'SLEEP', 'STATS'];
const STARS = [[3, 0], [8, 1], [13, 0], [1, 2], [15, 2]];
const BAR_COLORS = ['#D97757', '#E8C33F', '#3FB4E8', '#4FC96F'];

// Effect ids (ev_k) and how long each one shows, in ms (the original's self.T).
// 1 feed, 2 clean, 3 evolve, 4 hatch, 5 medicine, 6 refused, 7 egg warmed / new
// egg, 8 play result, 9 death, 10 show stats (view mode only), 11 passed away of old age.
const FX_MS = [0, 1500, 1200, 2200, 2200, 900, 700, 600, 1500, 1500, 0, 2200];

// RTTTL per effect id, the same tunes as the original.
const SND = {
  1: 'm:d=16,o=5,b=200:g,p,g,p,g',
  2: 'c:d=32,o=6,b=220:e,g',
  3: 'e:d=16,o=5,b=140:c,e,g,8c6,16p,8e6',
  4: 'h:d=16,o=6,b=180:c,e,g,c7',
  5: 'c:d=32,o=6,b=220:e,g',
  6: 'x:d=16,o=4,b=200:c',
  7: 'c:d=32,o=6,b=220:e,g',
  8: 'w:d=16,o=6,b=180:c,e,g,8c7',
  9: 'd:d=4,o=4,b=70:8e,8d,c',
  11: 'p:d=8,o=5,b=90:g,e,c,4g4'
};
const SND_SICK = 's:d=8,o=5,b=160:e,p,e';

// Home Assistant / device command words -> action ids.
const ACTIONS = { exit: 0, feed: 1, play: 2, clean: 3, med: 4, sleep: 5, stats: 6, reset: 7, wake: 8, warm: 9, newegg: 10 };

// Settings that can be changed while running - from Home Assistant, over MQTT
// (CONFIG_SET_TOPIC), through the webhook, or on the clock (view mode: sound
// and name). The workflow's Settings node gives the defaults; a change made
// this way is kept in the workflow's static data and wins over the node until
// it is cleared ({"SOUND": null}, or {"reset": true} for all). Topics, the
// clock's address and the MQTT prefix stay in the Settings node on purpose: a
// wrong value there would cut n8n off from the topic you'd fix it with.
// [key, kind, Home Assistant name, icon, unit, step]; SLEEP_/NIGHT_ are hours of the day (0-23)
const NUM_RANGES = {
  HUNGER_EMPTY_HOURS: [0.5, 24 * 30], EGG_HATCH_MIN: [1, 24 * 60],
  CHILD_AT_HOURS: [0, 24 * 365], TEEN_AT_HOURS: [0, 24 * 365], ADULT_AT_HOURS: [0, 24 * 365], ELDER_AT_HOURS: [0, 24 * 365],
  ELDER_LIFE_HOURS: [1, 24 * 365], LEGEND_AFTER_HOURS: [1, 24 * 365], SICK_CHANCE_PCT: [0, 100],
  CARE_HAPPY: [-1000, 1000], CARE_GRUMPY: [-1000, 1000], CARE_LEGEND: [-1000, 5000],
  SLEEP_FROM: [0, 23], SLEEP_TO: [0, 23], NIGHT_FROM: [0, 23], NIGHT_TO: [0, 23],
  OFFSCREEN_REFRESH_SEC: [5, 3600], STALE_AFTER_SEC: [0, 86400], MIRROR_EVERY_SEC: [10, 3600]
};
const LIVE_SETTINGS = [
  ['DIFFICULTY', 'select', 'Difficulty', 'mdi:speedometer'],
  ['PET_NAME', 'text', 'Pet name', 'mdi:rename'],
  ['SOUND', 'bool', 'Sound', 'mdi:volume-high'],
  ['NOTIFY', 'bool', 'Notifications', 'mdi:bell-ring'],
  ['SWITCH_ON_EVENTS', 'bool', 'Show on big events', 'mdi:monitor-eye'],
  ['MIRROR', 'bool', 'Screen mirror', 'mdi:monitor-screenshot'],
  ['HUNGER_EMPTY_HOURS', 'number', 'Hunger empties in', 'mdi:food-drumstick-off', 'h', 0.5],
  ['EGG_HATCH_MIN', 'number', 'Egg hatches after', 'mdi:egg', 'min', 1],
  ['CHILD_AT_HOURS', 'number', 'Child at age', 'mdi:baby-face-outline', 'h', 1],
  ['TEEN_AT_HOURS', 'number', 'Teen at age', 'mdi:human-child', 'h', 1],
  ['ADULT_AT_HOURS', 'number', 'Adult at age', 'mdi:human', 'h', 1],
  ['ELDER_AT_HOURS', 'number', 'Elder at age', 'mdi:human-cane', 'h', 1],
  ['ELDER_LIFE_HOURS', 'number', 'Elder lifespan', 'mdi:timer-sand', 'h', 1],
  ['LEGEND_AFTER_HOURS', 'number', 'Legend after', 'mdi:crown', 'h', 1],
  ['SICK_CHANCE_PCT', 'number', 'Sickness chance', 'mdi:virus', '%', 1],
  ['CARE_HAPPY', 'number', 'Care for a happy adult', 'mdi:emoticon-happy-outline', '', 1],
  ['CARE_GRUMPY', 'number', 'Care for a grumpy adult', 'mdi:emoticon-angry-outline', '', 1],
  ['CARE_LEGEND', 'number', 'Care for a legend', 'mdi:crown-outline', '', 1],
  ['SLEEP_FROM', 'number', 'Sleeps from', 'mdi:sleep', '', 1],
  ['SLEEP_TO', 'number', 'Sleeps until', 'mdi:alarm', '', 1],
  ['NIGHT_FROM', 'number', 'Night scene from', 'mdi:weather-night', '', 1],
  ['NIGHT_TO', 'number', 'Night scene until', 'mdi:weather-sunset-up', '', 1],
  ['TZ', 'text', 'Time zone', 'mdi:earth']
];
const LIVE_KEYS = LIVE_SETTINGS.map((x) => x[0]);

// ---- helpers -----------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function c10k(v) { return clamp(v, 0, 10000); }

function toBool(v, dflt) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'off', ''].includes(t)) return false;
  }
  return dflt;
}
function toNum(v, dflt, lo, hi) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return clamp(n, lo, hi);
}
function inRange(v, lo, hi) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n >= lo && n <= hi;
}
function validTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch (e) { return false; }
}

// Normalise whatever the Settings node hands us. Unknown or broken values fall
// back to the defaults, and every fallback is reported in cfg.warnings.
function makeConfig(raw) {
  raw = raw || {};
  const cfg = Object.assign({}, DEFAULTS);
  const warnings = [];
  const pick = (k) => (raw[k] !== undefined && raw[k] !== null && raw[k] !== '' ? raw[k] : undefined);

  for (const k of ['AWTRIX_HOST', 'MQTT_PREFIX', 'APP_NAME', 'PET_NAME', 'STATE_TOPIC', 'CMD_TOPIC', 'HA_TOPIC', 'MIRROR_TOPIC', 'CONFIG_TOPIC', 'CONFIG_SET_TOPIC']) {
    if (pick(k) !== undefined) cfg[k] = String(pick(k)).trim();
  }
  cfg.AWTRIX_HOST = cfg.AWTRIX_HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  cfg.PET_NAME = cfg.PET_NAME.slice(0, 12);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(cfg.APP_NAME)) { warnings.push('APP_NAME'); cfg.APP_NAME = DEFAULTS.APP_NAME; }
  // The clock's commands must never pass for Home Assistant's (they would switch apps).
  if (cfg.HA_TOPIC === cfg.CMD_TOPIC) { warnings.push('HA_TOPIC'); cfg.HA_TOPIC = DEFAULTS.HA_TOPIC === cfg.CMD_TOPIC ? '' : DEFAULTS.HA_TOPIC; }

  // The preset fills in its values first; any value set below wins over it.
  const dif = presetName(pick('DIFFICULTY') || DEFAULTS.DIFFICULTY);
  if (dif) cfg.DIFFICULTY = dif; else warnings.push('DIFFICULTY');
  Object.assign(cfg, PRESETS[cfg.DIFFICULTY]);

  const mode = String(pick('MODE') || DEFAULTS.MODE).toLowerCase();
  if (mode === 'push' || mode === 'view') cfg.MODE = mode; else warnings.push('MODE');
  const src = String(pick('MIRROR_SOURCE') || DEFAULTS.MIRROR_SOURCE).toLowerCase();
  if (src === 'clock' || src === 'render') cfg.MIRROR_SOURCE = src; else warnings.push('MIRROR_SOURCE');

  if (pick('TZ') !== undefined) {
    const tz = String(pick('TZ')).trim();
    if (validTz(tz)) cfg.TZ = tz; else warnings.push('TZ');
  }

  for (const [k, [lo, hi]] of Object.entries(NUM_RANGES)) {
    if (pick(k) === undefined) continue;
    const n = toNum(pick(k), NaN, lo, hi);
    if (Number.isFinite(n)) cfg[k] = n;
    if (!inRange(pick(k), lo, hi)) warnings.push(k);          // unusable, or clamped into range
  }
  for (const k of ['SLEEP_FROM', 'SLEEP_TO', 'NIGHT_FROM', 'NIGHT_TO']) cfg[k] = Math.floor(cfg[k]);
  if (!(cfg.CHILD_AT_HOURS <= cfg.TEEN_AT_HOURS && cfg.TEEN_AT_HOURS <= cfg.ADULT_AT_HOURS && cfg.ADULT_AT_HOURS <= cfg.ELDER_AT_HOURS)) {
    warnings.push('GROWTH_AGES');
    const p = PRESETS[cfg.DIFFICULTY];
    for (const k of ['CHILD_AT_HOURS', 'TEEN_AT_HOURS', 'ADULT_AT_HOURS', 'ELDER_AT_HOURS']) cfg[k] = p[k];
  }
  if (!(cfg.CARE_GRUMPY < cfg.CARE_HAPPY && cfg.CARE_HAPPY <= cfg.CARE_LEGEND)) {
    warnings.push('CARE_LEVELS');
    const p = PRESETS[cfg.DIFFICULTY];
    cfg.CARE_HAPPY = p.CARE_HAPPY; cfg.CARE_GRUMPY = p.CARE_GRUMPY; cfg.CARE_LEGEND = p.CARE_LEGEND;
  }
  for (const k of ['SOUND', 'NOTIFY', 'SWITCH_ON_EVENTS', 'BURST', 'MIRROR', 'CLOCK']) {
    if (pick(k) === undefined) continue;
    cfg[k] = toBool(pick(k), DEFAULTS[k]);
    if (toBool(pick(k), null) === null) warnings.push(k);
  }

  // Derived timing. The original ran one decay step every 10 s and took
  // 10000 / 7 steps (~3.97 h) to empty hunger. Everything that was measured in
  // steps or in "original seconds" is stretched by the same factor.
  cfg.STEP_SEC = cfg.HUNGER_EMPTY_HOURS * 3600 * 7 / 10000;
  cfg.SCALE = cfg.STEP_SEC / 10;
  cfg.warnings = warnings;
  return cfg;
}

// Local hour of `ms` in the configured zone (0-23); no zone: the local clock.
function hourIn(tz, ms) {
  if (!tz) return new Date(ms).getHours();
  try {
    const f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz });
    const h = parseInt(f.format(new Date(ms)), 10);
    if (Number.isFinite(h)) return h % 24;
  } catch (e) { /* fall through */ }
  return new Date(ms).getHours();
}
function inWindow(h, from, to) {
  if (from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

// ---- state -------------------------------------------------------------------
function freshState(gen, nowMs) {
  return {
    st: 0, ev: 0, va: 1,                    // stage (0 egg, 1 alive, 2 dead), evolution 0-4, adult variant
    h: 10000, ha: 10000, en: 10000, cl: 10000, hp: 10000,
    sl: 0, slo: 0, sk: 0,                   // asleep, manual sleep override, sick
    age: 0, warm: 0, cs: 0, gen: gen || 1,  // age (s), egg warmth (s), care score, generation
    pp: 0, pt: 0, cf: 0,                    // poops, potty timer (s), "stat hit zero" flags
    ui: 0, mi: 0, dwell: 0, rp: 0,          // push-mode UI: 0 scene, 1 menu, 3 stats, 5 new-egg confirm
    ev_k: 0, ev_t0: 0, fx: 0, hits: 1,      // last effect id, its start (ms), effect counter, play hits
    stat_open: 0, stat_ms: 8000, stat_turn: 0,
    eld: 0, lgd: 0, lgh: 0, old: 0,          // elder since (age s), legend since, healthy s as a happy elder, died of old age
    lastNotify: 0, decAcc: 0, aslast: null,
    last_ts: Math.floor((nowMs || Date.now()) / 1000),
    saved: 0, v: 2
  };
}

// Fill in fields a state saved by an older version is missing, so a running
// pet survives the upgrade.
function upgradeState(s, nowMs) {
  const f = freshState(s && s.gen, nowMs);
  for (const k of Object.keys(f)) if (s[k] === undefined) s[k] = f[k];
  s.v = 2;
  return s;
}

function fx(s, k, nowMs) { s.ev_k = k; s.ev_t0 = nowMs; s.fx = (s.fx || 0) + 1; }

// ---- time --------------------------------------------------------------------
// Offline catch-up, same shape as the original's boot catch-up: the missed time
// (capped at 12 h) runs at 30% of the live awake rate.
function applyCatchup(s, dtSec, cfg) {
  const el = Math.min(dtSec, 43200);
  s.age += el;
  if (s.st !== 1) return;
  const k = el * 0.3 / cfg.STEP_SEC;        // equivalent decay steps
  s.h = c10k(s.h - 7 * k);
  s.ha = c10k(s.ha - 5 * k);
  s.en = c10k(s.en + 2.5 * k);
  s.cl = c10k(s.cl - 2 * k);
  if (s.pt > 0) {
    s.pt -= el * 0.3;
    if (s.pt <= 0) { s.pt = 0; s.pp = Math.min(s.pp + 1, 3); s.cl = c10k(s.cl - 1500); }
  }
  healthyTime(s, el, cfg);
}

// One decay step: the original's 10-second branch, formula for formula.
function decayStep(s, nowMs, cfg) {
  cfg = cfg || DEFAULTS;
  if (s.st !== 1) return;
  const sl = s.sl === 1;
  const xtra = (s.pp >= 2 || s.sk === 1) ? 5 : 0;
  s.h = c10k(s.h - (sl ? 3 : 7));
  s.ha = c10k(s.ha - (sl ? 0 : 5) - xtra);
  s.en = c10k(s.en + (sl ? 12 : -4));
  s.cl = c10k(s.cl - 2 - 4 * s.pp);

  const vals = [s.h, s.ha, s.en, s.cl];
  let cf = s.cf;
  for (let i = 0; i < 4; i++) {
    const bit = 1 << i;
    if (vals[i] === 0) {
      if ((cf & bit) === 0) { s.cs -= 25; cf ^= bit; }
    } else if (vals[i] > 3000 && (cf & bit) !== 0) {
      cf ^= bit;
    }
  }
  s.cf = cf;

  if (s.sk === 0 && !sl) {
    if ((s.h < 2000 || s.ha < 2000 || s.cl < 2000 || s.pp >= 2) && Math.random() < cfg.SICK_CHANCE_PCT / 100) {
      s.sk = 1; s.cs -= 25;
    }
  }

  let dmg = 0;
  if (s.h === 0) dmg += 12;
  if (s.cl === 0) dmg += 6;
  if (s.sk === 1) dmg += 8;
  s.hp = c10k(dmg > 0 ? s.hp - dmg : s.hp + 5);

  if (s.hp <= 0) { s.st = 2; s.ui = 0; fx(s, 9, nowMs); }
}

function evolve(s, stage, nowMs, cfg) {
  cfg = cfg || DEFAULTS;
  s.ev = stage;
  if (stage === 1) { s.st = 1; fx(s, 4, nowMs); return; }
  if (stage === 4) s.va = s.cs >= cfg.CARE_HAPPY ? 0 : (s.cs <= cfg.CARE_GRUMPY ? 2 : 1);
  if (stage === 5) s.eld = s.age;
  if (stage === 6) s.lgd = s.age;
  fx(s, 3, nowMs);
}

// A happy elder counts towards legend while it stays well raised: healthy
// (health 80%+, not sick) and cared for (care score at least CARE_LEGEND).
function healthyTime(s, dt, cfg) {
  cfg = cfg || DEFAULTS;
  if (s.st === 1 && s.ev === 5 && s.va === 0 && s.hp >= 8000 && s.sk === 0 && s.cs >= cfg.CARE_LEGEND) s.lgh = (s.lgh || 0) + dt;
}

// When a pet passes away of old age (age in s), or null. A grumpy (neglected)
// adult never becomes an elder: it passes away as an adult, half an elder's
// lifespan after the elder age.
function lifeEnd(s, cfg) {
  const life = cfg.ELDER_LIFE_HOURS * 3600;
  if (s.ev === 4 && s.va === 2) return cfg.ELDER_AT_HOURS * 3600 + life * 0.5;
  if (s.ev === 5) return s.eld + life * (s.va === 0 ? 1.5 : 1);
  if (s.ev === 6) return s.lgd + life * 1.5;
  return null;
}

function checkEvolution(s, cfg, nowMs) {
  if (s.st !== 1) return;
  if (s.ev === 1 && s.age >= cfg.CHILD_AT_HOURS * 3600) evolve(s, 2, nowMs, cfg);
  else if (s.ev === 2 && s.age >= cfg.TEEN_AT_HOURS * 3600) evolve(s, 3, nowMs, cfg);
  else if (s.ev === 3 && s.age >= cfg.ADULT_AT_HOURS * 3600) evolve(s, 4, nowMs, cfg);
  else if (s.ev === 4 && s.va !== 2 && s.age >= cfg.ELDER_AT_HOURS * 3600) evolve(s, 5, nowMs, cfg);   // not a grumpy adult
  else if (s.ev === 5 && s.va === 0 && s.lgh >= cfg.LEGEND_AFTER_HOURS * 3600) evolve(s, 6, nowMs, cfg);
  else {
    const end = lifeEnd(s, cfg);
    if (end !== null && s.age >= end) { s.st = 2; s.old = 1; s.ui = 0; fx(s, 11, nowMs); }   // a peaceful old age
  }
}

function isNight(s, cfg, nowMs) {
  return s.sl === 1 || inWindow(hourIn(cfg.TZ, nowMs), cfg.NIGHT_FROM, cfg.NIGHT_TO);
}

// Called on every invocation, whatever triggered it.
function advanceTime(s, cfg, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const dt = Math.max(0, now - (s.last_ts || now));
  s.last_ts = now;

  if (s.st === 0) {
    s.age += dt > 120 ? Math.min(dt, 43200) : dt;         // outages count 12 h at most
    if (s.age + s.warm >= cfg.EGG_HATCH_MIN * 60) evolve(s, 1, nowMs, cfg);
    return;
  }
  if (s.st !== 1) return;

  if (dt > 120) { applyCatchup(s, dt, cfg); checkEvolution(s, cfg, nowMs); return; }

  s.age += dt;

  // Auto-sleep. A manual SLEEP/WAKE lasts until the schedule's next switch
  // point, then the schedule takes over again (same as the original).
  const auto = inWindow(hourIn(cfg.TZ, nowMs), cfg.SLEEP_FROM, cfg.SLEEP_TO);
  if (s.aslast === null || s.aslast === undefined) s.aslast = auto;
  else if (auto !== s.aslast) { s.aslast = auto; s.slo = 0; }
  if (s.slo === 0) s.sl = auto ? 1 : 0;

  if (s.pt > 0 && s.sl !== 1) {
    s.pt -= dt;
    if (s.pt <= 0) { s.pt = 0; s.pp = Math.min(s.pp + 1, 3); s.cl = c10k(s.cl - 1500); }
  }

  // Accumulate real seconds across calls and fire a step each time the total
  // crosses STEP_SEC, carrying the remainder forward.
  s.decAcc = (s.decAcc || 0) + dt;
  const steps = Math.min(Math.ceil(3600 / cfg.STEP_SEC), Math.floor(s.decAcc / cfg.STEP_SEC));
  s.decAcc -= steps * cfg.STEP_SEC;
  for (let i = 0; i < steps; i++) decayStep(s, nowMs, cfg);
  healthyTime(s, dt, cfg);

  checkEvolution(s, cfg, nowMs);
}

// ---- actions -----------------------------------------------------------------
// Push-mode STATS: the text rests this long at the start, scrolls through once,
// and returns to the start for another rest; the engine switches back to the
// pet during that second rest. Measured on an AWTRIX NG 1.1.2 TC001: the docs'
// 21 px/s at speed 100 is really ~23 px/s, so the pass is timed at 21 px/s (it
// has surely ended) and the rest is long enough to cover that gap, the 2 s tick
// and the push. No `repeat`: AWTRIX ends a page, and so the app's whole turn,
// once its repeats are done, before the pet frame could arrive.
// Without `repeat` the page no longer holds the turn open, and one pass takes
// ~11 s against AWTRIX's default 7 s app time, so the page asks for a longer
// `durationMs`. Measured on the clock: AWTRIX compares the current page's
// durationMs (or the global app time, if 0) with how long the app's *turn* has
// run, not with how long the page has been up. So the page asks for the turn
// so far (stat_turn) + the stats + STATS_AFTER_MS margin; a flat
// stat_ms + margin cut STATS opened 12 s into a 30 s turn off after 3 s. When
// the pet frame (no durationMs) replaces the page, the global time applies
// again, so the pet only stays if the turn has time left.
// `mode: "wrap"` is set explicitly so a different global scroll mode (bounce,
// loop) cannot change the timing measured above.
const STATS_HOLD_MS = 3500;
const STATS_AFTER_MS = 4000;
function statsScrollMs(text) { return STATS_HOLD_MS + Math.ceil((text.length * 4 - 1) / 21 * 1000); }

function statsText(s, cfg) {
  const a = s.age;
  const stage = ['EGG', 'BABY', 'CHILD', 'TEEN', 'ADULT', 'ELDER', 'LEGEND'][s.ev] || '';
  return `${cfg.PET_NAME}  ${stage}  AGE ${Math.floor(a / 86400)}d${Math.floor((a % 86400) / 3600)}h  GEN ${s.gen}  CARE ${s.cs}  HP ${Math.floor(s.hp / 100)}%`;
}

// Apply one action. `opt.hits` (0-3) is a Star Catch result from the device;
// without it PLAY is the push mode's instant version.
function action(s, id, cfg, nowMs, opt) {
  opt = opt || {};
  s.ui = 0;
  if (id === 1) {                                        // FEED
    if (s.sl === 1 || s.st !== 1) fx(s, 6, nowMs);
    else {
      if (s.h > 9000) s.ha = c10k(s.ha - 500);
      else if (s.h < 7000) s.cs += 10;
      s.h = c10k(s.h + 4000);
      s.pt = (2700 + Math.floor(Math.random() * 2700)) * cfg.SCALE;
      fx(s, 1, nowMs);
    }
  } else if (id === 2) {                                 // PLAY
    if (s.sl === 1 || s.st !== 1 || s.en < 1500) fx(s, 6, nowMs);
    else if (Number.isInteger(opt.hits)) {
      const h = clamp(opt.hits, 0, 3);
      s.ha = c10k(s.ha + 1000 * h + (h === 3 ? 500 : 0));
      s.en = c10k(s.en - 800);
      if (h >= 2) s.cs += 10;
      s.hits = h;
      fx(s, 8, nowMs);
    } else {
      s.ha = c10k(s.ha + 1500);
      s.en = c10k(s.en - 800);
      s.cs += 5;
      s.hits = 1;
      fx(s, 8, nowMs);
    }
  } else if (id === 3) {                                 // CLEAN
    if (s.sl === 1 || s.st !== 1) fx(s, 6, nowMs);
    else { if (s.pp > 0) s.cs += 10; s.pp = 0; s.cl = 10000; fx(s, 2, nowMs); }
  } else if (id === 4) {                                 // MED
    if (s.sk === 1 && s.st === 1) { s.sk = 0; s.cs += 10; s.ha = c10k(s.ha - 500); fx(s, 5, nowMs); }
    else fx(s, 6, nowMs);
  } else if (id === 5) {                                 // SLEEP toggle
    if (s.st !== 1) return;
    if (s.sl === 1) { s.slo = 1; s.sl = 0; } else { s.slo = 2; s.sl = 1; }
  } else if (id === 6) {                                 // STATS
    if (cfg.MODE === 'view') { fx(s, 10, nowMs); return; } // the device shows them
    s.ui = 3; s.stat_open = nowMs;
    s.stat_ms = statsScrollMs(statsText(s, cfg));
  } else if (id === 7 || id === 10) {                    // RESET / NEW EGG - only while dead
    if (s.st === 2) {
      const gen = s.gen, n = s.fx, legend = s.ev === 6;
      Object.assign(s, freshState(gen + 1, nowMs));
      s.fx = n;                                          // keep the effect counter moving
      if (legend) { s.warm = Math.floor(cfg.EGG_HATCH_MIN * 30); s.cs = 50; }   // a legend's egg: hatches in half the time, a head start in care
      fx(s, 7, nowMs);
    }
  } else if (id === 8) {                                 // WAKE
    if (s.st === 1 && s.sl === 1) { s.slo = 1; s.sl = 0; }
  } else if (id === 9) {                                 // WARM the egg
    if (s.st === 0) { s.warm = Math.max(s.warm, Math.min(s.warm + 60, 900)); fx(s, 7, nowMs); }
  }
}

// Menu and "new egg" timers, checked on every invocation (push mode UI).
function checkDwell(s, cfg, nowMs) {
  if (s.ui === 1 && nowMs - s.dwell >= 2000) {
    action(s, s.mi, cfg, nowMs);
  } else if (s.ui === 5) {
    if (s.rp === 0 && nowMs - s.dwell >= 6000) s.ui = 0;
    else if (s.rp === 1 && nowMs - s.dwell >= 3000) action(s, 10, cfg, nowMs);
  } else if (s.ui === 3 && nowMs - s.stat_open >= (s.stat_ms || 8000)) {
    s.ui = 0;
  }
}

// A physical button press (push mode). Only called while Clawd is on screen.
function onButton(s, btn, cfg, nowMs) {
  if (btn !== 'select') { s.ui = 0; return; }
  if (s.st === 0) action(s, 9, cfg, nowMs);
  else if (s.st === 2) {
    if (s.ui === 5) {
      if (s.rp === 0) { s.rp = 1; s.dwell = nowMs; } else s.ui = 0;
    } else { s.ui = 5; s.rp = 0; s.dwell = nowMs; }
  } else if (s.ui === 0) { s.ui = 1; s.mi = 0; s.dwell = nowMs; }
  else if (s.ui === 1) { s.mi = (s.mi + 1) % 7; s.dwell = nowMs; }
  else if (s.ui === 3) s.ui = 0;
}

// ---- rendering (push mode) ------------------------------------------------------
// Sprites are sent as one "pixels" command per colour, which keeps a frame
// around 1 KB instead of 2 KB.
function Canvas() { this.cmds = []; this.px = new Map(); }
Canvas.prototype.pixel = function (x, y, c) {
  if (!this.px.has(c)) this.px.set(c, []);
  this.px.get(c).push(x, y);
};
Canvas.prototype.flush = function () {
  for (const [c, pts] of this.px) this.cmds.push(['pixels', c].concat(pts));
  this.px = new Map();
};
Canvas.prototype.cmd = function (a) { this.flush(); this.cmds.push(a); };
Canvas.prototype.sprite = function (rows, ox, oy, over, eyes) {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      let c = CM[ch];
      if (!c) continue;
      if (eyes && ch === 'w') c = eyes;
      this.pixel(ox + x, oy + y, over || c);
    }
  }
};
Canvas.prototype.done = function () { this.flush(); return this.cmds; };

function creature(s) {
  if (s.ev === 1) return { pair: SPR.b1, w: 5, h: 4, skin: CM.o };
  if (s.ev === 2) return { pair: SPR.b2, w: 6, h: 5, skin: CM.o };
  if (s.ev === 3) return { pair: SPR.b3, w: 7, h: 6, skin: CM.o };
  if (s.ev === 6) return { pair: SPR.lg, w: 8, h: 7, skin: CM.y };
  if (s.ev === 5) return { pair: s.va === 0 ? SPR.e0 : SPR.e1, w: 10, h: 7, skin: s.va === 0 ? CM.O : CM.o, slow: true };
  if (s.va === 0) return { pair: SPR.a0, w: 8, h: 7, skin: CM.O };
  if (s.va === 2) return { pair: SPR.a2, w: 8, h: 7, skin: CM.q };
  return { pair: SPR.a1, w: 8, h: 7, skin: CM.o };
}

function withLifetime(p, cfg) {
  if (cfg.STALE_AFTER_SEC > 0) { p.lifetimeMs = Math.round(cfg.STALE_AFTER_SEC * 1000); p.lifetimeExpiry = 'mark'; }
  return p;
}

// Render the push-mode frame for time t (ms).
function render(s, cfg, t) {
  if (s.ui === 3) {
    return withLifetime({
      text: statsText(s, cfg), textColor: '#F0E6D8',
      scroll: { mode: 'wrap', speed: 100, holdMs: STATS_HOLD_MS },
      durationMs: (s.stat_turn || 0) + (s.stat_ms || 8000) + STATS_AFTER_MS
    }, cfg);
  }
  const cv = new Canvas();

  if (s.ui === 1) {
    let lab = MLAB[s.mi], glyph = GLY[s.mi];
    if (s.mi === 5 && s.sl === 1) { lab = 'WAKE'; glyph = GLY[7]; }
    cv.sprite(glyph, 0, 1);
    cv.cmd(['text', 11, 1, lab, '#F0E6D8']);
    cv.cmd(['rectFill', 0, 7, 32, 1, '#1A1A1A']);
    const fw = clamp(Math.floor((t - s.dwell) * 32 / 2000), 0, 32);
    if (fw > 0) cv.cmd(['rectFill', 0, 7, fw, 1, '#D97757']);
    return withLifetime({ draw: cv.done() }, cfg);
  }

  if (s.ui === 5) {
    cv.cmd(['rectFill', 0, 7, 32, 1, '#1A1A1A']);
    cv.cmd(['text', 7, 1, 'NEW EGG?', s.rp === 0 ? '#8A8178' : '#F0E6D8']);
    if (s.rp === 1) {
      const fw = clamp(Math.floor((t - s.dwell) * 32 / 3000), 0, 32);
      if (fw > 0) cv.cmd(['rectFill', 0, 7, fw, 1, '#D97757']);
    }
    return withLifetime({ draw: cv.done() }, cfg);
  }

  if (s.st === 2 && s.old === 1) {                          // passed away of old age: a spirit with a halo
    cv.cmd(['line', 0, 7, 16, 7, '#1E2430']);
    cv.sprite(SPR.spirit, 5, (Math.floor(t / 900) % 2 === 0) ? 0 : 1);
    return withLifetime({ draw: cv.done() }, cfg);
  }
  if (s.st === 2) {
    cv.cmd(['line', 0, 7, 16, 7, '#1E2430']);
    cv.sprite(SPR.tomb, 4, 1);
    cv.sprite(SPR.ghost, 11, (Math.floor(t / 800) % 2 === 0) ? 1 : 2);
    return withLifetime({ draw: cv.done() }, cfg);
  }

  const night = isNight(s, cfg, t);
  cv.cmd(['line', 0, 7, 16, 7, night ? '#14203A' : '#1E4D1E']);
  cv.cmd(['rectFill', 1, 0, 2, 2, night ? '#8C8655' : '#9A8430']);
  if (night) {
    for (let i = 0; i < STARS.length; i++) {
      if ((Math.floor(t / 400) + i * 2) % 5 !== 0) cv.pixel(STARS[i][0], STARS[i][1], '#383838');
    }
  } else {
    const cx = Math.floor(t / 900) % 46 - 6;                 // drifting cloud
    if (cx >= -2 && cx <= 14) for (let i = 0; i < 3; i++) if (cx + i >= 0 && cx + i <= 14) cv.pixel(cx + i, 1, '#2A2A2A');
  }

  const ed = t - s.ev_t0;
  const active = (k) => s.ev_k === k && ed >= 0 && ed < FX_MS[k];

  if (s.st === 0) {
    cv.sprite(SPR.egg, (Math.floor(t / 700) % 2 === 0) ? 5 : 6, 1);
    const pr = clamp(Math.floor((s.age + s.warm) * 17 / (cfg.EGG_HATCH_MIN * 60)), 0, 17);
    if (pr > 0) cv.cmd(['rectFill', 0, 7, pr, 1, '#D97757']);
  } else {
    const cr = creature(s);
    const ox = Math.floor((17 - cr.w) / 2), oy = 7 - cr.h;
    for (let i = 0; i < s.pp; i++) cv.sprite(SPR.poop, 12 + i, 5 - i);
    if (s.sl === 1) {
      // asleep: one still pose, eyes shut, a "z" that bobs
      cv.sprite(cr.pair.a, ox, oy, null, cr.skin);
      const up = Math.floor(t / 900) % 2 === 0;
      cv.cmd(['text', ox + cr.w + (up ? 1 : 2), up ? -1 : 0, 'z', '#5C7FBF']);
    } else {
      const pe = (active(1) && ed < 1500) ? 160 : cr.slow ? 1800 : 1200;   // chewing flips faster, elders are slower
      const rows = Math.floor(t / pe) % 2 === 0 ? cr.pair.a : cr.pair.b;
      const flash = (active(3) || active(4)) && Math.floor(ed / 140) % 2 === 0 ? '#FFE9C9' : null;
      const blink = !flash && (t % 4000) < 150;
      cv.sprite(rows, ox, oy, flash, blink ? cr.skin : null);
    }
    if (s.sk === 1 && Math.floor(t / 350) % 2 === 0) { cv.pixel(0, 0, '#35C24A'); cv.pixel(0, 1, '#35C24A'); }
    if (active(1) && ed < 900) cv.sprite(SPR.food, Math.max(0, Math.floor((17 - cr.w) / 2) - 5), 3);
    else if (active(2)) { const bx = Math.floor(ed * 17 / 1200); cv.cmd(['line', bx, 2, bx, 6, '#F2E3C8']); }
    else if (active(5) && Math.floor(ed / 150) % 2 === 0) { cv.cmd(['line', 7, 1, 9, 1, '#35C24A']); cv.cmd(['line', 8, 0, 8, 2, '#35C24A']); }
    else if (active(6)) { cv.cmd(['line', 6, 1, 10, 5, '#E05540']); cv.cmd(['line', 10, 1, 6, 5, '#E05540']); }
  }
  if (active(7)) cv.sprite(SPR.heart, 7, 0);
  else if (active(8)) for (let i = 0; i < s.hits; i++) cv.sprite(SPR.heart, 3 + i * 5, 0);

  // stat bars; a bar under 25% blinks
  const blinkOn = Math.floor(t / 300) % 2 === 0;
  const bars = [s.h, s.ha, s.en, s.cl];
  for (let i = 0; i < 4; i++) {
    cv.cmd(['rectFill', 18, i * 2, 14, 1, '#202020']);
    let w = Math.floor(bars[i] * 14 / 10000);
    if (w < 1 && bars[i] > 0) w = 1;
    if (w > 0 && (bars[i] >= 2500 || blinkOn)) cv.cmd(['rectFill', 18, i * 2, w, 1, BAR_COLORS[i]]);
  }
  return withLifetime({ draw: cv.done() }, cfg);
}

// What a frame shows, minus animation. When it changes while Clawd is off
// screen, the frame is refreshed right away instead of waiting.
function signature(s, cfg, nowMs) {
  const bars = [s.h, s.ha, s.en, s.cl].map((v) => Math.floor(v * 14 / 10000)).join(',');
  return [s.st, s.ev, s.va, s.old, s.pp, s.sk, s.sl, s.ui, s.mi, s.rp, bars, isNight(s, cfg, nowMs) ? 1 : 0].join('|');
}

// While an effect plays (feeding, cleaning, hatching...), push extra frames so
// it animates. Menus get no burst: a second press while an older burst is
// still being sent would flicker between the old and the new label.
function animatedUntil(s, nowMs) {
  if (s.ui !== 0 || !(s.ev_k > 0)) return 0;
  const until = s.ev_t0 + FX_MS[s.ev_k];
  return until > nowMs ? until : 0;
}

// ---- view mode ----------------------------------------------------------------
// The state the device script needs, as one short CSV line (cheap to parse in
// Berry). Field order is part of the protocol; see awtrix/README.md.
// What comes next and in how many seconds: [seconds, what], what = the next
// evolution stage (1 baby ... 6 legend) or 9 for passing away of old age;
// [-1, 0] when nothing is coming (dead). A happy elder's legend counts only
// while it stays well raised, so its countdown assumes it does.
function nextStep(s, cfg) {
  if (s.st === 0) return [Math.max(0, Math.ceil(cfg.EGG_HATCH_MIN * 60 - s.age - s.warm)), 1];
  if (s.st !== 1) return [-1, 0];
  const at = [0, cfg.CHILD_AT_HOURS, cfg.TEEN_AT_HOURS, cfg.ADULT_AT_HOURS];
  if (s.ev >= 1 && s.ev <= 3) return [Math.max(0, Math.ceil(at[s.ev] * 3600 - s.age)), s.ev + 1];
  if (s.ev === 4 && s.va !== 2) return [Math.max(0, Math.ceil(cfg.ELDER_AT_HOURS * 3600 - s.age)), 5];
  const oldAge = Math.max(0, Math.ceil(lifeEnd(s, cfg) - s.age));
  if (s.ev === 5 && s.va === 0) {
    const legend = Math.max(0, Math.ceil(cfg.LEGEND_AFTER_HOURS * 3600 - (s.lgh || 0)));
    if (legend < oldAge) return [legend, 6];
  }
  return [oldAge, 9];
}

function stateLine(s, cfg, nowMs) {
  const nx = nextStep(s, cfg);
  const night = isNight(s, cfg, nowMs) ? 1 : 0;
  return [
    2,                                   // protocol version
    s.st, s.ev, s.va,
    Math.round(s.h), Math.round(s.ha), Math.round(s.en), Math.round(s.cl), Math.round(s.hp),
    s.pp, s.sk, s.sl, night,
    s.gen, s.cs, Math.floor(s.age),
    s.ev_k, s.fx % 100000, s.hits,
    Math.floor(nowMs / 1000),
    Math.floor(s.warm),
    Math.floor(cfg.EGG_HATCH_MIN * 60),
    s.old ? 1 : 0,                       // 22: passed away of old age (added later; older apps read 0-21)
    nx[0], nx[1],                        // 23, 24: seconds until what comes next, and what (see nextStep)
    cfg.SOUND ? 1 : 0,                   // 25: sound on (the view app follows this instead of its own setting)
    String(cfg.PET_NAME).replace(/[^A-Za-z0-9 _.\-]/g, '').slice(0, 12)   // 26: the pet's name (last: free text, no commas)
  ].join(',');
}

function parseCmd(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{')) { try { o = JSON.parse(t); } catch (e) { return null; } }
    else o = { a: t };
  }
  if (!o || typeof o !== 'object') return null;
  const name = String(o.a || o.action || '').toLowerCase();
  if (!(name in ACTIONS)) return null;
  const out = { id: ACTIONS[name] };
  if (o.hits !== undefined) {
    const h = parseInt(o.hits, 10);
    if (Number.isInteger(h) && h >= 0 && h <= 3) out.hits = h;
  }
  return out;
}

// ---- notifications ------------------------------------------------------------
function checkNotify(s, cfg, nowMs) {
  if (!cfg.NOTIFY || s.st !== 1 || s.sl === 1) return null;
  if (nowMs - (s.lastNotify || 0) < 1800000) return null;
  if (s.h < 1500 || s.ha < 1500 || s.cl < 1500 || s.sk === 1) {
    s.lastNotify = nowMs;
    const n = { text: `${cfg.PET_NAME} needs you!`, textColor: '#D97757' };
    if (cfg.SOUND) n.soundRtttl = SND_SICK;
    return n;
  }
  return null;
}

// ---- live settings -----------------------------------------------------------------
// The settings in use: the Settings node's values with the stored changes on top.
function effectiveConfig(raw, store) {
  const o = store.cfg && Object.keys(store.cfg).length ? store.cfg : null;
  if (!o) return raw && raw.STEP_SEC ? raw : makeConfig(raw);
  return makeConfig(Object.assign({}, raw, o));
}

// Apply a settings change ({"SOUND": true, "HUNGER_EMPTY_HOURS": 12}, a JSON
// string or an object). Each key is checked the way the Settings node's values
// are; a key that is unknown, not changeable here, or would be rejected there is
// left out. null clears a stored change, {"reset": true} clears them all. The
// growth ages are checked together, so they can be moved in one message.
function applySettings(payload, store, raw) {
  let o = payload;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return { accepted: [], rejected: ['(not JSON)'] }; } }
  const res = { accepted: [], rejected: [] };
  if (!o || typeof o !== 'object' || Array.isArray(o)) { res.rejected.push('(not an object)'); return res; }
  store.cfg = store.cfg || {};
  if (o.reset === true) { store.cfg = {}; res.accepted.push('reset'); }
  // Choosing a difficulty applies it: stored changes to its values go, the
  // Settings node's values stay (leave those empty to follow the difficulty).
  if (o.DIFFICULTY !== undefined && o.DIFFICULTY !== null) {
    const d = presetName(o.DIFFICULTY);
    if (d) { for (const k of PRESET_KEYS) delete store.cfg[k]; store.cfg.DIFFICULTY = d; res.accepted.push('DIFFICULTY'); }
    else res.rejected.push('DIFFICULTY');
  }
  const want = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'reset' || (k === 'DIFFICULTY' && v !== null)) continue;
    if (!LIVE_KEYS.includes(k)) { res.rejected.push(k); continue; }
    if (v === null || (k === 'TZ' && String(v).trim() === '')) { delete store.cfg[k]; res.accepted.push(k); continue; }
    want[k] = v;
  }
  const trial = makeConfig(Object.assign({}, raw || {}, store.cfg, want));
  const before = makeConfig(Object.assign({}, raw || {}, store.cfg));
  const growthBad = trial.warnings.includes('GROWTH_AGES') && !before.warnings.includes('GROWTH_AGES');
  const careBad = trial.warnings.includes('CARE_LEVELS') && !before.warnings.includes('CARE_LEVELS');
  for (const k of Object.keys(want)) {
    const bad = trial.warnings.includes(k) || (growthBad && /_AT_HOURS$/.test(k)) || (careBad && /^CARE_/.test(k)) ||
      (k === 'PET_NAME' && String(want[k]).trim() === '');
    if (bad) res.rejected.push(k);
    else { store.cfg[k] = trial[k]; res.accepted.push(k); }
  }
  return res;
}

// The settings message on CONFIG_TOPIC.
function settingsMessage(cfg) {
  const o = { MODE: cfg.MODE, MIRROR_SOURCE: cfg.MIRROR_SOURCE, CLOCK: cfg.CLOCK };
  for (const k of LIVE_KEYS) o[k] = cfg[k];
  return JSON.stringify(o);
}

// View mode: the clock app has two settings of its own, sound and the pet's
// name. n8n never changes them - saving an app's settings makes AWTRIX restart
// and recompile it, which a clock short on memory may not survive. Instead the
// state line carries n8n's sound and name (fields 25 and 26) and the app follows
// those. The app reports its own values ({"a":"cfg",...} on CMD_TOPIC) when it
// starts and when n8n comes back after a silence; a value that differs from
// what it reported last time was changed in the clock's web UI, and is taken.
const DEVICE_KEYS = [['sound', 'SOUND'], ['name', 'PET_NAME']];
function deviceSync(rep, store, dev, raw) {
  const last = dev.devSync || {};
  const adopt = {};
  for (const [dk, ck] of DEVICE_KEYS) {
    if (rep[dk] === undefined) continue;
    if (last[dk] !== undefined && rep[dk] !== last[dk]) adopt[ck] = rep[dk];
    last[dk] = rep[dk];
  }
  if (Object.keys(adopt).length) applySettings(adopt, store, raw);
  dev.devSync = last;
}
function parseDeviceReport(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch (e) { return null; } }
  if (!o || typeof o !== 'object' || String(o.a || '').toLowerCase() !== 'cfg') return null;
  const r = {};
  if (typeof o.sound === 'boolean') r.sound = o.sound;
  if (typeof o.name === 'string' && o.name.trim()) r.name = o.name.trim().slice(0, 12);
  return r;
}

// ---- entry point -----------------------------------------------------------------
// input:  { event: 'tick' }
//         { event: 'button', btn: 'left'|'select'|'right', prefix }  (press edge only)
//         { event: 'active', app, prefix }                           (<prefix>/state/apps/active)
//         { event: 'action', name }                                  (Home Assistant webhook)
//         { event: 'cmd', payload, topic }   (MQTT: CMD_TOPIC from the view app, HA_TOPIC from Home Assistant)
// store:  a persistent object (n8n workflow static data)
// Returns what the workflow should do (see docs/REFERENCE.md, "How it works").
function run(input, store, rawCfg, nowMs) {
  nowMs = nowMs || Date.now();
  input = input || { event: 'tick' };

  if (!store.clawd) store.clawd = freshState(1, nowMs);
  const s = upgradeState(store.clawd, nowMs);
  if (!store.dev) store.dev = { fg: null, fgSince: 0, lastPush: 0, sig: '', lastPub: 0, pubSig: '' };
  const dev = store.dev;

  // Settings changes, from Home Assistant / MQTT / the webhook or the clock.
  const base = rawCfg && rawCfg.STEP_SEC ? rawCfg : makeConfig(rawCfg);
  let ev = input.event;
  let settingsResult = null;
  if (ev === 'cmd' && input.topic !== undefined && input.topic !== '' && input.topic === base.CONFIG_SET_TOPIC) ev = 'config';
  if (ev === 'config') settingsResult = applySettings(input.payload, store, rawCfg);
  const report = ev === 'cmd' ? parseDeviceReport(input.payload) : null;
  if (report) {
    ev = 'device';
    if (base.MODE !== 'view') return Object.assign(emptyOut(base), { ignore: true });
    deviceSync(report, store, dev, rawCfg);
  }
  const cfg = effectiveConfig(rawCfg, store);

  const out = emptyOut(cfg);
  if (settingsResult) out.settings = settingsResult;

  // Messages meant for another device, or of no interest in this mode.
  if ((ev === 'button' || ev === 'active') && input.prefix !== undefined && input.prefix !== cfg.MQTT_PREFIX) {
    out.ignore = true; return out;
  }
  if (cfg.MODE === 'view' && (ev === 'button' || ev === 'active')) { out.ignore = true; return out; }

  const prev = { st: s.st, ev: s.ev, sk: s.sk, fx: s.fx, ui: s.ui };
  const before = significant(s, dev);
  let userAct = false;

  advanceTime(s, cfg, nowMs);
  if (cfg.MODE === 'push') checkDwell(s, cfg, nowMs);

  if (ev === 'active') {
    const wasFg = dev.fg;
    dev.fg = String(input.app || '') === cfg.APP_NAME;
    if (!dev.fg && s.ui !== 0) s.ui = 0;                  // Clawd left the screen: close menus
    if (dev.fg && wasFg !== true) { userAct = true; dev.fgSince = nowMs; } // came on screen: fresh frame, turn starts
  } else if (ev === 'button') {
    if (dev.fg !== true) { out.ignore = true; return out; } // only while Clawd is on screen
    onButton(s, input.btn, cfg, nowMs);
    userAct = true;
  } else if (ev === 'action') {
    const id = ACTIONS[String(input.name || '').toLowerCase()];
    if (id === undefined) { out.ignore = true; return out; }
    action(s, id, cfg, nowMs);
    out.switchTo = true;                                  // HA buttons bring Clawd on screen
    userAct = true;
  } else if (ev === 'cmd') {
    const c = parseCmd(input.payload);
    if (!c) { out.ignore = true; return out; }
    action(s, c.id, cfg, nowMs, c);
    // Home Assistant's topic works like the webhook and brings Clawd on
    // screen; the clock's own commands come from Clawd, already shown.
    if (input.topic !== undefined && input.topic === cfg.HA_TOPIC) out.switchTo = true;
    userAct = true;
  }

  const diedNow = prev.st !== 2 && s.st === 2;
  const evolvedNow = prev.ev !== s.ev;
  const gotSickNow = prev.sk !== 1 && s.sk === 1;
  if (cfg.SWITCH_ON_EVENTS && (diedNow || evolvedNow || gotSickNow)) out.switchTo = true;

  if (cfg.SOUND && cfg.MODE === 'push') {
    if (s.fx !== prev.fx && SND[s.ev_k]) out.sound = SND[s.ev_k];
    else if (gotSickNow) out.sound = SND_SICK;
  }
  out.notify = checkNotify(s, cfg, nowMs);

  if (cfg.MODE === 'push') {
    const sig = signature(s, cfg, nowMs);
    const onScreen = dev.fg !== false;                     // unknown counts as on screen
    out.push = userAct || out.switchTo || onScreen || sig !== dev.sig || s.fx !== prev.fx ||
      nowMs - (dev.lastPush || 0) >= cfg.OFFSCREEN_REFRESH_SEC * 1000;
    // Switching to Clawd with fast:true restarts its turn on the clock, even
    // when it is already on screen, and no new state/apps/active follows.
    if (out.switchTo) dev.fgSince = nowMs;
    // STATS just opened: note how long Clawd's turn has already run (0 if
    // Clawd is not on screen yet, e.g. a Home Assistant command switches to it).
    if (s.ui === 3 && prev.ui !== 3) s.stat_turn = (dev.fg === true && dev.fgSince) ? Math.max(0, nowMs - dev.fgSince) : 0;
    if (out.push) {
      out.payload = render(s, cfg, nowMs);
      dev.lastPush = nowMs; dev.sig = sig;
      if (cfg.MIRROR) out.mirror = cfg.MIRROR_TOPIC;
      // Extra frames every 250 ms while something animates, sent only right
      // after an event (not on plain ticks) and only while Clawd is shown.
      const until = animatedUntil(s, nowMs);
      if (cfg.BURST && until && (onScreen || out.switchTo) && (userAct || s.fx !== prev.fx)) {
        // n8n sends the first one at once and the rest 250 ms apart, so frame k
        // goes out ~100 ms + k x 250 ms from now.
        for (let t = nowMs + 100; t <= Math.min(until, nowMs + 3000); t += 250) out.frames.push(render(s, cfg, t));
      }
    }
  }

  // View mode without the clock's screen: draw the pet here (the push-mode
  // renderer, on the same state) and publish it as the mirror PNG - when what
  // it shows changes, after an action, and at least every MIRROR_EVERY_SEC.
  if (cfg.MODE === 'view' && cfg.MIRROR && cfg.MIRROR_SOURCE === 'render') {
    const msig = signature(s, cfg, nowMs);
    if (userAct || msig !== dev.mirSig || nowMs - (dev.mirAt || 0) >= cfg.MIRROR_EVERY_SEC * 1000) {
      out.payload = render(s, cfg, nowMs);
      out.mirror = cfg.MIRROR_TOPIC;
      dev.mirSig = msig; dev.mirAt = nowMs;
    }
  }
  // No clock at all: nothing to switch to, nowhere to notify.
  if (cfg.MODE === 'view' && !cfg.CLOCK) { out.switchTo = false; out.notify = null; out.sound = null; }

  // The state line: the view app draws from it, and Home Assistant reads it in
  // both modes. Published when anything visible changed, and at least once a
  // minute so a restarted device or HA gets fresh data quickly.
  {
    const line = stateLine(s, cfg, nowMs);
    const f = line.split(',');
    const psig = f.slice(0, 15).concat(f.slice(16, 19), f.slice(20, 23), f.slice(24)).join(',');  // all but age, clock and countdown
    if (psig !== dev.pubSig || nowMs - (dev.lastPub || 0) >= 60000 || userAct) {
      out.publish = { topic: cfg.STATE_TOPIC, message: line, retain: true };
      dev.pubSig = psig; dev.lastPub = nowMs;
    }
  }

  // The settings in use, retained on CONFIG_TOPIC: on every change (wherever it
  // came from), as the answer to every settings message - so a Home Assistant
  // control snaps back when a value is refused - and every 6 h.
  {
    const msg = settingsMessage(cfg);
    if (ev === 'config' || msg !== dev.cfgMsg || nowMs - (dev.cfgPub || 0) >= 6 * 3600000) {
      out.config = { topic: cfg.CONFIG_TOPIC, message: msg, retain: true };
      dev.cfgMsg = msg; dev.cfgPub = nowMs;
    }
  }
  // Should this run's state be saved? Every event and every visible change
  // is; a plain tick that only moved the clock forward is not, at most once a
  // minute. See runN8n() for why that matters.
  out.commit = ev !== 'tick' || significant(s, dev) !== before || nowMs - (s.saved || 0) >= 60000;
  if (out.commit) s.saved = nowMs;
  return out;
}

function emptyOut(cfg) {
  return {
    mode: cfg.MODE, ignore: false, push: false, payload: null, frames: [],
    sound: null, notify: null, switchTo: false, publish: null, mirror: null, config: null,
    base: `http://${cfg.AWTRIX_HOST}`, app: cfg.APP_NAME, warnings: cfg.warnings
  };
}

// Everything in the state except the counters that only move with the clock.
function significant(s, dev) {
  const o = Object.assign({}, s);
  delete o.last_ts; delete o.decAcc; delete o.age; delete o.pt; delete o.saved;
  return JSON.stringify(o) + '|' + dev.fg + '|' + dev.sig + '|' + dev.pubSig + '|' +
    (dev.fg === false ? dev.lastPush : 0) + '|' + dev.lastPub + '|' + dev.cfgPub + '|' + (dev.mirAt || 0);
}

// The n8n entry point. n8n loads the workflow's static data when a run starts
// and writes all of it back when the run ends, so two runs that overlap (a
// tick and a button press) can undo each other's changes. Two things keep
// that window small: the engine works on a copy and only writes it back when
// run() says so (most ticks change nothing worth saving), and the workflow
// hands every HTTP call to a separate background run, so a run that owns the
// state lasts a few milliseconds.
function runN8n(input, staticData, rawCfg, nowMs) {
  const work = {
    clawd: staticData.clawd ? JSON.parse(JSON.stringify(staticData.clawd)) : undefined,
    dev: staticData.dev ? JSON.parse(JSON.stringify(staticData.dev)) : undefined,
    cfg: staticData.cfg ? JSON.parse(JSON.stringify(staticData.cfg)) : undefined
  };
  const r = run(input, work, rawCfg, nowMs);
  if (r.commit) { staticData.clawd = work.clawd; staticData.dev = work.dev; if (work.cfg) staticData.cfg = work.cfg; }
  return r;
}

const ClawdEngine = {
  ENGINE_VERSION, DEFAULTS, ACTIONS, FX_MS, SND, STATS_HOLD_MS, STATS_AFTER_MS, statsScrollMs,
  PRESETS, PRESET_KEYS, presetName, lifeEnd, nextStep, makeConfig, hourIn, inWindow, freshState, upgradeState, applyCatchup, decayStep, advanceTime,
  checkEvolution, action, onButton, checkDwell, render, signature, animatedUntil,
  stateLine, parseCmd, checkNotify, statsText, significant, run, runN8n,
  LIVE_SETTINGS, LIVE_KEYS, NUM_RANGES, effectiveConfig, applySettings, settingsMessage, deviceSync, parseDeviceReport
};
if (typeof module !== 'undefined' && module.exports) module.exports = ClawdEngine;
