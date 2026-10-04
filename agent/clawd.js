#!/usr/bin/env node
// clawd - look after Clawd from a terminal, the way a person does in Home Assistant.
//
//   clawd status          what the pet looks like right now (JSON)
//   clawd do <action>     feed | play | clean | med | sleep | wake | warm | newegg
//   clawd auto            one caretaker visit: the policy in policy.js decides and acts,
//                         then prints three lines to report (never starts a new egg)
//
// It only reads what is published for everyone (the state line and the settings in
// use) and only sends the actions a person has. It cannot change settings, the
// pet's values or anything else - on purpose: an agent using it plays fair.
//
// Configuration (environment):
//   CLAWD_MQTT          mqtt://user:password@host:1883   (required)
//   CLAWD_STATE_TOPIC   default clawd/state
//   CLAWD_CONFIG_TOPIC  default clawd/config
//   CLAWD_ACTION_TOPIC  default clawd/ha  (acts and brings Clawd on screen; in view mode
//                       clawd/cmd acts without switching the clock to Clawd)
// No dependencies: Node 18+.
'use strict';
const net = require('net');
const path = require('path');

const ACTIONS = ['feed', 'play', 'clean', 'med', 'sleep', 'wake', 'warm', 'newegg'];
const STAGES = ['Egg', 'Baby', 'Child', 'Teen', 'Adult', 'Elder', 'Legend'];
const TYPES = ['happy', 'normal', 'grumpy'];
const EFFECTS = { 1: 'fed', 2: 'cleaned', 3: 'evolved', 4: 'hatched', 5: 'cured', 6: 'refused', 7: 'egg warmed / new egg',
  8: 'played', 9: 'died', 10: 'stats shown', 11: 'passed away of old age' };
const NEXT = { 1: 'Baby', 2: 'Child', 3: 'Teen', 4: 'Adult', 5: 'Elder', 6: 'Legend', 9: 'passes away of old age' };

// ---- the state line -> what a person sees ------------------------------------------
function decode(line, config, nowSec) {
  const f = String(line).split(',');
  if (f[0] !== '2' || f.length < 22) return null;
  const n = (i) => Number(f[i]);
  const pct = (i) => Math.round(n(i) / 100);
  const st = n(1), ev = n(2);
  const out = {
    alive: st === 1, egg: st === 0, dead: st === 2,
    stage: st === 0 ? 'Egg' : STAGES[ev] || 'Egg',
    type: ev >= 4 ? TYPES[n(3)] : null,
    passedAwayOfOldAge: f.length > 22 ? n(22) === 1 : false,
    food: pct(4), happiness: pct(5), energy: pct(6), hygiene: pct(7), health: pct(8),
    poops: n(9), sick: n(10) === 1, asleep: n(11) === 1, night: n(12) === 1,
    generation: n(13), care: n(14), ageHours: +(n(15) / 3600).toFixed(1),
    lastEffect: EFFECTS[n(16)] || null, effectCounter: n(17),
    hatchProgress: st === 0 ? +Math.min(1, (n(15) + n(20)) / Math.max(1, n(21))).toFixed(2) : null,
    publishedSecondsAgo: nowSec ? Math.max(0, Math.round(nowSec - n(19))) : null
  };
  if (f.length > 24 && n(23) >= 0) { out.next = NEXT[n(24)] || null; out.nextInHours = +(n(23) / 3600).toFixed(1); }
  if (config) {
    const c = config;
    out.difficulty = c.DIFFICULTY;
    out.rules = {
      hungryAfterHours: c.HUNGER_EMPTY_HOURS, sleepsFrom: c.SLEEP_FROM, sleepsUntil: c.SLEEP_TO,
      childAt: c.CHILD_AT_HOURS, teenAt: c.TEEN_AT_HOURS, adultAt: c.ADULT_AT_HOURS, elderAt: c.ELDER_AT_HOURS,
      elderLifespanHours: c.ELDER_LIFE_HOURS, legendAfterHours: c.LEGEND_AFTER_HOURS, sicknessChancePct: c.SICK_CHANCE_PCT,
      careForHappyAdult: c.CARE_HAPPY, careForGrumpyAdult: c.CARE_GRUMPY, careForLegend: c.CARE_LEGEND, timeZone: c.TZ || null
    };
  }
  // n8n publishes at least once a minute; much older means the brain is not running.
  if (out.publishedSecondsAgo !== null) out.brainRunning = out.publishedSecondsAgo < 300;
  return out;
}

