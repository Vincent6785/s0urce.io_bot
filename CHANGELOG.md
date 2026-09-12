# Changelog

The userscript auto-updates from `main`, so an installed copy has no other way
to learn what changed. That is what this file is for.

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
