# s0urce.io — Auto Hack userscript

Automates the full s0urce.io gameplay loop: picking a target, opening a port,
reading and typing every word, collecting loot — plus everything a player does
between hacks: mail, season pass, idle agents, gear, the upgrader and the
printer.

## Disclaimer

* Automating s0urce.io almost certainly violates its terms of service.
* Using this risks getting the account banned. Run it on an account you are
  willing to lose.
* The project exists as a technical exercise in protocol reverse-engineering
  and self-training OCR.
* It is not affiliated with, endorsed by, or connected to s0urce.io or its
  operators.

## Install

1. Install Tampermonkey.
2. Open `s0urce-autohack.user.js` → Tampermonkey dashboard → *Utilities* →
   *Import from file*, or just drag the file onto the browser.
3. Load https://s0urce.io/ and log in. **Nothing is drawn on the page** — the
   interface lives in its own window.
4. Press **`F9`** (or `Ctrl+Alt+A`) to open the console, then **START** (or
   `Ctrl+Alt+S` from either window).

The console is a popup, so the browser needs a user gesture to open it — that is
why it is bound to a key rather than opening by itself. If popups are blocked for
s0urce.io the first press does nothing: a warning is printed to the browser
console, and it works once you allow them.

`F9` is the reliable one — it is identical on every keyboard layout. The
`Ctrl+Alt` shortcuts match the letter you actually type, so they work on AZERTY
and QWERTY alike.

**Is it running?** The Tampermonkey badge should show `1`, and the browser
console (F12) prints `[autohack] loaded — F9 …` on every page load. Nothing else
appears until you open the console window: the script deliberately draws nothing
into the game page.

### Requirements

* **A browser with Tampermonkey** — that is the whole requirement for the
  userscript. Nothing to build, nothing to install.
* **Node >= 18** for the test suite and for the optional OCR sidecar: both use
  the built-in `fetch`, which older versions do not have. Zero runtime
  dependencies, CommonJS.
* **The sidecar, tesseract and ollama are all optional.** The userscript works
  without them: with no oracle configured, unreachable or out of readings, an
  unknown word falls back to asking you to type it once — which is also how the
  dictionary learns it.

## The one manual step: teaching the OCR

The server never sends the word as text — it renders it as a PNG, which is the
game's anti-bot measure. The script therefore carries a self-training OCR that
learns one glyph bitmap → one character.

Two ways it fills its dictionary, both automatic in practice:

* **Passively** — while you play by hand, the script watches the real client's
  own `sendWord` frames and pairs the word you typed with the image that was on
  screen, whenever the server accepts it. Play one or two hacks normally and the
  dictionary is largely seeded.
* **On demand** — if the bot meets a glyph it has never seen, it pauses, shows
  the image and asks you to type it once. Typically 3–5 words total; after that
  it never asks again.

If a word ever gets rejected, the script throws away what it believed about that
image and asks you for the real value, so a bad mapping is self-correcting.

### Where the dictionary lives

In the **site's** `localStorage` (`s0urce_bot_glyphs`, `s0urce_bot_words`, plus
`s0urce_bot_prints` and `s0urce_bot_cfg`) — not in the userscript. Editing,
updating or even uninstalling the script leaves it untouched; it belongs to the
`s0urce.io` origin.

What does lose it: clearing the site's data, *forget everything* in the OCR tab,
a private window, another browser or profile — and switching between
`s0urce.io` and `www.s0urce.io`, which are two separate origins with two
separate stores.

### Why it stays fast

The server renders each word slightly differently every time, so the same letter
produces many distinct bitmaps — one real dictionary, the author's own after a
few sessions, held **3214 entries for 44 characters**, 289 of them for `e`
alone, and 98% of those were redundant. Every figure in this section was
measured once, on that one dictionary: it is a sample, not a guaranteed
outcome, and it is not shipped — you train your own.

Three things keep that in check:

* **Indexes built once at load** (never stored): shape → character, and glyph box
  → pre-decoded bitmaps with an ink-count prefilter. Fuzzy lookup went from
  ~6 ms per word to ~0.05 ms, and no longer degrades as the dictionary grows.
