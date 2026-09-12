# Local OCR oracle

A small server that the userscript queries **only** when its glyph dictionary and its lexicon
were not enough — a handful of times per session at most. It saves you from typing words by
hand, and therefore from a session stalling while unattended.

No dependencies: `http`, `child_process` and Node's built-in `fetch`.

## Requirements

- **Node >= 18**, for the built-in `fetch` the server uses to talk to Ollama.
- `tesseract` and/or Ollama are optional. With neither, the server still starts and answers
  `word: null`.
- **python3**, only for the accuracy snippet in *Measuring real accuracy* below.

## Cascade

```
dictionary  ->  vocabulary  ->  tesseract  ->  vision model  ->  manual entry
 (instant)      (instant)       (~50 ms)       (~46 ms on GPU)   (last resort)
```

The vision model is only called when tesseract produced nothing trustworthy.

### Tesseract: two readings that must agree

Tesseract reads the image twice, as a line (`--psm 7`) and as a single word (`--psm 8`), and
**a reading is only offered when both modes return the same result**. Measured on 120 real
words rebuilt from the dictionary's glyphs, each with one unknown letter (the situation where
the oracle actually gets called):

> **Where these figures come from.** They are single runs on one machine, not a
> benchmark anyone can reproduce from a clone: the word images belong to a live
> game session and are not in this repository. The table below is over a 120-word
> sample -- small enough that the difference between two draws is sampling noise.
> Treat it as the order of magnitude that justified the design, and use the
> `/feedback` log to measure what actually happens for you.

| strategy | words accepted | correct readings | false accepts |
| --- | --- | --- | --- |
| psm 7 alone | 43.3 % | 90.4 % | 5 |
| psm 8 alone | 53.3 % | 85.9 % | 9 |
| **psm 7 = psm 8 agreement** | **35.0 %** | **95.2 %** | **2** |


Fewer words get accepted, but that is the right trade inside a cascade: a non-answer simply
escalates to the vision model, while a wrong reading costs an attempt **and** prevents the
model from ever being consulted. The real server, queried over HTTP on the same images,
reproduces these figures exactly.

Tesseract on its own, with no pattern constraint, only reads about 46 % of the words
correctly: it confuses `r` with `x`, case (`P`/`p`) and `o` with `0`. What makes it usable is
the constraint of the already-known letters.


The two disagreeing readings are returned in `discarded`, for diagnosis — never in
`readings`, or the userscript, which accepts any reading compatible with the pattern, would
work around the agreement rule.

<details>
<summary><strong>On the newer sample the rule filtered nothing</strong> — two results this
page does not reconcile</summary>

Over the 60 words measured in the next section, psm 7 and psm 8 returned the identical
string on 60 out of 60 — including the 23 where both were wrong together, which agreement
cannot catch. That sits awkwardly next to the 120-word table above, where requiring
agreement cut false accepts from 5 and 9 down to 2.

They are not the same sample. The 60-word images carry one canonical glyph variant per
letter and one blank column between them: a single baseline, no touching letters. A varying
baseline with touching letters is exactly where reading a line and reading a single word
would most plausibly diverge. The rule costs nothing when it is redundant, so it stays —
which picture holds deserves re-measuring on real captures.

</details>

### Vision model: measured

The default is **`glm-ocr`** (0.9 B parameters, 2.2 GB to download, listed by Ollama as
`glm-ocr:latest`), a model purpose-built for text and document recognition. It replaced
`qwen2.5vl`, a 7B-class generalist at 6.0 GB. Head to head on the same 60 word images, one
letter hidden per word, driven through the server's real prompt (bounded length plus hole
pattern) and its real `cleanReading`:

| engine | exact readings | false accepts | median |
| --- | --- | --- | --- |
| **`glm-ocr`** | **59 / 60** | **0** | **46 ms** |
| `qwen2.5vl` | 37 / 60 | - | 711 ms |
| tesseract `--psm 7` | 38 / 60 | 3 | 73 ms |
| tesseract `--psm 8` | 38 / 60 | 3 | 73 ms |


