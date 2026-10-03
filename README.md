# 🦀 Clawd Hybrid

*A tiny crab. A cry for help. A shortage of RAM.*

Clawd is a virtual pet for your [AWTRIX NG](https://github.com/Blueforcer/awtrix-ng) clock: hatch
it from an egg, feed it, play with it, keep it clean, watch it grow up and grow old, and (if you
neglect it, you monster) bury it.

![Clawd from egg to legend](docs/clawd-stages.png)

Also on the AWTRIX Hub: [Clawd Virtual Pet - Hybrid](https://awtrix.de/flow/6vqhdg62hqfB).

The pet is **Blueforcer**'s original [Clawd](https://awtrix.de/flow/wg0GspJj3sl7), which runs
entirely on the clock. On a clock without extra memory (hello, Ulanzi TC001) it often won't fit
next to your other apps (`ERR:Clawd - out of memory`), so **Moepchi** moved its brain off the
clock into [n8n](https://n8n.io). This version builds on both: the same pet, and you choose how
much of it runs on the clock.

## Pick a mode

| Mode | What runs where | You need | Good to know |
|---|---|---|---|
| **View** ⭐ | the clock draws Clawd, n8n runs the rules | n8n + an MQTT broker | the best experience: smooth animation and the Star Catch mini-game. Uses some memory on the clock |
| **Push** | n8n draws everything and sends pictures to the clock | n8n + an MQTT broker | nothing installed on the clock, so it always fits. Updates every 2 s, no mini-game |
| **Device** | everything on the clock | nothing else | no n8n, no Home Assistant. Needs the most memory on the clock |

Not sure? Try **view mode**. If the clock says "out of memory", use **push mode**.

Home Assistant is optional in every mode.

## Install

The quick path is below. **Every other way** - installing with the n8n and clock APIs, Home
Assistant options, upgrading without losing your pet, switching modes, running without Home
Assistant or MQTT, and clocks short on memory - is in **[docs/INSTALL.md](docs/INSTALL.md)**.

### 1. Prepare the clock (all modes)

- Update to the latest AWTRIX NG.
- If you had the original Clawd installed, delete it (web UI → Apps).
- **View and push mode:** turn on MQTT in the clock's settings (broker address, user, password)
  and note the **prefix** (for example `awtrixNG`).

### 2. Install your mode

**View mode**

1. In n8n: **Create credential → MQTT**, and enter your broker's address, user and password.
2. In n8n: **Import from file** → [`n8n/clawd-workflow-view.json`](n8n/clawd-workflow-view.json).
3. Open every MQTT node (they have a warning triangle) and pick your MQTT credential.
4. Open the **Settings** node and set `AWTRIX_HOST` to your clock's IP address.
5. **Publish** (activate) the workflow.
6. On the clock's web UI: **Scripts → New script**, name it **`clawd`**, paste the contents of
   [`dist/clawd.ax`](dist/clawd.ax) and save.

**Push mode**

1. In n8n: **Create credential → MQTT**, and enter your broker's address, user and password.
2. In n8n: **Import from file** → [`n8n/clawd-workflow.json`](n8n/clawd-workflow.json).
3. Open every MQTT node and pick your MQTT credential.
4. Open the **Settings** node: set `AWTRIX_HOST` to your clock's IP address and `MQTT_PREFIX` to
   your clock's MQTT prefix.
5. **Publish** (activate) the workflow. Clawd shows up as an app within a few seconds.

**Device mode**

1. On the clock's web UI, add [`dist/clawdcore.ax`](dist/clawdcore.ax) as a **module**.
2. Add [`dist/clawd.ax`](dist/clawd.ax) as a **script** named **`clawd`**.
3. Apps → Clawd → gear button: set **Brain** to `device`.

Only run one mode at a time. Settings in n8n only stick once the workflow is published: test runs
from the editor don't keep the pet.

## Play

When Clawd is on screen:

- **Egg:** it hatches after 10 to 60 minutes, depending on the difficulty (30 on Medium); every
  press of **select** warms it and brings that a minute closer.
- **Menu:** press **select** to open it, press again to go to the next item, and wait 2 seconds to
  do it: feed, play, clean, medicine, sleep/wake, stats. Keep the bars at the right full.
- **Play** (view and device mode): a star bounces across the top; press **select** when it's
  right above Clawd. Three tries.
- **Left / right** change apps as usual. Buttons never do anything to Clawd while another app is
  on screen.
- **Dead:** press **select**, press it again for "NEW EGG?", and wait 3 seconds.

Clawd sleeps from 22:00 to 08:00 and needs about four meals a day.

## Growing up

Egg → baby → child → teen → adult → elder, over about a week on Medium. How well you cared for it decides
what kind of adult it becomes, and that decides what comes next:

- **Happy** (well raised): becomes an elder with the longest old age. Keep it healthy and keep
  caring for it well as an elder, and it becomes a golden **legend** - whose egg gets a head start.
- **Normal:** becomes an elder with a normal old age.
- **Grumpy** (neglected): never becomes an elder, and its life is the shortest.

When its time comes Clawd passes away peacefully (a little spirit with a halo), and you start again
with a new egg.

Too easy or too hard? Pick one of five **difficulty** levels, from *I Can Win* to *Nightmare*
(see Settings below).

## Home Assistant (optional, view and push mode)

1. **Add the Clawd device.** In Home Assistant: **Developer tools → Actions**, pick
   **MQTT: Publish** and fill in:
   - **Topic:** `homeassistant/device/clawd/config`
   - **Payload:** the whole contents of
     [`homeassistant/clawd-discovery.json`](homeassistant/clawd-discovery.json)
   - **Retain:** on

   Press **Perform action**. A **Clawd** device appears (Settings → Devices) with its stats,
   buttons (feed, play, clean...) and settings.
2. **Add the dashboard.** **Settings → Dashboards → Add dashboard → New dashboard from scratch**,
   open it, **pencil → ⋮ → Raw configuration editor**, and replace everything with
   [`homeassistant/dashboard.yaml`](homeassistant/dashboard.yaml). It has two pages: **Clawd**
   (the pet, its stats and care buttons) and **Settings**.
3. **Optional, see the pet:** turn on **Screen mirror** on the Settings page. In view
   mode, either set `MIRROR_SOURCE` to `render` in the Settings node (n8n draws the picture, no
   clock needed), or import [`n8n/clawd-workflow-mirror.json`](n8n/clawd-workflow-mirror.json)
   and fill in its MQTT credential and Settings like before (a picture of the clock's screen).

## Settings

Change them in n8n's **Settings** node, or while Clawd runs from the dashboard's **Settings**
page:

- **Settings:** difficulty, name, sound, notifications, whether Clawd jumps on screen for big
  moments, and the screen mirror.
- **Advanced Settings:** everything the difficulty sets (hunger speed, growing-up ages, old age,
  legend, sickness, what counts as a happy or grumpy adult), sleep and night hours, time zone.

| Difficulty | Hungry after | Grows up to adult | Ill when neglected | Old age | Needs you |
|---|---|---|---|---|---|
| I Can Win | 24 h | 1½ days | never | very long | a few times a day |
| Easy | 18 h | 2 days | rarely | long | now and then |
| **Medium** | 12 h | 3 days | sometimes | medium | every few hours |
| Hard | 8 h | 4 days | often | short | every 2 hours |
| Nightmare | 4 h | 5 days | very often | very short | every hour, plus night feeds (wake it, feed it, back to bed) |

On every level a caring player can raise a legend; the numbers are checked by simulating whole
lives (see [docs/REFERENCE.md](docs/REFERENCE.md#difficulty)).

The time zone is n8n's own unless you set one. In view mode, Clawd's name and sound can also be
changed on the clock (Apps → Clawd → gear button).

All settings, and how to change them over MQTT: [docs/REFERENCE.md](docs/REFERENCE.md).

## Troubleshooting

- **Nothing happens:** is the workflow published? Are the MQTT credential and `AWTRIX_HOST`
  right? In n8n, the workflow's **Executions** show errors.
- **Buttons don't work (push mode):** `MQTT_PREFIX` must match the clock's MQTT prefix.
- **"out of memory" or "heap too fragmented" when saving the script:** restart the clock, save it
  the moment the web UI answers, then restart once more
  ([details](docs/INSTALL.md#12-clocks-short-on-memory)). If it still fails, use push mode.
- **`OFF` on the clock (view mode) or a red frame (push mode):** n8n hasn't sent anything for a
  while. Check that n8n is running and the workflow is published.

## More

- [docs/INSTALL.md](docs/INSTALL.md): every mode and every way to install and run it, upgrading,
  switching modes, clocks short on memory.
- [docs/REFERENCE.md](docs/REFERENCE.md): every setting, the difficulty levels and how they were
  balanced, life stages, live settings over MQTT, how it works, what differs from the original,
  development.
- [awtrix/README.md](awtrix/README.md): the clock app, its settings and memory use.

## Credits

The pet — game design, sprite art and the brilliant idea — is **Blueforcer**'s
[Clawd](https://awtrix.de/flow/wg0GspJj3sl7) for AWTRIX NG. **Moepchi** trimmed it down and moved
it off the device into n8n ([clawd-offdevice](https://github.com/Moepchi/clawd-offdevice)). This
version combines the two into a hybrid: the same crab, the same stats, the same tiny pixelated
tombstone if you forget about him, now in whichever mode fits your clock.

Built with an unreasonable amount of debugging assistance from Claude. 🤖
