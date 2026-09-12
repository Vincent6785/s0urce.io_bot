#!/usr/bin/env node
/*
 * Local OCR oracle for the s0urce.io autohack userscript.
 *
 * The userscript asks this server to read a word image only when its own glyph
 * dictionary and lexicon both come up short — a handful of times per session at
 * most. Two engines are tried in order of cost:
 *
 *   1. tesseract  (~50 ms)   run twice, as a line (psm 7) and as a single word
 *      (psm 8); a reading is only offered when both modes agree
 *   2. a vision model via Ollama, only if tesseract produced nothing that fits
 *      the hint (measured: ~0.7 s on a GPU, ~27 s on CPU)
 *
 * No dependencies: http + child_process + the built-in fetch. The image arrives
 * already upscaled from the browser, which is what keeps this file free of any
 * image library.
 *
 * Threat model: this listens on loopback, but "loopback" is not "private".
 * Every page the user visits can send it requests, so the request path treats
 * its input as hostile — origin and content type are checked, the body and the
 * decoded image are capped, the hint is bounded before it reaches a regex,
 * concurrency is limited, and errors never echo internals back to the caller.
 */

'use strict';

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.OCR_PORT || 8787);
const HOST = '127.0.0.1';                       // never expose this to a network
// Unset means "use the default"; explicitly empty is a mistake and must not
// quietly become the default, or the guard in start() can never see it.
const ORIGIN = process.env.OCR_ORIGIN === undefined
  ? 'https://s0urce.io' : process.env.OCR_ORIGIN;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
// Measured on 60 words rebuilt from a real glyph dictionary: glm-ocr reads
// 59/60 with no false accept at ~46 ms, against 37/60 at ~711 ms for the
// general-purpose qwen2.5vl and 38/60 at ~73 ms for tesseract. It is also
// 2.2 GB against 6 GB. A model trained for text recognition beats a larger
// generalist here because the task is narrow: one word, one line.
const MODEL = process.env.OLLAMA_MODEL || 'glm-ocr';
const LOGFILE = process.env.OCR_LOG || path.join(__dirname, 'feedback.jsonl');
const CHARSET = process.env.OCR_CHARSET ||
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// The client's patience and the model's warm-up are different things: a vision
// model loading for the first time outlasts any sensible browser deadline.
const OLLAMA_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT || 45000);

// Limits. Every one of these exists because the value it caps comes from a
// caller we do not control.
const MAX_OCR_BODY = 3 << 20;        // an upscaled word image is ~30 KB
const MAX_FEEDBACK_BODY = 4 << 10;
const MAX_IMAGE_BYTES = 2 << 20;
const MAX_PATTERN = 64;              // see holeRegex: the cost is exponential
const MAX_HOLES = 8;
const MAX_READING = 64;              // engine output feeds the regex
const MAX_CONCURRENT = 4;            // each /ocr spawns two processes
const HEALTH_CACHE_MS = 10000;

// `ollama` only says the API answers; `model` says the configured model is
// actually pulled. Without the second, /health reported "present" while every
// vision request came back 404.
const engines = { tesseract: false, ollama: false, model: false };

// "glm-ocr" is listed by Ollama as "glm-ocr:latest"; an explicit tag must
// match exactly.
function modelListed(models, wanted) {
  if (!Array.isArray(models)) return false;
  const hasTag = wanted.indexOf(':') !== -1;
  return models.some(m => {
    const name = String((m && (m.name || m.model)) || '');
    return hasTag ? name === wanted : (name === wanted || name.split(':')[0] === wanted);
  });
}

/* ------------------------------------------------------------------ utils */

// Errors carrying `safe` are the only ones whose message reaches the client.
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  e.safe = true;
  return e;
}