`-` is not zero, it is not recorded in that run. All 59 of glm-ocr's exact readings also
passed the pattern filter, so it offered 59 answers and not one of them was wrong. The two
tesseract modes produced the identical output on every word of this sample — see the note
above.

The single miss reads `dnsSpoof` as `dn`. The length check rejects that, so the word
escalates to asking you instead of burning an attempt: the failure mode the whole cascade is
built around.

While loaded, glm-ocr holds **2.0 GB** of VRAM against 5.5 GB for `qwen2.5vl`. Both ran
entirely on the GPU (RTX 4090 Laptop, 16 GB).

> **How this was measured.** The 60 word images were rebuilt from the author's real glyph
> dictionary, each letter placed at its recorded row, then validated by re-segmenting the
> composed images with an independent implementation and checking that the recovered glyph
> keys matched the source exactly. Two things make the sample easier than reality: one
> canonical glyph variant per letter, so a single baseline, and one blank column between
> letters, so no touching letters. One machine, one run — and the `/feedback` log is still
> the only thing that measures what happens on yours.

### The generation cap

The request carries `num_predict: 24` and `stop: ["\n"]`. Uncapped, glm-ocr takes **15 s**
per word: it produces the answer almost immediately and then keeps going, restating it in
markdown. Capped, the same word comes back in **46 ms**. `cleanReading` recovered the correct
reading in both cases, so nothing was bought with those 15 s — the cost was pure latency, and
24 tokens is already far more than one word needs.


### Latency: measured with `qwen2.5vl`

Everything in this section was measured with `qwen2.5vl`, the **previous** default. It is
kept because what it establishes is the gap between running Ollama on the GPU and on the CPU,
which is a property of the backend rather than of the model. On the same GPU, the current
default `glm-ocr` has a median of **46 ms**.

On images **never sent before** — the real case, since every word in the game arrives as a
previously unseen image:

> Measured once on an RTX 4090 Laptop under Arch Linux with `ollama-cuda`, same images and
> same session for both rows. Your hardware will differ.

| backend | median | min - max | model load |
| --- | --- | --- | --- |
| RTX 4090 Laptop (`ollama-cuda`) | **654 ms** | 607 - 722 ms | 2.4 s cold, 5.1 GB in VRAM |
| CPU (`ollama` alone) | 27 s | up to 28 s | - |


On the same images and in the same session, the GPU is **42 to 45 times faster** and returns
exactly the same readings: it changes the speed, not the accuracy.

Nearly all of that time goes into evaluating the image (~1,130 tokens, ~610 ms); generating
the word itself only takes 12 to 25 ms.


**A trap for anyone benchmarking this**: sending an identical image back only costs about
50 ms, because Ollama reuses its prompt cache. A benchmark that replays the same images
measures that cache and not the model — which is what first produced a misleading 150 ms
median through `/ocr`. Only the first send of a given image counts.

The userscript's deadline stays at 40 s: it is a ceiling, it costs nothing when the answer
arrives in a fraction of a second, and it leaves the model room to answer when Ollama is
running on CPU.

## Running it

```sh
node ocr-server/server.js
```

It prints the engines it detected. With no engine at all it still starts and answers
`word: null` — the userscript then falls back to manual entry.

If Ollama is present, the model is **preloaded at startup** (`keep_alive: 30m`). Without
that, the very first reading would pay for the model load — far longer than the browser's
deadline, so lost before it began.

The model's deadline (`OLLAMA_TIMEOUT`, 45 s) is deliberately decoupled from the
userscript's: the browser may give up before the server has let the model finish — and the
model then stays warm for next time.

## Installing the engines

Arch Linux:

```sh
# tesseract (light, offline)
sudo pacman -S tesseract tesseract-data-eng

# vision model
sudo pacman -S ollama
sudo systemctl enable --now ollama
ollama pull glm-ocr
```

Debian / Ubuntu:

```sh
sudo apt install tesseract-ocr tesseract-ocr-eng

curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull glm-ocr
```

Fedora:

```sh
sudo dnf install tesseract tesseract-langpack-eng

curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull glm-ocr
```

macOS (Homebrew):

