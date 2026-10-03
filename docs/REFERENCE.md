# Clawd reference

The details behind the [README](../README.md): every setting, how settings reach every
channel, the Home Assistant options, how it works, and how to work on it.

- [Settings](#settings)
- [Difficulty](#difficulty)
- [Life stages](#life-stages)
- [Changing settings while it runs](#changing-settings-while-it-runs)
- [Home Assistant](#home-assistant)
- [Seeing the pet (screen mirror)](#seeing-the-pet-screen-mirror)
- [How it works](#how-it-works)
- [Compared with the original and Moepchi's port](#compared-with-the-original-and-moepchis-port)
- [Development](#development)
- [Known limitations](#known-limitations)

## Settings

The **Settings** node in the n8n workflow. Values n8n can't use fall back to the default and are
listed under `warnings` in the engine's output.

| Setting | Default | |
|---|---|---|
| `AWTRIX_HOST` | `192.168.1.50` | the clock's IP or host name |
| `MQTT_PREFIX` | `awtrixNG` | the clock's MQTT prefix (AWTRIX NG settings) |
| `APP_NAME` | `clawd` | pushed app name (push), or the name of the script on the clock (view) |
| `PET_NAME` | `Clawd` | up to 12 characters |
| `TZ` | *(empty)* | time zone for sleep and night, e.g. `America/New_York`; empty uses n8n's own time zone |
| `DIFFICULTY` | `Medium` | `I Can Win`, `Easy`, `Medium`, `Hard` or `Nightmare` (case and spaces don't matter; the old `normal` means Medium): fills in the values below ([Difficulty](#difficulty)) |
| `HUNGER_EMPTY_HOURS` | *(difficulty)* | awake, full to empty. Medium 12 h; the original is ~4 h (`3.97`), which starves an unfed pet overnight |
| `EGG_HATCH_MIN` | *(difficulty)* | |
| `CHILD_AT_HOURS` / `TEEN_AT_HOURS` / `ADULT_AT_HOURS` / `ELDER_AT_HOURS` | *(difficulty)* | ages at which Clawd grows up |
| `ELDER_LIFE_HOURS` | *(difficulty)* | how long an elder lives, x1.5 if raised happy; a grumpy adult never becomes an elder and passes away at elder age + half of this |
| `LEGEND_AFTER_HOURS` | *(difficulty)* | healthy hours a happy elder needs to become a legend |
| `SICK_CHANCE_PCT` | *(difficulty)* | chance per decay step to fall ill while neglected |
| `CARE_HAPPY` / `CARE_GRUMPY` | *(difficulty)* | care score for a happy / grumpy adult |
| `CARE_LEGEND` | *(difficulty)* | care score a happy elder must keep: its hours towards legend only count at or above it |
| `SLEEP_FROM` / `SLEEP_TO` | `22` / `8` | auto-sleep, hours of the day |
| `NIGHT_FROM` / `NIGHT_TO` | `20` / `6` | night scenery |
| `SOUND` | `false` | effect tunes on the buzzer |
| `NOTIFY` | `false` | "Clawd needs you!", at most every 30 min |
| `SWITCH_ON_EVENTS` | `true` | bring Clawd on screen when it hatches, evolves, falls ill or dies |
| `MIRROR` | `false` | publish the screen as a PNG for Home Assistant ([below](#seeing-the-pet-screen-mirror)) |
| `BURST` | `true` | push mode: extra frames every 250 ms while an effect plays |
| `OFFSCREEN_REFRESH_SEC` | `30` | push mode: refresh interval while another app is shown |
| `STALE_AFTER_SEC` | `90` | push mode: red frame after this long without updates (0 = off) |
| `MIRROR_TOPIC` | `clawd/screen` | where the PNG goes (the mirror workflow has its own) |
| `MIRROR_SOURCE` | `clock` | view mode: `clock` = the mirror workflow reads the clock's screen; `render` = this workflow draws the picture itself ([below](#seeing-the-pet-screen-mirror)) |
| `MIRROR_EVERY_SEC` | `30` | view mode with `MIRROR_SOURCE` `render`: publish at least this often, besides every change (10 - 3600) |
| `CLOCK` | `true` | view mode: `false` runs the pet without any clock - n8n never calls one (no switching to Clawd, no notifications) |
| `STATE_TOPIC` | `clawd/state` | the pet's state, retained; in view mode it must match the clock app's "State topic" |
| `CMD_TOPIC` | `clawd/cmd` | view mode: the clock app's commands; must match its "Command topic" |
| `HA_TOPIC` | `clawd/ha` | Home Assistant's actions: apply and bring Clawd on screen. Not the same as `CMD_TOPIC` |
| `CONFIG_TOPIC` / `CONFIG_SET_TOPIC` | `clawd/config` / `clawd/config/set` | settings in use (retained) / settings changes |

The *(difficulty)* rows are empty in the Settings node: leave them empty to follow `DIFFICULTY`,
or fill one in to override just that value.

If you change a topic, also change it in the MQTT trigger node's topic list (and, for
`CONFIG_TOPIC`, in the mirror workflow).

The clock app (view and device mode) has a few settings of its own in the clock's web UI
(Apps, gear button); see [awtrix/README.md](../awtrix/README.md). The `clawdcore` module (device
mode) has the pet's rules as its settings.

## Difficulty

Five levels, named after Quake III Arena's skill levels:

| | I Can Win | Easy | **Medium** | Hard | Nightmare |
|---|---|---|---|---|---|
| Hungry after (`HUNGER_EMPTY_HOURS`) | 24 h | 18 h | 12 h | 8 h | 4 h |
| Egg hatches after | 10 min | 15 min | 30 min | 45 min | 60 min |
| Child / teen / adult at | 6 / 18 / 36 h | 8 / 24 / 48 h | 12 / 36 / 72 h | 16 / 48 / 96 h | 20 / 60 / 120 h |
| Elder at | 120 h | 144 h | 168 h | 192 h | 216 h |
| Elder lifespan (x1.5 for a happy elder) | 192 h | 144 h | 96 h | 72 h | 56 h |
| Legend after (well-raised hours as a happy elder) | 12 h | 24 h | 48 h | 60 h | 66 h |
| Sickness chance while neglected | 0% | 1% | 2% | 3% | 5% |
| Care for a happy / grumpy adult | 60 / 30 | 100 / 40 | 200 / 60 | 330 / 240 | 960 / 850 |
| Care a happy elder must keep for legend | 180 | 300 | 400 | 550 | 1400 |

- **I Can Win:** never ill, slow hunger, even a player who checks in a few times a day raises it.
- **Easy:** forgiving; a casual player keeps it well.
- **Medium:** the original game's rules at a friendlier speed - the default.
- **Hard:** a pet that goes to bed at 60% hunger wakes up hungry; casual care gives a grumpy adult.
- **Nightmare:** the original Clawd's pace (hungry after ~4 h). Like a newborn: it needs a meal
  about every 1½ hours while awake and a **night feed** - wake it, feed it, put it back to bed -
  or it starves before morning. A player who checks in less than about every hour loses it; only
  one who also feeds at night raises a happy adult, and a legend has to be earned in 66 of a happy
  elder's 84 hours.

**How the numbers were chosen.** Care builds up faster on faster levels (more meals, more
cleaning), so each level's care thresholds follow its own pace. They come from whole lives played
with the real engine by simulated players who only use the normal actions
([`test/balance.test.js`](../test/balance.test.js)). On every level:

- a **caring** player (checks in every 2 h - hourly on Nightmare - feeds below 70%, cleans, gives
  medicine, plays, lets a tired pet nap, checks once more before bed, and on Nightmare gives a
  night feed at 01:00 and 04:00) raises a happy adult, then a legend, which lives to a peaceful
  old age;
- a **normal** and a **grumpy** adult are both reachable by players who still keep the pet alive;
- a legend's hours always fit in a happy elder's life, with less room on each harder level.

Rougher players: at I Can Win a player who checks in every 6 h still gets an old pet (grumpy); from
Medium up, a pet that isn't played with gets unhappy, falls ill and dies young. On Nightmare,
checking in only every 1½ hours loses the pet within two days, and without night feeds even a
player in every half hour stays below a happy adult.

**Feeding at night:** a sleeping Clawd refuses food, so `wake` it, `feed` it and `sleep` it again.
Waking it early (manually) lasts until the next change of the sleep schedule, so put it back to bed
or it stays up.

Values combine in this order, later wins: the difficulty → a value filled in in the Settings node →
a value changed while running. Choosing a difficulty while running (Home Assistant or
`{"DIFFICULTY":"hard"}`) clears earlier live changes to its values, so the preset really applies;
values filled in in the Settings node still win.

## Life stages

Egg → baby → child → teen → **adult** → **elder** (`ELDER_AT_HOURS`) → **legend**. The care score
decides the adult type, and the type decides the rest:

| Adult | Becomes an elder? | Old age | Legend? |
|---|---|---|---|
| **Happy** (care ≥ `CARE_HAPPY`) | yes | `ELDER_LIFE_HOURS` x1.5 | yes, if it stays well raised as an elder |
| **Normal** | yes | `ELDER_LIFE_HOURS` | no |
| **Grumpy** (care ≤ `CARE_GRUMPY`) | no, stays an adult | passes away at `ELDER_AT_HOURS` + half of `ELDER_LIFE_HOURS` | no |

A happy elder that stays well raised - healthy (health 80% or more, not ill) and cared for (care
score at least `CARE_LEGEND`) - for `LEGEND_AFTER_HOURS` becomes a **legend**. Time below that
care level or while unwell doesn't count, but isn't lost either. A legend is golden, and it lives `ELDER_LIFE_HOURS` x1.5 more from
that moment. A legend's egg hatches in half the time and starts with 50 care.

Passing away of old age is peaceful: Clawd is shown as a spirit with a halo instead of the
tombstone, with its own tune, and the NEW EGG? button works as after any death. Neglect still kills
at any age, as in the original.

## Changing settings while it runs

The Settings node gives the defaults. These can also be changed while Clawd runs, and a change
shows up everywhere:

| Setting | Home Assistant | MQTT / webhook | on the clock (view mode) |
|---|---|---|---|
| `PET_NAME`, `SOUND` | ✅ | ✅ | ✅ Clawd's own settings |
| `DIFFICULTY`, `NOTIFY`, `SWITCH_ON_EVENTS`, `MIRROR`, and every *(difficulty)* value above, `SLEEP_FROM/TO`, `NIGHT_FROM/TO`, `TZ` | ✅ | ✅ | - |

- **MQTT:** publish JSON to `clawd/config/set`, e.g. `{"SOUND":true,"HUNGER_EMPTY_HOURS":10}`.
  Each value is checked like the Settings node's; one that would be refused (out of range,
  unknown time zone, a child older than a teen...) is left out. `{"SOUND":null}` goes back to the
  Settings node's value, `{"reset":true}` does that for all of them.
- **Webhook:** the same JSON as `{"config":{...}}`.
- **Always current:** n8n publishes the settings in use, retained, to `clawd/config` after every
  change and as the answer to every settings message, so a Home Assistant control snaps back when
  a value was refused. Changes are kept in the workflow and win over the Settings node until
  cleared.
- **The clock (view mode):** the Clawd app follows n8n's *Sound* and *Pet name*, which n8n sends
  in the state line (fields 25 and 26). n8n never changes the app's own settings: saving an app's
  settings makes AWTRIX restart and recompile it, which a clock short on memory may not survive.
  The other way round works: the app reports its own sound and name when it starts and when n8n
  comes back after a silence, and a value changed in the clock's web UI is taken.
- **Not live, on purpose:** topics, `AWTRIX_HOST`, `MQTT_PREFIX`, `APP_NAME` and the push-mode
  tuning stay in the Settings node: a wrong topic or address set over MQTT would cut n8n off from
  the topic you'd fix it with. The clock's app time and mute are the clock's own settings.

## Home Assistant

The easy way is the one in the README: publish
[`homeassistant/clawd-discovery.json`](../homeassistant/clawd-discovery.json) and add
[`homeassistant/dashboard.yaml`](../homeassistant/dashboard.yaml). The discovery message creates a
**Clawd** device with sensors (stage - egg to legend, next stage and how many hours until it, food,
happiness, energy, hygiene, health, poop, age, care score, generation, asleep, sick), buttons (feed, play, clean, medicine, sleep, wake
up, show stats, new egg), the screen camera and the settings controls (a Difficulty dropdown and
one control per setting). The demo dashboard has two pages: **Clawd** (the pet) and **Settings**
(*Settings* and *Advanced Settings*). The buttons publish to `clawd/ha`,
which n8n answers by doing the action and bringing Clawd on screen.

From a terminal instead of Home Assistant's Developer tools:

```bash
mosquitto_pub -h <broker> -u <user> -P <password> -r \
  -t homeassistant/device/clawd/config -f homeassistant/clawd-discovery.json
```

To remove the device again, publish an empty retained message to the same topic.

Other routes, if you prefer them:

- **Webhook** (push or view): `POST /webhook/clawd-action` with `{"action":"feed"}` (`feed`,
  `play`, `clean`, `med`, `sleep` toggles, `wake`, `stats`, `reset` while dead) or
  `{"config":{...}}`. [`rest_command.yaml`](../homeassistant/rest_command.yaml) and
  [`scripts.yaml`](../homeassistant/scripts.yaml) wire that up (needs a Home Assistant restart);
  [`lovelace-card.yaml`](../homeassistant/lovelace-card.yaml) is a button grid for those scripts.
- **Device mode** (no n8n): [`scripts-device.yaml`](../homeassistant/scripts-device.yaml)
  publishes actions straight to the clock app's command topic. There is no n8n to publish state
  or settings, so sensors, the camera and settings controls stay empty.

## Seeing the pet (screen mirror)

Home Assistant's **Screen** camera shows a picture of the clock while `MIRROR` is on (switch
**Screen mirror** in Home Assistant, or the Settings node). A camera rather than an image entity:
an image entity would add a database row for every frame.

- **Push mode:** every pushed frame is also published as a PNG. Nothing else to install.
- **View mode, picture drawn in n8n** (`MIRROR_SOURCE` = `render`): the view workflow draws the
  pet with the push-mode renderer and publishes it - when something visible changes, right after
  an action, and at least every `MIRROR_EVERY_SEC`. No clock is involved, so this also works with
  `CLOCK` = `false` (the pet lives in Home Assistant only). The picture is one still frame per
  publish: the clock's smooth animation, menus and games only exist on the clock.
- **View mode, the clock's screen** (`MIRROR_SOURCE` = `clock`): the clock draws the pet itself,
  so import [`n8n/clawd-workflow-mirror.json`](../n8n/clawd-workflow-mirror.json) as well: set its MQTT
  credential and the same `AWTRIX_HOST`, `MQTT_PREFIX` and `APP_NAME` as the view workflow, and
  publish it. While Clawd is on screen it reads the clock's screen every 10 s (2 s timeout) and
  publishes it; with another app on screen it reads nothing. It follows the view workflow's
  `MIRROR`. Each read is a request the clock has to answer, so keep its tick at 5 s or more,
  and turn the mirror off if the clock is short on memory. Don't run it next to the push workflow.

## How it works

```
                      ┌──────────────────────┐   background sub-workflow
  schedule tick  ────►│  Settings → Engine   ├──► PUT  /api/v1/apps/pushed/clawd   (push)
  MQTT buttons   ────►│  (rules; the pet's   ├──► PUT  /api/v1/apps/active         (HA, events)
  + app on screen     │   state lives in the ├──► POST /api/v1/audio/play          (SOUND)
  webhook        ────►│   workflow's static  ├──► POST /api/v1/notifications       (NOTIFY)
  clawd/cmd, /ha ────►│   data)              ├──► MQTT clawd/state, clawd/config   (view app, HA)
  clawd/config/set ──►│                      │
                      └──────────────────────┘
```

- [`n8n/clawd-engine.js`](../n8n/clawd-engine.js) holds all the rules and is the only place to
  change them. [`scripts/build.js`](../scripts/build.js) pastes it into the workflows and builds
  `dist/` and the Home Assistant discovery file.
- [`awtrix/clawd-view.ax`](../awtrix/clawd-view.ax) (the clock app) and
  [`awtrix/clawdcore.ax`](../awtrix/clawdcore.ax) (the rules as a clock module) are the readable
  sources of what you install from `dist/`. The state line the app reads is documented in
  [awtrix/README.md](../awtrix/README.md#how-the-pieces-talk).
- n8n loads a workflow's saved state when a run starts and writes it back when it ends, so
  overlapping runs could undo each other. Plain ticks only save when something changed, and all
  HTTP calls to the clock run in a background sub-workflow, so a run that owns the state lasts
  milliseconds.

## Compared with the original and Moepchi's port

The rules are Blueforcer's Clawd v1.1, formula for formula: decay, offline catch-up (30% speed,
at most 12 h), poop, sickness, health and death, care score, growth at 12/36/72 h and the three
adult looks, sleep from 22 to 8 with a manual override, the menu, egg warming, Star Catch (view
and device mode), the tunes and notifications. What differs:

- **Speed:** hunger empties in 12 h instead of ~4 h (Moepchi's port used 6x slower).
- **Turn length:** Clawd follows the clock's app time; the original forced 15 s.
- **Time zone:** a setting (empty: n8n's own) instead of the clock's local time.
- **From Moepchi's port:** the blinking eyes and shut eyes while asleep; in push mode PLAY is an
  instant +1500 happiness (there is no Star Catch); the webhook with `reset` and `wake`.
- **Added here:** view and device mode, difficulty presets, the elder and legend stages and a
  peaceful old age, Home Assistant over MQTT, live settings, the screen mirror, `OFF` on the clock / a red frame when n8n stops, and fixes for sound
  (`/api/v1/audio/play`), stats (`"scroll": true` is rejected by AWTRIX NG), buttons that only act
  while Clawd is on screen, and lost presses.

## Development

```bash
npm run build   # regenerate n8n/*.json, dist/*.ax and homeassistant/clawd-discovery.json
npm test        # engine, workflows, Home Assistant files, and (with BERRY=/path/to/berry) the clock scripts
```

The clock-script tests need a [Berry](https://github.com/berry-lang/berry) interpreter (`make` in
its repo); without one they are skipped. [`test/integration`](../test/integration) runs the
workflows in a real n8n against a fake clock.

## Known limitations

- **Push mode is not real-time:** one frame every 2 s plus bursts during effects, so the menu's
  progress bar jumps. It has no Star Catch, and AWTRIX still toggles the display on a quick
  double press of select, because a pushed app cannot take the button. View mode fixes all three.
- **Overlapping runs:** the window in which two runs can undo each other is milliseconds wide,
  not gone; n8n has no per-workflow lock.
- **Memory:** view mode needs about 24 KB of script memory on the clock, device mode more. On a
  clock without PSRAM running other scripts, install right after a reboot; if it still says
  "out of memory", use push mode.