// Goes into `-c tessedit_char_whitelist=`. execFile spawns without a shell so
// there is nothing to inject, but a stray '=' or newline confuses tesseract.
function sanitizeCharset(cs) {
  if (typeof cs !== 'string') return null;
  const clean = cs.replace(/[^A-Za-z0-9]/g, '');
  return clean.length ? clean.slice(0, 256) : null;
}

function cleanReading(raw) {
  if (!raw) return null;
  // engines like to add quotes, periods and commentary; keep the first run of
  // word characters. Capped: this string is matched against holeRegex, whose
  // cost grows with the text length.
  const m = String(raw).match(/[A-Za-z0-9]+/);
  return m ? m[0].slice(0, MAX_READING) : null;
}

// '?' -> 1..width characters, everything else literal.
//
// Each '?' makes the expression ambiguous, and on a FAILING match the engine
// explores every split: measured at width 5, 8 holes took 7 ms, 12 holes took
// 5.1 s, and it grows ~5x per hole. Node is single threaded, so one such match
// freezes the whole server — hence the hard caps in checkHint, which is the
// only path that builds one of these.
function holeRegex(pattern, width) {
  let src = '^';
  for (const ch of pattern) {
    src += ch === '?' ? `.{1,${width}}` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(src + '$');
}

function holeWidthOf(hint) {
  return Math.max(1, Math.min(5, Number(hint.holeWidth) || 1));
}

// Rejects a hint before it can reach holeRegex. Throws a safe error.
function checkHint(hint) {
  if (hint === undefined || hint === null) return null;
  if (typeof hint !== 'object' || Array.isArray(hint)) throw fail(400, 'invalid request');

  if (hint.pattern !== undefined) {
    if (typeof hint.pattern !== 'string' || hint.pattern.length > MAX_PATTERN) {
      throw fail(400, 'invalid request');
    }
    if ((hint.pattern.match(/\?/g) || []).length > MAX_HOLES) {
      throw fail(400, 'invalid request');
    }
  }
  // Variable-width holes are only affordable with an upper bound on the text,
  // so that lengths are filtered before the regex ever runs.
  if (hint.holeWidth && !hint.maxLength) throw fail(400, 'invalid request');
  return hint;
}

// Does a reading agree with what the dictionary already knows? `pattern` uses
// '?' for the segments the userscript could not read. With `holeWidth`, a '?'
// may hide several touching letters and the length is only bounded; without
// it, the older exact semantics apply (one '?' = one character).
function fits(text, hint) {
  if (!text) return false;
  if (!hint) return true;
  if (hint.holeWidth) {
    if (hint.minLength && text.length < hint.minLength) return false;
    if (hint.maxLength && text.length > hint.maxLength) return false;
    if (!hint.pattern) return true;
    // Length is checked first on purpose: a text that cannot fit never reaches
    // the ambiguous part of the expression.
    return holeRegex(String(hint.pattern), holeWidthOf(hint)).test(text);
  }
  if (hint.length && text.length !== hint.length) return false;
  const p = hint.pattern || '';
  for (let i = 0; i < p.length && i < text.length; i++) {
    if (p[i] !== '?' && p[i] !== text[i]) return false;
  }
  return true;
}

// Strict: the bytes go straight into an image parser, so anything that is not
// plainly a PNG of a sane size is refused here rather than there.
function decodeImage(image) {
  if (typeof image !== 'string' || !image) return null;
  const comma = image.indexOf(',');
  const b64 = image.startsWith('data:') ? image.slice(comma + 1) : image;
  if (!/^[A-Za-z0-9+/\s]+={0,2}$/.test(b64)) return null;
  if (b64.length > MAX_IMAGE_BYTES * 1.4) return null;
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { return null; }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG)) return null;
  return { buf, b64 };
}

/* ---------------------------------------------------------------- engines */

