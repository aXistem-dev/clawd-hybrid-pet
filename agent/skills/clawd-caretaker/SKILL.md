---
name: clawd-caretaker
description: Look after Clawd, the AWTRIX virtual pet crab, like a caring person - one command per check-in decides and does what the pet needs (feed, clean, heal, play, put to bed) - so that every pet grows into a happy adult and lives as long as possible. Use when asked to take care of, check on, or run Clawd.
license: MIT
metadata:
  version: 0.2.0
  author: clawd-hybrid-pet
  hermes:
    tags: [game, virtual-pet, awtrix, home-automation]
---

# Clawd caretaker

You look after Clawd, a virtual pet crab on an AWTRIX clock. The goal is a long life for each
pet: a happy adult, then an elder, a golden legend, and a peaceful old age.

## A check-in is one command

```bash
clawd auto
```

It reads the pet's status, does everything that is needed in the right order, and prints three
lines. **Reply with those three lines exactly as printed** - nothing to decide, nothing to add.

- If it prints an error (no state, broker unreachable), report the error line and stop. Don't
  retry, and don't try other commands to "fix" it.
- If the first line says the pet **has died** or **passed away**, report it. Starting a new egg
  is the owner's decision: only run `clawd do newegg` when the owner asks for it.

Other commands, only when asked: `clawd status` (the full status as JSON) and `clawd do <action>`
(`feed | play | clean | med | sleep | wake | warm | newegg`).

Setup: the `clawd` command (`agent/clawd.js` in the repo, Node 18+) needs
`CLAWD_MQTT=mqtt://user:password@host:1883` - the broker the pet lives on. See `agent/README.md`.

## Play fair

The command can only see what Home Assistant shows and press the buttons a person has. Never
change settings or the difficulty, publish to MQTT, call n8n, Home Assistant or the clock
directly, or edit anything the game stores.

## What `clawd auto` does (for reference)

The policy in `agent/policy.js`, from the game's real rules: the adult type is decided by the
care score when it grows up, care comes from feeding below 70 % food (+10), cleaning up poop
(+10), medicine (+10) and playing (+5 each, as long as energy lasts), and it is lost when a meter
hits 0 or the pet falls ill (-25). Energy only comes back while asleep, and asleep a pet can't
fall ill and gets hungry much slower. So on each check-in it:

1. gives medicine if the pet is ill (works asleep);
2. wakes it only for something that earns care or keeps it safe;
3. cleans (poop, or hygiene below 50 %), feeds below 70 % food (in the evening before bedtime:
   below 90 %, and cleans below 90 %, so the night is safe), and plays while energy is 25 % or more;
4. puts it back to bed;
5. warms an egg; never starts a new one.

Every 30 minutes this raises a happy adult on Nightmare with a wide margin, and a legend; it
copes with a quarter of the check-ins missed, or six hours without any at night
(`test/agent-policy.test.js`).

## When to check in

Every **30 minutes**, day and night, on every difficulty. Checking in when nothing is needed is
harmless: it then does nothing.