* **Redundant variants are not written.** A glyph already recognised comfortably
  — within half the tolerance — is not stored again. On that dictionary that is
  677 entries written instead of 3214. Genuinely new shapes still get learned, which
  is what keeps recognition working on future renders.
* **Writes are coalesced.** Saving used to re-serialise ~144 KB on *every* learned
  word; it now happens at most once every two seconds, and on page unload.

**compact** in the OCR tab prunes what is already there: a greedy cover that keeps
the fewest entries still recognising every one it drops — 3214 → 570 (108 → 20 KB)
on that same dictionary. It is a button rather than an automatism because pruning
lowers the sample density, so an unseen render could in principle fall outside the
kept set and cost you one prompt.

The tolerance itself is deliberately untouched: measured against that same
dictionary, nearest-neighbour matching gets **0% wrong**, and tightening it only
raises the abstention rate — that is, more prompts for no accuracy gain.

### The resolution chain

```
glyph dictionary  ->  lexicon  ->  tesseract  ->  vision model  ->  you
  (instant)          (instant)     (~50 ms)       (~46 ms on GPU)  (dialog)
```

The last two run in a small local server (`ocr-server/`, no dependencies) so the
bot does not stop and wait for a human. Start it with
`node ocr-server/server.js`; the endpoint is configurable under *OCR oracle* in
the Config tab.

Three things keep it safe:

* **A reading is only accepted if it agrees with the letters already known** —
  right length, and no contradiction with a glyph the dictionary is sure of. A
  reading that is also a word seen before wins over one that is not.
* **Nothing an oracle says is written to the dictionary**, for the same reason as
  the lexicon rescue. If the game accepts the word, the normal success path
  learns it; if not, one try is lost and nothing was stored.
* **Every failure falls back to asking you** — server down, HTTP error, timeout,
  or no coherent reading. A *connection* failure makes the oracle stand down for
  the session rather than stall on every word; a *timeout* does not, because a
  vision model loading for the first time outlasts any sensible deadline.
  Touching any `oracle` setting re-arms it. The first timeout also probes
  `/health`, because a closed port refuses instantly: a probe that hangs as well
  means the browser is holding local requests, not that the server is down.

The image is upscaled x4 and flattened onto white **in the browser** before being
sent — the words are only ~12px tall, well under what OCR engines read
comfortably, and doing it here keeps the server free of any image library.

Measured on 60 words with one unknown letter each, the default vision model —
`glm-ocr`, a small model built for text recognition rather than a general-purpose
one — read 59 exactly, and the pattern filter let through **no wrong reading at
all**, at a median of 46 ms per word on an RTX 4090 Laptop (`ollama-cuda`). That
is one run on one machine, on images rebuilt from a real dictionary with no
touching letters, so treat it as the order of magnitude rather than a promise.
The oracle timeout defaults to 40 s so a CPU setup still gets its answer; on a GPU
that ceiling costs nothing. Each engine's accuracy is logged so it keeps being
measured rather than assumed; see `ocr-server/README.md`.

### When a letter is missing

**An unreadable segment is not always one letter.** Serif glyphs can touch, and
the segmenter then sees the `mS` of *victimSupport* as a single blob. In the first
real session every prompt came from this: `victi…upport`, `e…il…mpromised` and
`t…st…p` hid 1, 2 and 3 letters, and none matched the lexicon while each hole was
assumed to be one letter — with holes of 1 to 3 letters, each matched exactly one
word. A hole may now hide up to three letters, for the lexicon and for the oracle
alike; the oracle is given a length range rather than the segment count, which
had made it refuse the right answer for exactly these words.

If only one or two glyphs in a word are unknown and at least three are certain,
the words already seen are used as a lexicon: `expl?it` matches exactly one known
word, so it is read as `exploit` without asking. Ambiguous patterns are never
guessed, and **nothing is written** from such a guess — a new word one letter away
from a known one would otherwise poison the dictionary. If the guess is right the
normal success path learns it; if wrong, it costs one try and nothing more.