function runTesseract(buf, charset, psm = 7, signal) {
  return new Promise(resolve => {
    const args = ['stdin', 'stdout', '--psm', String(psm)];
    if (charset) args.push('-c', 'tessedit_char_whitelist=' + charset);
    let child;
    try {
      child = execFile('tesseract', args, { timeout: 8000, maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? null : cleanReading(stdout)));
    } catch (e) { return resolve(null); }
    child.on('error', () => resolve(null));       // tesseract not installed
    // A client that hangs up must not leave processes running.
    if (signal) signal.addEventListener('abort', () => { try { child.kill(); } catch (e) {} });
    if (!child.stdin) return resolve(null);
    child.stdin.on('error', () => {});
    child.stdin.end(buf);
  });
}

async function runOllama(b64, hint, signal) {
  let prompt = 'This image contains exactly one word rendered in a serif font. ' +
    'Reply with that word and nothing else — no quotes, no punctuation, no explanation.';
  if (hint && hint.holeWidth) {
    if (hint.minLength && hint.maxLength) {
      prompt += ` The word is between ${hint.minLength} and ${hint.maxLength} characters long.`;
    }
    if (hint.pattern && hint.pattern.indexOf('?') !== -1) {
      prompt += ` Letters already identified, where each ? stands for one to ` +
        `${holeWidthOf(hint)} unknown letters: ${hint.pattern}.`;
    }
  } else {
    if (hint && hint.length) prompt += ` The word is ${hint.length} characters long.`;
    if (hint && hint.pattern && hint.pattern.indexOf('?') !== -1) {
      prompt += ` Characters already identified, with ? for the unknown ones: ${hint.pattern}.`;
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OLLAMA_TIMEOUT);
  if (signal) signal.addEventListener('abort', () => ctl.abort());
  try {
    const r = await fetch(OLLAMA + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODEL, prompt, images: [b64], stream: false,
        // The answer is one word, so cap the generation. Without this an OCR
        // model trained on documents keeps producing structure: measured at
        // 15 s per word, repeating the answer in markdown, against 46 ms once
        // capped. cleanReading salvages the right word either way, so the cost
        // was pure latency -- which is exactly what makes it easy to miss.
        options: { temperature: 0, num_predict: 24, stop: ['\n'] }
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return cleanReading(j && j.response);
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

/* -------------------------------------------------------------- http glue */

// An Origin header is only sent by a browser. Its absence means curl, a test,
// or another local tool; its presence and mismatch means a page we did not
// invite. CORS alone would not help: it hides the *response* from a hostile
// page while letting the request run.
function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === ORIGIN;
}

function cors(req, res) {
  if (!originAllowed(req)) return;
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    // Chrome's Private Network Access preflight: an https page reaching a local
    // address is refused without this, even though 127.0.0.1 is a trustworthy
    // origin and mixed content does not apply. Preflight only — there is no
    // reason to advertise it on every response.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

// One line per request, preflight included, when the server is started from a
// terminal. It is the only way to tell "the browser never reached us" from "we
// were slow". Silent when the test suites require the module.
const VERBOSE = require.main === module;

function logRequest(req, res, started) {
  if (!VERBOSE) return;
  const o = res.ocrResult;
  const extra = o ? `  word=${o.word || '-'}${o.engine ? ' (' + o.engine + ')' : ''}` : '';
  const origin = req.headers.origin ? `  origin=${req.headers.origin}` : '';
  console.log(`${new Date().toTimeString().slice(0, 8)}  ${req.method} ${req.url}  ` +
              `${res.statusCode}  ${Date.now() - started} ms${extra}${origin}`);
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

// A JSON content type is not decoration: it is what forces a browser to send a
// preflight, which is what lets the origin check above have any effect at all.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return reject(fail(415, 'invalid request'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      // Pause rather than destroy: destroying here races the response, and the
      // caller then sees a connection reset instead of the 413 that explains
      // it. The socket is closed by the error path, once the status is sent.
      if (size > limit) { chunks.length = 0; req.pause(); reject(fail(413, 'payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(fail(400, 'invalid request')); }
    });
    req.on('error', () => reject(fail(400, 'invalid request')));
  });
}

/* ------------------------------------------------------------------ routes */

async function handleOcr(body, signal) {
  const img = decodeImage(body.image);
  if (!img) throw fail(400, 'invalid request');
  const hint = checkHint(body.hint);
  const readings = [];

  // Measured on 120 words rebuilt from real glyphs, one letter unknown: psm 7
  // alone accepts 43% of words and 90% of those are right; requiring psm 7 and
  // psm 8 to agree accepts 35% but 95% are right, and false accepts drop from
  // 5 to 2. Behind a vision model that trade is the right one — a non-answer
  // just escalates, while a wrong answer burns a try and skips the model.
  const charset = sanitizeCharset(body.charset) || CHARSET;
  const [line, word] = await Promise.all([
    runTesseract(img.buf, charset, 7, signal),
    runTesseract(img.buf, charset, 8, signal)
  ]);
  const discarded = [];
  if (line && line === word) {
    readings.push({ engine: 'tesseract', text: line, fits: fits(line, hint) });
  } else {
    // Kept out of `readings` on purpose: the client accepts any reading that
    // fits the pattern, so a lone mode would slip past the agreement rule.
    if (line) discarded.push({ engine: 'tesseract-psm7', text: line });
    if (word) discarded.push({ engine: 'tesseract-psm8', text: word });
  }

  // only pay for the model if the cheap engine did not produce something usable
  if (!readings.some(r => r.fits) && !(signal && signal.aborted)) {
    const o = await runOllama(img.b64, hint, signal);
    if (o) readings.push({ engine: MODEL, text: o, fits: fits(o, hint) });
  }

  const best = readings.find(r => r.fits) || null;
  return { word: best ? best.text : null, engine: best ? best.engine : null,
           readings, discarded };
}

function handleFeedback(body) {
  // The image is not stored — the reading and the confirmed word are all that is
  // needed to measure each engine's accuracy.
  const field = v => (v === undefined || v === null ? null : String(v).slice(0, 64));
  const line = JSON.stringify({
    t: new Date().toISOString(),
    engine: field(body.engine),
    reading: field(body.reading),
    confirmed: field(body.word),
    accepted: !!body.accepted
  });
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch (e) { return { ok: false }; }
  return { ok: true };
}

// Probing the engines spawns a process and makes two requests. /health needs no
// preflight, so without this cache any page could turn it into a spawn loop.
let healthCheckedAt = 0;
async function cachedDetect() {
  if (Date.now() - healthCheckedAt < HEALTH_CACHE_MS) return;
  healthCheckedAt = Date.now();
  await detectEngines();
}

let inFlight = 0;

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => logRequest(req, res, started));
  cors(req, res);

  if (!originAllowed(req)) return send(res, 403, { error: 'forbidden' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = (req.url || '').split('?')[0];
  try {
    if (req.method === 'GET' && url === '/health') {
      await cachedDetect();
      return send(res, 200, { ok: true, engines, model: MODEL, origin: ORIGIN });
    }
    if (req.method === 'POST' && url === '/ocr') {
      if (inFlight >= MAX_CONCURRENT) {
        res.setHeader('Retry-After', '1');
        return send(res, 503, { error: 'busy' });
      }
      // Count from arrival, not from the end of the upload. Incrementing after
      // readBody made the gate above useless: every request passed it while the
      // counter was still zero, because no body had finished arriving yet.
      inFlight++;
      try {
        const ctl = new AbortController();
        // Nothing useful survives a client that hung up: stop the engines.
        // This listens on the response, not the request: a fully received
        // request has already emitted 'close' by the time readBody resolves,
        // so a listener attached there fires never. The response stays open
        // until we answer, which is exactly the window we care about.
        res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
        const body = await readBody(req, MAX_OCR_BODY);
        const out = await handleOcr(body, ctl.signal);
        res.ocrResult = out;
        return send(res, 200, out);
      } finally { inFlight--; }
    }
    if (req.method === 'POST' && url === '/feedback') {
      return send(res, 200, handleFeedback(await readBody(req, MAX_FEEDBACK_BODY)));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    // Only vetted messages go out. An unvetted one has already leaked a 1.2 MB
    // regex source and an absolute path in testing.
    if (!e || !e.safe) console.error('[ocr] unexpected error:', e);
    if (res.writableEnded || !res.writable) return;
    // A refused upload is still arriving. Answer first, then hang up, so the
    // rest of the body is never read and the caller still gets its status.
    if (e && e.status === 413) {
      res.setHeader('connection', 'close');
      res.on('finish', () => req.destroy());
    }
    return send(res, (e && e.safe && e.status) || 500,
                { error: (e && e.safe && e.message) || 'server error' });
  }
});

/* ------------------------------------------------------------------ start */

async function detectEngines() {
  engines.tesseract = await new Promise(r => {
    let c;
    try { c = execFile('tesseract', ['--version'], { timeout: 4000 }, err => r(!err)); }
    catch (e) { return r(false); }
    c.on('error', () => r(false));
  });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(OLLAMA + '/api/tags', { signal: ctl.signal });
    clearTimeout(t);
    engines.ollama = r.ok;
    engines.model = r.ok ? modelListed((await r.json()).models, MODEL) : false;
  } catch (e) {
    engines.ollama = false;
    engines.model = false;
  }
}

// Ollama loads a model on first use, which can take far longer than any request
// deadline. Touching it at startup means the first word the oracle sees is
// answered by an already-resident model.
async function warmOllama() {
  if (!engines.ollama || !engines.model) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), OLLAMA_TIMEOUT);
    const r = await fetch(OLLAMA + '/api/generate', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: '30m' })
    });
    clearTimeout(timer);
    return r.ok;
  } catch (e) { return false; }
}

