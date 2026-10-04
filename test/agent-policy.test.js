// The caretaker policy (agent/policy.js), played over whole lives with the real engine. Each
// visit sees only what a person sees - the published state line, decoded by agent/clawd.js -
// and does only what a person can: the same actions Home Assistant's buttons send.
// Randomness (sickness, the potty timer) is seeded, so every run is the same.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../n8n/clawd-engine.js');
const { decode } = require('../agent/clawd.js');
const P = require('../agent/policy.js');

const ID = { feed: 1, play: 2, clean: 3, med: 4, sleep: 5, wake: 8, warm: 9 };

// opts: { every (min), skip(visitIndex, date) -> true to miss that visit, days, seed }
async function life(level, opts) {
  const cfg = E.makeConfig({ TZ: 'Europe/Berlin', DIFFICULTY: level, MODE: 'view' });
  const config = JSON.parse(E.settingsMessage(cfg));
  const hourOf = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' }).format(t));
  const t0 = Date.parse('2026-10-01T08:00:00+02:00');
  const s = E.freshState(1, t0);
  const out = { adult: null, careAtAdult: null, legendAt: null, died: null, old: 0, zeros: 0, sick: 0, visits: 0, actions: 0, minFood: 100 };
  const random = Math.random;
  let seed = opts.seed || 11;
  Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cs = () => s.cs;
  try {
    let visit = 0;
    for (let t = t0 + 60000; t < t0 + (opts.days || 12) * 86400000; t += 60000) {
      const before = cs(), sickBefore = s.sk;
      E.advanceTime(s, cfg, t);
      if (s.cs < before && s.sk === sickBefore) out.zeros++;
      if (s.sk === 1 && sickBefore === 0) out.sick++;
      if (s.st === 2) { out.died = s.age / 3600; out.old = s.old; break; }
      if (s.st === 1) out.minFood = Math.min(out.minFood, Math.round(s.h / 100));
      if (s.ev >= 4 && out.adult === null) { out.adult = ['happy', 'normal', 'grumpy'][s.va]; out.careAtAdult = s.cs; }
      if (s.ev === 6 && out.legendAt === null) out.legendAt = s.age / 3600;
      if ((t - t0) % (opts.every * 60000) !== 0) continue;
      visit++;
      if (opts.skip && opts.skip(visit, new Date(t))) continue;
      out.visits++;
      const see = () => decode(E.stateLine(s, cfg, t), config, t / 1000);
      const r = await P.visit(see(), async (a) => { E.action(s, ID[a], cfg, t); return see(); }, { hour: hourOf(t) });
      out.actions += r.actions.length;
    }
  } finally {
    Math.random = random;
  }
  return out;
}

test('policy: on Nightmare, visits every 30 min raise a happy adult, then a legend', async () => {
  for (const seed of [11, 23, 42, 77, 1234]) {
    const r = await life('Nightmare', { every: 30, seed, days: 14 });
    assert.equal(r.adult, 'happy', `seed ${seed}: ${JSON.stringify(r)}`);
    assert.ok(r.careAtAdult >= 960 + 300, `seed ${seed}: a wide margin (${r.careAtAdult})`);
    assert.ok(r.legendAt !== null, `seed ${seed}: becomes a legend`);
    assert.equal(r.zeros, 0, `seed ${seed}: no need ever reaches 0`);
    assert.ok(r.minFood >= 30, `seed ${seed}: food never below 30 % (${r.minFood})`);
  }
});

test('policy: robust to missed visits - a quarter of them at random, or a whole night', async () => {
  // Every visit has a 1 in 4 chance of being missed (a fixed hash of its number).
  const quarter = await life('Nightmare', { every: 30, seed: 5, skip: (i) => (Math.imul(i, 2654435761) >>> 0) % 4 === 0 });
  assert.equal(quarter.adult, 'happy', JSON.stringify(quarter));
  // A 6-hour gap every night (no visits 00:00 - 06:00).
  const gaps = await life('Nightmare', { every: 30, seed: 9, skip: (i, d) => d.getHours() < 6 });
  assert.equal(gaps.adult, 'happy', JSON.stringify(gaps));
  assert.equal(gaps.zeros, 0, JSON.stringify(gaps));
  // Hourly visits are still enough.
  const hourly = await life('Nightmare', { every: 60, seed: 3 });
  assert.equal(hourly.adult, 'happy', JSON.stringify(hourly));
});

test('policy: one visit wakes the pet only for care, spends its energy on play and puts it back to bed', async () => {
  const p = (o) => Object.assign({ alive: true, egg: false, dead: false, asleep: true, sick: false, poops: 0,
    food: 80, happiness: 90, energy: 10, hygiene: 90 }, o);
  assert.equal(P.nextAction(p({})), null, 'asleep, fed, clean, tired: leave it');
  assert.equal(P.nextAction(p({ energy: 60 })), 'wake');
  assert.equal(P.nextAction(p({ sick: true })), 'med', 'medicine works asleep');
  const awake = p({ asleep: false, energy: 60, poops: 1, food: 50 });
  assert.equal(P.nextAction(awake), 'clean', 'a poop first: +10 and hygiene');
  assert.equal(P.nextAction(Object.assign({}, awake, { poops: 0 })), 'feed', 'then a feed below 70 %');
  assert.equal(P.nextAction(Object.assign({}, awake, { poops: 0, food: 85 })), 'play');
  assert.equal(P.nextAction(Object.assign({}, awake, { poops: 0, food: 85, energy: 20 })), 'sleep');
  assert.equal(P.nextAction({ dead: true }), null, 'a new egg is the owner\'s call');
  assert.equal(P.nextAction({ egg: true, hatchProgress: 0.2 }), 'warm');
});