```sh
brew install tesseract

brew install ollama
brew services start ollama
ollama pull glm-ocr
```

On Debian, Ubuntu and Fedora the distribution packages for Ollama are often absent or stale,
so the upstream installer is the usual route; it sets up the systemd service itself. On
macOS, the GPU backend is built in and the `ollama-cuda` split below does not apply.

### GPU

Arch's `ollama` package is a **CPU-only build**: it ships no CUDA files at all, and the
service log admits it (`library=cpu`, `total_vram="0 B"`). The GPU backend is a separate
package:

```sh
sudo pacman -S ollama-cuda        # pulls in `cuda`: ~3 GB to download, ~5.7 GB installed
sudo systemctl restart ollama
```

After an update that touches the kernel or the NVIDIA driver, reboot the machine: as long as
the loaded module does not match the installed driver, Ollama will not see the GPU.

To check: the service log (`journalctl -u ollama`) must show `library=CUDA`, and once the
model is loaded, `curl -s 127.0.0.1:11434/api/ps` must show a non-zero `size_vram` — around
2 GB for `glm-ocr`.

A model loaded once with `num_gpu: 0` **stays on CPU** until it is unloaded: an ordinary
request reuses the instance already in memory instead of reloading it onto the GPU. To force
it back:

```sh
curl -s 127.0.0.1:11434/api/generate -d '{"model":"glm-ocr","keep_alive":0}'
```

## Settings (environment variables)

| Variable | Default | Role |
| --- | --- | --- |
| `OCR_PORT` | `8787` | listening port (on `127.0.0.1` only) |
| `OCR_ORIGIN` | `https://s0urce.io` | the only origin allowed; `*` or empty refuses to start |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama instance |
| `OLLAMA_MODEL` | `glm-ocr` | vision model |
| `OLLAMA_TIMEOUT` | `45000` | model deadline, **independent** of the browser's |
| `OCR_CHARSET` | letters + digits | whitelist passed to tesseract |
| `OCR_LOG` | `ocr-server/feedback.jsonl` | accuracy log |

On the userscript side, the address is set in the **Config** tab, under *OCR oracle*.

## Endpoints

- `POST /ocr` — `{image, hint:{pattern, holeWidth, minLength, maxLength}}` ->
  `{word, engine, readings[], discarded[]}`. Each `?` in the pattern stands for one
  unreadable segment, which may hide anywhere from 1 to `holeWidth` touching letters; the
  length is therefore only bounded, not fixed. The older form `{length, pattern}` (one `?` =
  one letter) is still accepted. `pattern` uses `?` for unknown positions. Entries in
  `readings` are `{engine, text, fits}`, entries in `discarded` are `{engine, text}` -- the
  two tesseract modes when they disagree, which the console prints. The image arrives
  **already upscaled x4** by the browser: that is what lets this server do without any image
  library.
- `POST /feedback` — `{engine, reading, word, accepted}` -> one JSONL line, stored as
  `{t, engine, reading, confirmed, accepted}`. The image is not kept. **`word` is the
  confirmed word, not the reading**: after a rejection it is what the player typed instead,
  and that difference is the whole point of the log. A client that sends the reading in both
  fields produces a file in which every line, rejections included, claims the engine was
  right -- which is exactly what this client used to do.
- `GET /health` — `{ok, engines: {tesseract, ollama, model}, model, origin}`. `ollama` only
  says the API answers; `model` says the configured model is **actually pulled**. Without
  that distinction the server declared itself ready while every vision request failed with a
  404. Detection is cached for 10 seconds: probing spawns a process and makes two requests,
  and this endpoint needs no preflight, so without the cache any page could turn it into a
  spawn loop.

## Measuring real accuracy

After a few resolutions:

```sh
python3 - <<'PY'
import json, collections
s = collections.Counter()
for line in open('ocr-server/feedback.jsonl'):
    r = json.loads(line)
    s[(r['engine'], r['accepted'])] += 1
for (engine, ok), n in sorted(s.items()):
    print(f"{engine:12} {'accepted' if ok else 'refused ':8} {n}")
PY
```

This is the only way to know whether tesseract is enough on this font, or whether the vision
model is doing all the work.