// The loopback guarantee lives here. `server` is exported for the test suites,
// which bind an ephemeral port explicitly; everything else should use start().
function start(port = PORT) {
  if (!ORIGIN || ORIGIN === '*') {
    console.error('OCR_ORIGIN must be an exact origin, never "*" or empty: ' +
                  'a wildcard would let any site on the internet drive this server.');
    process.exit(1);
  }
  server.on('error', err => {
    console.error(err && err.code === 'EADDRINUSE'
      ? `port ${port} is already in use — set OCR_PORT to another one`
      : `could not start: ${err && err.message}`);
    process.exit(1);
  });
  return server.listen(port, HOST, () => {
    console.log(`autohack OCR oracle  http://${HOST}:${port}`);
    console.log(`  allowed origin   : ${ORIGIN}`);
    console.log(`  tesseract        : ${engines.tesseract ? 'present' : 'MISSING'}`);
    console.log(`  ollama           : ${engines.ollama ? 'present' : 'MISSING'}`);
    console.log(`  model ${MODEL} : ${engines.model ? 'pulled'
      : (engines.ollama ? `NOT PULLED  (ollama pull ${MODEL})` : '-')}`);
    console.log('  one line below per request received\n');
    if (!engines.tesseract && !engines.ollama) {
      console.log('  no engine available — the server will answer word:null');
      console.log('  and the userscript will fall back to asking you.\n');
    } else if (engines.model) {
      console.log('  warming the model up...');
      warmOllama().then(ok => console.log(`  model ${ok ? 'loaded' : 'not warmed'}`));
    }
  });
}

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`OCR_PORT must be a port number between 1 and 65535, got "${process.env.OCR_PORT}"`);
    process.exit(1);
  }
  detectEngines().then(() => start(PORT));
}

module.exports = { server, start, fits, handleOcr, detectEngines,
                   sanitizeCharset, warmOllama, runTesseract, modelListed, engines };