**Export / import** in the OCR tab moves it between browsers. Export fills the box
and copies it; import merges into what is already learned rather than replacing
it, and also accepts a backup taken by hand from the console, where each field is
still a raw JSON string. Keys that are not in the current glyph format are
skipped and counted, so a stale backup cannot quietly fill the dictionary with
entries the matcher would never look up.

## The console

`F9` (or `Ctrl+Alt+A`) opens it, `Ctrl+Alt+S` starts and stops the bot. It is a separate
window built and driven from the userscript, so the game page keeps its own
window untouched and nothing of ours is rendered into it.

| Tab | What it shows |
| --- | --- |
| **Dashboard** | The hack in flight — target, port, tries left, progress — with the word image the server sent next to what the OCR made of it, plus the session counters |
| **Charts** | Rolling sparklines: typing WPM, words/min, hacks/hour and OCR hit rate, sampled every 5 s whether or not the console is open |
| **OCR** | Every learned glyph redrawn from what is actually stored, editable in place; the word cache with purge buttons; export / import of the dictionary |
| **Socket** | Live feed of every frame in both directions, filterable and pausable, tagged by who sent it (`bot` or `client`) |
| **Config** | Everything below, generated from one schema |
| **Log** | The run log |

The OCR tab is worth knowing about: one mis-learned glyph silently corrupts every
word containing that letter, and this is where you see and fix it without wiping
the whole dictionary. The bitmaps are decoded straight back out of the stored
keys, so what you see is exactly what the matcher compares against.

## Housekeeping

Between two hacks — never during one — the bot runs a maintenance pass:

| Loop | What it does |
| --- | --- |
| **Mail** | Marks unread mail read and claims any reward attached to it |
| **Season pass** | Claims every tier you have reached that carries a reward open to your account and has not been taken yet |
| **Idle agents** | Claims filament and component loot; shreds the component loot instead when the inventory is full; levels the agents up when affordable |
| **Auto-shred** | Pushes your chosen rarities into the *game's own* auto-shred setting, so the server shreds loot on arrival — the script never drives the shredder itself |
| **Gear** | Equips the best psu/cpu/gpu it can find |
| **Upgrader** | Merges four items of the same type and rarity into one better one |
| **3D printer** | Prints a chosen item, and upgrades the printer |
| **Comment** | Leaves a short message on the profile of someone you just hacked |

Two of these deserve a word.

**Gear cannot be chosen, only measured.** Items carry no combat stat — the client
only ever receives aggregate `player_stats` from `getComputerInfo`. So the bot
equips a candidate, re-reads the stats, keeps the swap if `hackDamage` improved
and moves it straight back if it did not. Two requests per candidate, capped per
pass.

**Auto-shred and the upgrader compete for the same items.** Shredding commons on
arrival means never having four of them to merge. Pick one.

If the script is interrupted mid-merge, items can be left sitting in the
upgrader; it sweeps those back into the inventory when it starts.

**Requests are spaced out by default** (`gap between requests`, 250 ms). Across
real sessions four different events timed out, always at the tail of a burst, and
`getComputerInfo` failed on every startup — the shape of a server that drops
bursts. That reading is a hypothesis, not a certainty: the setting exists so it
can be turned off, and with it at 0 the send path is byte-for-byte the old one.

**Some requests are simply never answered.** Asking to claim a tier with nothing
in it, or to sell from an empty AI market slot, gets no reply at all rather than
an error. During housekeeping such a request gives up after 8 s, and that step
is paused for 5 minutes, doubling up to 30, instead of stalling every pass.
Refusals the server does explain arrive as notifications, which now show in the
Log as `server error: …`.

Equipment and machine slots (`gpu`, `upgrader_*`, `ai_sell`…) are read from the
inventory payload, which is where the game client reads them too — not from
`player_profile`, which only carries avatar, name styling and shelves.

## Settings

