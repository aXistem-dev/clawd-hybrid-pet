# Clawd, looked after by an AI agent

Let an agent - Claude Code, Hermes, opencode, or anything that can run a shell command - look after
your Clawd. It plays exactly like a person: it can see what Home Assistant shows and press the same
buttons. It can't change settings or values, so it can't cheat. Its goal is a long life for every
pet, not a high generation count.

Works with the n8n brain (view or push mode): it talks to the pet over MQTT.

## 1. The `clawd` command

[`clawd.js`](clawd.js) needs only Node 18+.

```bash
export CLAWD_MQTT='mqtt://user:password@broker-host:1883'   # the broker the pet lives on
node agent/clawd.js status                                   # what the pet looks like
node agent/clawd.js auto                                     # one check-in: decide and do what it needs
node agent/clawd.js do feed                                  # feed, play, clean, med, sleep, wake, warm, newegg
```

Make it a command: `ln -s "$PWD/agent/clawd.js" ~/.local/bin/clawd` (or anywhere on your `PATH`).
Keep the password out of shared files: put `CLAWD_MQTT` in your shell profile or your agent's
secret store.

| Setting | Default | |
|---|---|---|
| `CLAWD_MQTT` | - | `mqtt://user:password@host:1883`, required |
| `CLAWD_STATE_TOPIC` / `CLAWD_CONFIG_TOPIC` | `clawd/state` / `clawd/config` | if you changed them in n8n |
| `CLAWD_ACTION_TOPIC` | `clawd/ha` | actions go here. `clawd/ha` also brings Clawd on the clock's screen; in view mode, `clawd/cmd` acts without switching the screen |

`status` prints JSON: stage, adult type, the five meters, poop, ill, asleep, care, age, generation,
what comes next and when, the difficulty and its rules, and whether the game is running. `do`
prints the result (`fed`, `refused`, ...) and the new status.

`auto` is a whole check-in: the policy in [`policy.js`](policy.js) decides each next action from
the status, `clawd` sends it and waits for the pet's answer (and 1.5 s more, so n8n has saved the
pet before the next action arrives), until nothing is left to do. It prints three lines - the pet,
what it did, what comes next - and never starts a new egg.

## 2. The skill

[`skills/clawd-caretaker/SKILL.md`](skills/clawd-caretaker/SKILL.md) teaches the agent how Clawd
works, when to check in, and what to do - and to play fair. Install it where your tool looks:

| Tool | Put the `clawd-caretaker` folder in |
|---|---|
| Claude Code | `~/.claude/skills/` (or `.claude/skills/` in a project) |
| opencode | `~/.config/opencode/skills/` (it also reads `~/.claude/skills/`) |
| Hermes | `~/.hermes/skills/games/` (or install it with `skill_manage`) |
| Anything else | `~/.agents/skills/`, or paste the file into the agent's instructions |

## 3. Keep it checking in

The agent has to come back regularly: every 30 minutes, day and night, on every difficulty. Each
check-in is one `clawd auto`; when nothing is needed it does nothing.

- **Claude Code:** `/loop take care of Clawd with the clawd-caretaker skill` - it paces itself - or
  `/schedule` a recurring check-in.
- **Hermes:** a cron job, e.g. every 30 minutes: *"Use the clawd-caretaker skill: check on Clawd and
  do what it needs."* (Checking in more often than needed is harmless - the skill does nothing when
  nothing is needed.)
- **opencode / other tools:** your system's scheduler running the tool non-interactively, e.g.
  `*/30 * * * * opencode run "Use the clawd-caretaker skill: check on Clawd."`

## What it may and may not do

| May | May not |
|---|---|
| read `clawd status` | change settings or the difficulty |
| feed, play, clean, give medicine, put to bed, wake, warm the egg | touch n8n, Home Assistant, the clock or MQTT directly |
| start a new egg after a death, when the owner asks | restart a pet that is still alive to "try again" |

## How well does it play?

[`test/agent-policy.test.js`](../test/agent-policy.test.js) plays `clawd auto`'s policy through
whole lives with the real game engine, seeing only the published state line. On Nightmare, with a
check-in every 30 minutes, every pet becomes a happy adult with about 3,500 care where 960 is
needed, then a legend; nothing ever reaches 0 and it never falls ill. It stays a happy adult with
a quarter of the check-ins missed, with six hours without any every night, and with check-ins only
every hour or two. [`test/agent.test.js`](../test/agent.test.js) plays the older step-by-step routine.
