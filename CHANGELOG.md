# Changelog

The userscript auto-updates from `main`, so an installed copy has no other way
to learn what changed. That is what this file is for.

## 1.0.2

### Fixed

- **A word you typed yourself was not recorded while the oracle was down.**
  `report()` bailed out whenever the oracle had stood down — but standing down
  is exactly what makes the script fall through to asking you, so the line that
  went missing was the `user` one: the only entry in the log that is certain to
  be correct, dropped precisely when it was worth the most.

### Tests

- The suite went from 232 assertions in nine suites to 263 in ten, and from
  41 seconds to 13. Two assertions had been costing 28 of those seconds by
  waiting out the very timeouts they were measuring; both now prove more than
  they did before, in under a second between them.
- Newly covered: printer ids learned from the bot's own prints, the import
  guard against a newer backup format, the oracle log line built from an
  untrusted endpoint, the per-engine dashboard counters, `stopOnUnknown`, the
  `/feedback` field limits, the Ollama prompt contents, and the
  `TEST_WATCHDOG_MS` handling in `run.sh` — whose failure mode is silent, since
  a broken watchdog leaves every suite green.
- Removed or rewritten: assertions that could not fail, one that compared a
  stub to itself, and fixed sleeps around a spawn race that would have blamed
  the server for a slow runner.

## 1.0.1

### Changed

- **The accuracy log now writes one line per word, as soon as the game
  answers.** Each line says which engine produced the reading, what it read, and
  whether the word was accepted — nothing else. The `confirmed` field is gone.
  The "real word" behind a refused reading is only knowable later, sometimes
  never, and carrying it from one word to the next produced three successive
  defects. A line whose engine is `user` and which was accepted *is* the correct
  word, with nothing to reconcile against it.
- Words the glyph dictionary reads on its own are no longer logged: no engine
  was consulted, so there is nothing to measure. Existing log files stay
  readable — the analysis snippet in `ocr-server/README.md` only ever counted
  the engine and the verdict.

### Fixed

- A reading the game refused could be recorded against a **different word, in a
  later hack**, producing a pairing that never happened.
- `TEST_WATCHDOG_MS` with a leading zero either killed the test runner on an
  arithmetic error or was read as octal, silently honouring another number.
  `timeout -k` is now probed before use, for the containers that ship a
  `timeout` without it.
- The oracle's "read something that did not fit" log line is truncated per
  field, not merely capped in count.
- The repository's website link served 139 KB of raw userscript instead of the
  README.

### Documentation

- Corrected four claims that did not match the code: how the suites load the
  userscript, the log prefix for server notifications, which suites the
  in-process watchdog covers, and a dictionary-redundancy figure that no
  measurement supported.

## 1.0.0

First published version.