| Setting | Meaning |
| --- | --- |
| targets | NPCs only (default), players only, or anything |
| port | which of the 3 ports to attack, or random |
| reroll NPC list | reroll when nothing is attackable |
| WPM | typing speed simulated; the server records it and shows it to your victims |
| human pauses | lognormal keystrokes, hesitations and short breaks |
| typo rate % | deliberate misses, 0 by default — **every miss costs a try** |
| loot | take all / sell all / shred all / leave |
| sell overflow | sell whatever did not fit in the inventory |
| idle agents | claim the filament and component agents when they are full |
| AI market | sell the item you drop in the AI market slot — there is no server offer |
| client chatter | also send the incidental requests the real client makes |
| stop after (min) | auto-stop the session after N minutes (0 = never) |
| gap between requests (ms) | spacing between requests — an experiment, see below; 0 disables |
| stop on unknown glyph | stop instead of asking when the OCR is stuck |
| reload on drop | reload the page when the server drops the connection |
| expose `__autohack` | page-context debug handle, off by default, applies on reload |
| use the local oracle | ask `ocr-server` to read words the dictionary cannot |
| endpoint / timeout | where the oracle lives, and how long to wait before giving up |
| every (seconds) | how often the housekeeping pass runs |
| mail rewards / season pass | claim what is already owed |
| level up agents | spend BTC on agent levels when affordable |
| comment after a win | and the `\|`-separated pool it picks from |
| sync auto-shred + 4 rarities | which rarities the *game* shreds on arrival |
| auto-equip gear / swaps per pass | measured gear swaps, and how many per pass |
| upgrader | merge 4 identical items, spends BTC |
| 3D printer / upgrade printer / item to print | leave the id blank to reuse the last one you printed by hand |

Adding a setting means one entry in `SCHEMA` — the Config tab and its bindings
are generated from it.

## Blending in

Three things separate a bot from a player on the wire, and the script addresses
each:

* **Ack ids.** socket.io numbers every request 0, 1, 2… A script that allocates
  from its own private range is trivially separable server-side, so this one
  tracks the highest id the real client has used and continues that sequence. If
  the client later reuses an id while one of ours is still in flight, ours is
  re-issued under a fresh id so the two answers can never be confused.
* **Timing.** Keystroke intervals are drawn from a lognormal around the
  configured WPM rather than a flat jitter, with a reaction delay when a new word
  appears, occasional mid-word hesitations, and the odd short break between
  hacks. `typo rate` optionally adds real misses — off by default, because a miss
  costs a try.
* **Traffic shape.** With *client chatter* on, the bot also sends the side
  requests the real client makes at the same moments: a target-list refresh after
  a hack ends, `getInventory` after looting, `checkAnySeasonRewardsToClaim` on a
  season level-up push, and an occasional `getComputerInfo`.

Keep WPM plausible — the server records it and shows it to your victims.

## Notes

* The bot talks to the server on the same socket.io channel as the real client,
  so the game's own windows (BTC, inventory, terminal) are **not** kept in sync
  while it runs. Reload to resync the display. Don't play manually at the same
  time.
* **Disconnects end the session.** s0urce's own handler says "please refresh",
  so rather than spinning against a dead session the script stops the bot, drops
  every in-flight request and tells you to reload. *reload on drop* automates
  that.
* It needs the websocket transport. socket.io establishes the session over HTTP
  polling and only upgrades to a websocket a moment later — so the socket.io
  CONNECT packet travels over XHR and never appears on the socket at all. The
  script therefore treats the socket as live once it sees the engine.io upgrade
  (or any message frame), not on CONNECT. Until then the console header reads
  `handshaking` and START is refused with an explicit reason. There is no
  HTTP-polling fallback.
* The script leaves **nothing on the game page**: no elements, and no global
  unless you turn on *expose `__autohack`* in the Config tab. The one exception
  is the OCR training prompt, which falls back to a dialog over the game if it
  needs a word while the console is shut — better than stalling the run.
* Closing the game tab or reloading closes the console with it, since it would
  otherwise be left holding references into a dead javascript context.

## Tests

    ./test/run.sh

**219 assertions over nine suites** on a fresh clone, **227** when the optional
`bck` dictionary fixture is present — the eight extra ones live in
`ocr_perf_test.js` and are skipped without it. Exit code 0 either way, with no
browser, no tesseract, no ollama and no network:

* `ocr_test.js` — segmentation, learn/recognise round-trip, unseen letter
  combinations, baseline anchoring, word-cache fallback, noise tolerance, forget,
  and the backup round-trip including malformed and stale-format input.
* `frame_test.js` — the socket.io codec: pings, handshakes, namespaces, ack id 0,
  binary attachments, malformed payloads.
* `integration_test.js` — the bot against a mock socket: ack sequencing and
  collision re-issue, refusing to emit before the handshake, disconnect cleanup,
  a full attack → words → victory → loot run, the misread-word recovery path,
  loop-overlap guard, the timing/typo models, every console tab rendering,
  training-prompt routing, config schema integrity, ring-buffer caps, and a
  guard that word images never reach the socket trace.
* `loops_test.js` — every housekeeping loop against a scriptable mock server:
  agent claiming, mail, season-pass eligibility, the upgrader's move sequence and
  its refusals, gear kept vs reverted, auto-shred deltas, stranded-item recovery,
  balance projection, printer-id learning, and a guard that housekeeping never
  interleaves with a hack.
* `ocr_perf_test.js` — the write rule, coalesced saves, compaction (every
  dropped entry must still be recognised) and the vocabulary rescue. If `bck` is
  present it additionally replays the pre-index scan side by side with the
  indexed one over ~1600 cases sampled from that dictionary and requires
  identical answers, then compacts and round-trips the real data. `bck` is the
  author's own exported dictionary: it is gitignored and deliberately not
  published, since everyone trains their own — so on a fresh clone that case
  count is zero and these eight assertions do not run.
* `oracle_test.js` — the oracle cascade (accepted, wrong length, contradicted
  letter, lexicon preference), that nothing is learned from a reading, that every
  failure mode falls back to the dialog, the x4 upscale, and the server itself
  over real HTTP: CORS/PNA preflight, well-formed JSON with no engine installed,
  malformed body, and the feedback log.
* `oracle_server_test.js` — the server's tesseract policy against a deterministic
  fake binary (`test/fakebin/tesseract`): a reading is offered only when psm 7 and
  psm 8 agree, a lone mode never reaches `readings` even when it fits, and model
  presence is told apart from the Ollama API merely answering.
* `config_migration_test.js` — a stored copy of the old 6 s oracle timeout is
  migrated to the measured-safe default, while a value picked on purpose is kept.
* `debug_gate_test.js` — a pristine config leaves no global on the page.

The oracle suites never touch the engines installed on the machine: Ollama is
pointed at a dead port and `tesseract` at the fake binary. Before that isolation,
installing Ollama for real was enough to break them.

The suites read the userscript directly through `test/extract.js`, so they can
never run against a stale copy — an earlier generated-module step did exactly
that once, and passed while testing old code.

A suite that hangs is killed by a watchdog after 180 s, which names the suite
instead of holding the runner until some outer timeout. `TEST_WATCHDOG_MS`
overrides that value (defined in `test/env.js`).

## Known limitations

* **Touching letters are resolved, never learned.** A blob hiding two or three
  characters is read at lookup time by the lexicon or the oracle, but `learn`
  only writes glyphs when the segment count equals the word length — so those
  letters never enter the dictionary, and the same blob is resolved again from
  scratch the next time it appears.
* **The OCR sidecar is a development tool, not a service.** No log rotation:
  the feedback log grows without bound. No socket timeouts. `/health` echoes
  its own configuration back — engines, model name, allowed origin — to anything
  the origin check lets through. The feedback log is written with default file
  permissions.

Two protocol details are also still unconfirmed. Both are harmless if wrong,
and both resolve on a real run:

* `changeAutoShredSetting` is not acked, and the meaning of its `value` field is
  ambiguous in the minified client. The script sends deltas only and logs them as
  *requested*; the true state shows up in the next `initPlayer` push, so a reload
  confirms it.
* Empty inventory slots are padded client-side with `generatedSlotN` keys. The
  script uses them as `moveItem` destinations the same way the game does, but
  whether the server names them identically is not visible from the bundle.

## Licence

MIT — see [`LICENSE`](LICENSE).