// ---- a minimal MQTT 3.1.1 client (connect, subscribe, publish QoS 0) ----------------
function mqttOptions(url) {
  const u = new URL(url);
  if (u.protocol !== 'mqtt:') throw new Error('CLAWD_MQTT must look like mqtt://user:password@host:1883');
  return { host: u.hostname, port: Number(u.port) || 1883, user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
}
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
function packet(type, body) {
  const len = []; let x = body.length;
  do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; len.push(d); } while (x > 0);
  return Buffer.concat([Buffer.from([type]), Buffer.from(len), body]);
}
function connect(o) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: o.host, port: o.port });
    s.setTimeout(8000, () => { s.destroy(); reject(new Error('MQTT broker timed out')); });
    let buf = Buffer.alloc(0); const handlers = []; let ok = false;
    s.on('error', reject);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        let i = 1, mult = 1, len = 0, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mult; mult *= 128; } while (b & 128);
        if (buf.length < i + len) return;
        const hdr = buf[0], type = hdr >> 4, body = buf.subarray(i, i + len); buf = buf.subarray(i + len);
        if (type === 2) {
          if (body[1] !== 0) { s.destroy(); reject(new Error(`MQTT broker refused the login (code ${body[1]})`)); return; }
          ok = true; resolve({ socket: s, on: (h) => handlers.push(h) });
        } else if (type === 3 && ok) {
          const tl = body.readUInt16BE(0), topic = body.subarray(2, 2 + tl).toString();
          const qos = (hdr >> 1) & 3; const payload = body.subarray(2 + tl + (qos ? 2 : 0)).toString();
          handlers.forEach((h) => h(topic, payload));
        }
      }
    });
    const flags = 0x02 | (o.user ? 0x80 : 0) | (o.pass ? 0x40 : 0);
    const body = Buffer.concat([str('MQTT'), Buffer.from([4, flags, 0, 60]), str('clawd-agent-' + process.pid),
      o.user ? str(o.user) : Buffer.alloc(0), o.pass ? str(o.pass) : Buffer.alloc(0)]);
    s.write(packet(0x10, body));
  });
}
const subscribe = (c, topics) => c.socket.write(packet(0x82, Buffer.concat([Buffer.from([0, 1]), ...topics.map((t) => Buffer.concat([str(t), Buffer.from([0])]))])));
const publish = (c, topic, msg) => c.socket.write(packet(0x30, Buffer.concat([str(topic), Buffer.from(msg, 'utf8')])));
const close = (c) => { c.socket.write(Buffer.from([0xe0, 0])); c.socket.end(); };

// Wait for the retained state line and settings, or for a newer state line.
function collect(c, topics, until, ms) {
  return new Promise((resolve) => {
    const seen = {}; const done = () => { clearTimeout(t); resolve(seen); };
    const t = setTimeout(done, ms);
    c.on((topic, payload) => { seen[topic] = payload; if (until(seen, topic, payload)) done(); });
    subscribe(c, topics);
  });
}

async function main(argv) {
  const env = process.env;
  const T = { state: env.CLAWD_STATE_TOPIC || 'clawd/state', config: env.CLAWD_CONFIG_TOPIC || 'clawd/config', action: env.CLAWD_ACTION_TOPIC || 'clawd/ha' };
  const [cmd, arg] = argv;
  if (cmd !== 'status' && cmd !== 'do' && cmd !== 'auto') {
    console.log('usage: clawd status | clawd auto | clawd do <' + ACTIONS.join('|') + '>');
    return 2;
  }
  if (cmd === 'do' && !ACTIONS.includes(arg)) {
    console.error(`unknown action "${arg}" - allowed: ${ACTIONS.join(', ')}`);
    return 2;
  }
  if (!env.CLAWD_MQTT) { console.error('set CLAWD_MQTT=mqtt://user:password@host:1883'); return 2; }
  const c = await connect(mqttOptions(env.CLAWD_MQTT));
  try {
    const first = await collect(c, [T.state, T.config], (s) => s[T.state] && s[T.config], 5000);
    if (!first[T.state]) { console.error(`no state on ${T.state} - is the Clawd workflow running?`); return 1; }
    const config = first[T.config] ? JSON.parse(first[T.config]) : null;
    const before = decode(first[T.state], config, Date.now() / 1000);
    if (cmd === 'status') { console.log(JSON.stringify(before, null, 2)); return 0; }
    if (cmd === 'auto') return await auto(c, T, first[T.state], config, before);

    // An action: send it, then wait for the pet's answer (a new state line).
    const counter = before.effectCounter, line = first[T.state];
    const waiter = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      c.on((topic, payload) => { if (topic === T.state && payload !== line) { clearTimeout(t); resolve(payload); } });
    });
    publish(c, T.action, arg === 'newegg' ? 'reset' : arg);
    const answer = await waiter;
    const after = answer ? decode(answer, config, Date.now() / 1000) : null;
    const result = !after ? 'no answer yet (it may still be applied)'
      : after.effectCounter !== counter ? (after.lastEffect === 'refused' ? 'refused' : after.lastEffect || 'done') : 'done';
    console.log(JSON.stringify({ action: arg, result, now: after || before }, null, 2));
    return result === 'refused' ? 3 : 0;
  } finally {
    close(c);
  }
}