## Troubleshooting: the oracle times out

Started from a terminal, the server prints one line per request received, preflights
included:

```
23:33:32  OPTIONS /ocr  204  1 ms  origin=https://s0urce.io
23:33:32  POST /ocr  200  818 ms  word=victimSupport (glm-ocr)
```

**If the userscript reports `oracle timed out` and no line appears**, the request never
reached the server. That is what happened during the first real session: three timeouts, and
no `POST "/api/generate"` in Ollama's log during that time (`journalctl -u ollama` shows
every call to the model). The game page is public and the server is local: the browser may
gate this kind of request behind a local-network access permission, and leave it pending
instead of rejecting it. Check the address bar on s0urce.io for a permission prompt, and
grant it.

The userscript makes this diagnosis itself: on the first timeout it queries `/health` with a
short deadline and writes into the Log which of the three cases applies — server absent
(immediate refusal), browser holding the request (that hangs too), or server reachable and
the model simply slow.

If the lines do appear but are slow, the problem is elsewhere: see the GPU section.

## Security

The server listens on `127.0.0.1` only, but loopback is not private: every page the user
visits can send requests to it. The request path therefore treats its input as hostile.

- **Origin check.** A request whose `Origin` header is present and is not `OCR_ORIGIN` gets
  `403`, before any routing. A request with no `Origin` at all is allowed, so curl, tests and
  other local tools keep working — only a browser sets that header.
- **Refusal to start on a wildcard.** If `OCR_ORIGIN` is `*` or empty, the server prints why
  and exits with status 1 rather than listening. A wildcard would let any site on the
  internet drive it.
- **JSON content type required.** Both POST bodies are refused with `415` unless the
  `content-type` is `application/json`. That is not decoration: it is what forces a browser
  into a preflight, which is what gives the origin check any effect at all. CORS on its own
  would not do it — CORS hides the *response* from a hostile page while letting the request
  run.
- **Concurrency limit.** At most 4 `/ocr` requests run at once, since each one spawns two
  processes. Past that the answer is `503` with `Retry-After: 1`.
- **Abort propagation.** If the client hangs up before the response is written, the tesseract
  children are killed and the Ollama fetch is aborted. Nothing keeps burning CPU for an
  answer nobody will read.
- **Strict image validation.** `image` must be base64 (optionally behind a `data:` prefix),
  must match a base64 character check, must decode, must begin with the PNG magic bytes, and
  must be at most 2 MB once decoded. The body itself is capped at 3 MB on `/ocr` and 4 KB on
  `/feedback`.
- **Bounded hints.** `pattern` is at most 64 characters and may contain at most 8 `?`, and a
  `holeWidth` without a `maxLength` is refused. Each `?` compiles to `.{1,width}`, and on a
  *failing* match the regex engine explores every possible split: measured at width 5, 8
  holes took 7 ms and 12 holes took 5.1 s, growing about fivefold per hole. Node is single
  threaded, so one unbounded match would freeze the whole server. Engine output is truncated
  to 64 characters before being matched, for the same reason.
- **Generic client-facing errors.** Callers only ever see vetted messages — `invalid
  request`, `payload too large`, `busy`, `not found`, `server error`. Anything unexpected is
  logged server-side and never echoed back; an unvetted message once returned a 1.2 MB regex
  source and an absolute path.

Because the game page is served over HTTPS, Chrome may require a *Private Network Access*
preflight: the server answers `Access-Control-Allow-Private-Network: true` on `OPTIONS` only,
since there is no reason to advertise it on every response. If a browser blocks it anyway,
nothing breaks — the userscript falls back to manual entry.

## Known limitations

Deliberately not done, and worth knowing about:

- **No log rotation.** `feedback.jsonl` grows without bound; truncate it yourself.
- **No socket timeouts of our own.** A connection that is opened and then left idle is only
  bounded by Node's defaults.
- **`/health` exposes configuration.** It reports the configured model and the allowed
  origin, so any local process able to reach the port can read them.
- **Log file permissions are the process default.** `feedback.jsonl` is created under
  whatever umask the server runs with; no attempt is made to restrict it.
