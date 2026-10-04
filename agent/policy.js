// The caretaker's policy: given what a person sees (clawd.js decode()), the next action, or
// null when there is nothing (more) to do. Only the actions a person has, decided from the
// published state line - no values are read or set that Home Assistant doesn't show.
//
// What it optimises, from the engine's rules (n8n/clawd-engine.js, action() and decayStep()):
// - The adult form is decided by the care score at ADULT_AT_HOURS: at least CARE_HAPPY is a
//   happy adult (Nightmare: 960), at most CARE_GRUMPY a grumpy one (850).
// - Care is earned by feeding below 70 % food (+10; above 90 % a feed costs happiness), cleaning
//   up a poop (+10), medicine for an ill pet (+10) and playing (+5 each, no cooldown, needs 15 %
//   energy and costs 8 %). It is lost when any need reaches 0 (-25) or the pet falls ill (-25).
// - Energy is the limit on playing, and it only comes back while asleep (+43 %/h on Nightmare,
//   against -14 %/h awake). Asleep, happiness does not drop, hunger drops at less than half
//   the speed, the potty timer stops and the pet cannot fall ill.
// So: keep it asleep between visits, and on every visit wake it only for what earns care or
// keeps it safe - medicine, cleaning, a feed below 70 %, and as many plays as its energy allows -
// then put it back to bed. Played every 30 min this reaches a happy adult on Nightmare by a
// wide margin (test/agent-policy.test.js), and the care keeps rising towards a legend.
'use strict';

const POLICY = {
  FEED_BELOW: 70,      // % food: a feed below this earns care (the engine: below 7000 of 10000)
  CLEAN_BELOW: 50,     // % hygiene: clean even without a poop, so hygiene never reaches 0
  PLAY_FROM: 25,       // % energy: play while at least this much is left (a play needs 15 %, costs 8 %)
  TOP_UP_FROM: 20,     // local hour: from here until bedtime, top food and hygiene up for the night
  TOP_UP_BELOW: 90,    // % food / hygiene below which the evening top-up feeds / cleans (a feed above
                       // 90 % costs happiness); a full pet asleep still runs out of food in ~9 h
  MAX_WARM: 15,        // an egg can be warmed up to 15 minutes ahead (60 s per press)
  MAX_ACTIONS: 40      // safety stop for one visit
};

// p: a decoded status (clawd.js decode()). seen: what this visit did so far ({ warm: n, ... }).
// ctx.hour: the local hour (in the pet's time zone), for the evening top-up.
function nextAction(p, seen, ctx) {
  seen = seen || {};
  ctx = ctx || {};
  if (!p || p.dead) return null;                         // a new egg is the owner's decision
  if (p.egg) return (p.hatchProgress === null || p.hatchProgress < 1) && (seen.warm || 0) < POLICY.MAX_WARM ? 'warm' : null;
  if (!p.alive) return null;
  if (p.sick) return 'med';                              // works asleep too
  const sleepsFrom = p.rules && Number.isFinite(p.rules.sleepsFrom) ? p.rules.sleepsFrom : 22;
  const evening = Number.isFinite(ctx.hour) && ctx.hour >= POLICY.TOP_UP_FROM && ctx.hour < sleepsFrom;
  const feedBelow = evening ? POLICY.TOP_UP_BELOW : POLICY.FEED_BELOW;
  const cleanBelow = evening ? POLICY.TOP_UP_BELOW : POLICY.CLEAN_BELOW;
  const awakeFor = p.poops > 0 || p.hygiene < cleanBelow || p.food < feedBelow || p.energy >= POLICY.PLAY_FROM;
  if (p.asleep) return awakeFor && !seen.slept ? 'wake' : null;
  if (p.poops > 0 || p.hygiene < cleanBelow) return 'clean';
  if (p.food < feedBelow && !(seen.fed && evening)) return 'feed';
  if (p.energy >= POLICY.PLAY_FROM) return 'play';
  return 'sleep';                                        // done: back to bed
}

// Run one visit against any `act(name) -> new decoded status` (the real clock or a simulation).
async function visit(status, act, ctx) {
  const seen = { actions: [] };
  let p = status;
  for (let i = 0; i < POLICY.MAX_ACTIONS; i++) {
    const a = nextAction(p, seen, ctx);
    if (!a) break;
    const next = await act(a);
    seen.actions.push(a);
    if (a === 'warm') seen.warm = (seen.warm || 0) + 1;
    if (a === 'sleep') seen.slept = true;
    if (a === 'feed') seen.fed = true;
    if (!next) break;                                    // no answer: stop rather than guess
    if (next.lastEffect === 'refused' && next.effectCounter !== p.effectCounter && a !== 'wake' && a !== 'sleep') {
      // Refused (asleep, too tired): put it to bed if it is awake, then stop.
      if (!next.asleep && a !== 'sleep' && next.alive) { const n2 = await act('sleep'); seen.actions.push('sleep'); p = n2 || next; }
      else p = next;
      break;
    }
    p = next;
  }
  return { actions: seen.actions, status: p };
}

const ClawdPolicy = { POLICY, nextAction, visit };
if (typeof module !== 'undefined' && module.exports) module.exports = ClawdPolicy;