// One caretaker visit. Each action waits for its own answer: a state line whose effect
// counter moved (or, for wake and sleep, whose sleep flag flipped) - the regular state
// lines n8n publishes in between are not taken for one. Then it waits a moment more:
// n8n saves the pet's state when a run ends, and a second action arriving while the
// first run is still finishing would read and write back the old state (a wake undone,
// a feed refused because the pet still seemed asleep).
const SETTLE_MS = 1500;
async function auto(c, T, line, config, before) {
  const { visit } = require(path.join(__dirname, 'policy.js'));
  let last = line, pending = null;
  c.on((topic, payload) => {
    if (topic !== T.state || payload === last) return;
    last = payload;
    if (pending) pending(payload);
  });
  let cur = before;
  const act = (name) => new Promise((resolve) => {
    const prev = cur;
    const t = setTimeout(() => { pending = null; resolve(null); }, 8000);
    pending = (payload) => {
      const p = decode(payload, config, Date.now() / 1000);
      if (!p) return;
      const done = name === 'wake' ? p.asleep === false : name === 'sleep' ? p.asleep === true : p.effectCounter !== prev.effectCounter;
      if (!done) return;
      clearTimeout(t); pending = null; cur = p;
      setTimeout(() => resolve(p), SETTLE_MS);
    };
    publish(c, T.action, name === 'newegg' ? 'reset' : name);
  });
  const tz = config && config.TZ ? config.TZ : undefined;
  let hour;
  try { hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date())); } catch (e) { hour = new Date().getHours(); }
  const r = await visit(before, act, { hour });
  console.log(report(r.status || before, r.actions, config));
  return 0;
}

// Three lines for the agent to pass on as they are.
function report(p, actions, config) {
  const need = config && config.CARE_HAPPY !== undefined ? ` (happy adult: ${config.CARE_HAPPY} at ${config.ADULT_AT_HOURS}h)` : '';
  const counts = {};
  for (const a of actions) counts[a] = (counts[a] || 0) + 1;
  const did = actions.length ? Object.entries(counts).map(([a, n]) => n > 1 ? `${a} x${n}` : a).join(', ') : 'nothing needed';
  let l1;
  if (p.dead) l1 = `${p.stage} - ${p.passedAwayOfOldAge ? 'passed away of old age' : 'has died'} (gen ${p.generation}, care ${p.care}). A new egg is the owner's decision.`;
  else if (p.egg) l1 = `Egg - hatching ${Math.round((p.hatchProgress || 0) * 100)} %`;
  else l1 = `${p.stage}${p.type ? ' (' + p.type + ')' : ''}, ${p.ageHours}h - food ${p.food} / happy ${p.happiness} / energy ${p.energy} / hygiene ${p.hygiene} / health ${p.health}${p.sick ? ' / ILL' : ''}, care ${p.care}${need}`;
  const l2 = `did: ${did}${p.alive ? (p.asleep ? ' - now asleep' : ' - now awake') : ''}`;
  const l3 = p.next ? `next: ${p.next} in ${p.nextInHours}h` : 'next: -';
  return [l1, l2, l3].join('\n');
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
module.exports = { decode, ACTIONS, main, report };
