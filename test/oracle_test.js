// The local OCR oracle: the client cascade in the userscript, and the server.
const { MockWS } = require('./env.js');
const fs = require('fs'), path = require('path'), os = require('os');
eval(fs.readFileSync(path.join(__dirname, '..', 's0urce-autohack.user.js'), 'utf8'));

const A = window.__autohack;
const { oracle, ocr, cfg, bot } = A;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name +
              (cond || extra === undefined ? '' : `\n      ${extra}`));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('unhandledRejection', e => console.log('UNHANDLED: ' + e.message));

const realFetch = global.fetch;

(async () => {
  cfg.oracleEnabled = true;
  cfg.oracleTimeoutMs = 800;
  // the canvas work is covered separately; keep it out of the cascade tests
  let sentPayload = null;
  ocr.upscaledPng = async () => 'data:image/png;base64,AAAA';

  const rec = { segments: new Array(7), partial: 'expl…it' };
  const reply = readings => {
    global.fetch = async (url, init) => {
      sentPayload = JSON.parse(init.body);
      return { ok: true, json: async () => ({ readings }) };
    };
  };

  // --- 1. a reading that agrees with the known letters is accepted ---------
  oracle.reset();
  reply([{ engine: 'tesseract', text: 'exploit' }]);
  let got = await oracle.ask('data:,', rec, false);
  check('a reading that agrees with the known letters is accepted', got && got.text === 'exploit', JSON.stringify(got));
  check('the pattern is sent as bounds, not an exact length',
        sentPayload && sentPayload.hint.pattern === 'expl?it' && sentPayload.hint.holeWidth === 3 &&
        sentPayload.hint.minLength === 7 && sentPayload.hint.maxLength === 9 &&
        sentPayload.hint.length === undefined,
        JSON.stringify(sentPayload && sentPayload.hint));

  // --- 2. inconsistent readings are refused --------------------------------
  // 'explicit' now fits expl?it (the hole hides "ic"); ten letters cannot.
  reply([{ engine: 'tesseract', text: 'explaaaait' }]);
  got = await oracle.ask('data:,', rec, false);
  check('a reading longer than the holes allow is refused', got === null,
        JSON.stringify(got));

  // Regression from a real session: 12 segments but 13 letters, because "mS"
  // touch. The right answer used to be refused on length.
  reply([{ engine: 'vision', text: 'victimSupport' }]);
  got = await oracle.ask('data:,', { segments: new Array(12), partial: 'victi…upport' }, false);
  check('touching letters: the right 13-letter reading passes for 12 segments',
        got && got.text === 'victimSupport', JSON.stringify(got));

  reply([{ engine: 'tesseract', text: 'expzoit' }]);               // contradicts 'l'
  got = await oracle.ask('data:,', rec, false);
  check('a reading that contradicts a known letter is refused', got === null, JSON.stringify(got));

  // --- 3. a known word wins over an equally valid unknown one --------------
  ocr.words = { h1: 'exploit' }; ocr.index = null;
  reply([{ engine: 'tesseract', text: 'explzit' }, { engine: 'vision', text: 'exploit' }]);
  got = await oracle.ask('data:,', rec, false);
  check('a word from the lexicon is preferred', got && got.text === 'exploit', JSON.stringify(got));

  // --- 4. after a misread, our own pattern is not imposed ------------------
  reply([{ engine: 'vision', text: 'anything' }]);
  await oracle.ask('data:,', { segments: new Array(8), partial: 'wrongway' }, true);
  check('after a misread the pattern is neutral',
        sentPayload.hint.pattern === '????????', sentPayload.hint.pattern);

  // --- 5. nothing is learned from an oracle reading ------------------------
  ocr.glyphs = {}; ocr.index = null;
  reply([{ engine: 'tesseract', text: 'exploit' }]);
  await oracle.ask('data:,', rec, false);
  check('an oracle reading writes nothing to the dictionary',
        Object.keys(ocr.glyphs).length === 0);

  // --- 6. every failure mode falls back instead of throwing ----------------
  oracle.reset();
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  got = await oracle.ask('data:,', rec, false);
  check('unreachable server -> null', got === null);
  check('and the oracle stands down', oracle.offline === true);
  got = await oracle.ask('data:,', rec, false);
  check('while stood down it does not retry', got === null);
  oracle.reset();

  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  got = await oracle.ask('data:,', rec, false);
  check('HTTP 500 -> null', got === null);

  oracle.reset();
  global.fetch = (url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => rej(new Error('aborted')));
  });
  const t0 = Date.now();
  got = await oracle.ask('data:,', rec, false);
  check('a timeout -> null', got === null);
  check('and the deadline is actually enforced', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  oracle.reset();

  // --- 7. the whole chain still reaches the prompt -------------------------
  global.fetch = async () => { throw new Error('down'); };
  oracle.reset();
  ocr.recognize = async () => ({ word: null, partial: 'ab…', segments: new Array(3) });
  ocr.learn = async () => {};          // no real image to decode in this harness
  let asked = 0;
  A.ui.askWord = async () => { asked++; return 'abc'; };
  bot.running = true;
  const word = await bot.resolveWord('data:,', false);
  check('with no oracle, it falls back to the prompt', asked === 1 && word === 'abc',
        `asked=${asked} word=${word}`);
  oracle.reset();

  // --- 8. the image really is upscaled 4x ---------------------------------
  global.fetch = realFetch;
  const made = [];
  const realCreate = document.createElement;
  document.createElement = tag => {
    const el = {
      tag, style: {}, width: 0, height: 0,
      getContext: () => ({
        imageSmoothingEnabled: true, fillStyle: '', fillRect() {}, drawImage() {}
      }),
      toDataURL: () => 'data:image/png;base64,SCALED'
    };
    made.push(el);
    return el;
  };
  delete ocr.upscaledPng;                       // restore the real implementation
  const fresh = require('./extract.js').ocr();
  fresh.loadImage = async () => ({ naturalWidth: 100, naturalHeight: 12 });
  const outUri = await fresh.upscaledPng.call(
    Object.assign(fresh, { loadImage: async () => ({ naturalWidth: 100, naturalHeight: 12 }) }),
    'data:,', 4);
  const cv = made[made.length - 1];
  check('the PNG sent is 4x the original size', cv && cv.width === 400 && cv.height === 48,
        cv && `${cv.width}x${cv.height}`);
  check('and it is genuinely re-encoded', outUri === 'data:image/png;base64,SCALED');
  document.createElement = realCreate;

  // --- 9. a timeout is not an unreachable server --------------------------
  // Regression: any exception used to set `offline`, so a vision model loading
  // for the first time disabled the oracle for the rest of the session.
  // Section 8 removed upscaledPng to exercise the real one; without restoring
  // the stub these checks would bail out before reaching fetch and pass for
  // entirely the wrong reason.
  ocr.upscaledPng = async () => 'data:image/png;base64,AAAA';
  oracle.reset();
  global.fetch = (url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });
  const before = oracle.stats.rejected;
  const askedBefore = oracle.stats.asked;
  got = await oracle.ask('data:,', rec, false);
  check('the request really went out (otherwise the test proves nothing)',
        oracle.stats.asked === askedBefore + 1);
  check('a timeout does not make the oracle stand down',
        got === null && oracle.offline === false,
        `offline=${oracle.offline}`);
  check('and it is counted as a refusal', oracle.stats.rejected === before + 1);

  global.fetch = async () => { throw new Error('fetch failed'); };
  got = await oracle.ask('data:,', rec, false);
  check('a real connection failure does stand it down', oracle.offline === true);
  oracle.reset();

  // --- 10. an HTTP error counts as a refusal ------------------------------
  const before2 = oracle.stats.rejected;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await oracle.ask('data:,', rec, false);
  check('an HTTP error is counted as a refusal',
        oracle.stats.rejected === before2 + 1 && oracle.offline === false);

  // --- 11. the feedback endpoint is derived, not assumed -------------------
  const seen = [];
  global.fetch = async (url) => { seen.push(String(url)); return { ok: true, json: async () => ({}) }; };
  oracle.reset();
  cfg.oracleUrl = 'http://127.0.0.1:8787/ocr';
  oracle.report({ engine: 'x', text: 'y' }, true);
  cfg.oracleUrl = 'http://127.0.0.1:9999/api/v2/read';
  oracle.report({ engine: 'x', text: 'y' }, true);
  await sleep(5);
  check('the feedback endpoint follows the configured path',
        seen[0] === 'http://127.0.0.1:8787/feedback' &&
        seen[1] === 'http://127.0.0.1:9999/api/v2/feedback', JSON.stringify(seen));
  cfg.oracleUrl = 'http://127.0.0.1:8787/ocr';
  global.fetch = realFetch;        // the server section needs the real one

  // --- 12. the timeout says which problem it is ---------------------------
  // A real session timed out for 40 s against a port with nothing listening:
  // a refused connection is instant, so a hang means the browser held it.
  const lastLines = () => A.ui.lines.slice(-4).join(' | ');
  cfg.oracleUrl = 'http://127.0.0.1:8787/ocr';

  oracle.reset();
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  await oracle.diagnose();
  check('server reachable: the model is what is blamed', /\/health answers/.test(lastLines()), lastLines());

  oracle.reset();
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await oracle.diagnose();
  check('instant refusal: the server is not running', /not running/.test(lastLines()), lastLines());

  oracle.reset();
  global.fetch = (url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });
  const tDiag = Date.now();
  await oracle.diagnose();
  check('it hangs too: the browser is holding the request',
        /holding local requests/.test(lastLines()), lastLines());
  check('and the diagnosis does not take 40 s', Date.now() - tDiag < 5000, `${Date.now() - tDiag} ms`);

  oracle.reset();
  A.ui.lines.length = 0;
  await oracle.diagnose(); await oracle.diagnose();
  check('the diagnosis does not repeat', A.ui.lines.length === 1, String(A.ui.lines.length));

  check('the endpoints derive from the configured path',
        oracle.healthUrl() === 'http://127.0.0.1:8787/health' &&
        oracle.endpoint('feedback') === 'http://127.0.0.1:8787/feedback',
        oracle.healthUrl());
  oracle.reset();
  global.fetch = realFetch;

  // ======================= the server =====================
  // the module reads OCR_LOG at load time, so set it before requiring it
  const logfile = path.join(os.tmpdir(), 'autohack-feedback-' + Date.now() + '.jsonl');
  process.env.OCR_LOG = logfile;
  // Isolate from whatever is installed on the machine: these checks broke the
  // day Ollama was really installed (warm-up succeeded, and /ocr sent a 1px
  // image to a CPU vision model). A dead port stands in for Ollama and the fake
  // binary, with no FAKE_TESS_* set, for a tesseract that reads nothing.
  process.env.OLLAMA_URL = 'http://127.0.0.1:9';
  process.env.PATH = path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH;
  delete process.env.FAKE_TESS_7;
  delete process.env.FAKE_TESS_8;
  const srv = require('../ocr-server/server.js');
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const pre = await realFetch(base + '/ocr', {
    method: 'OPTIONS',
    headers: { origin: 'https://s0urce.io', 'access-control-request-private-network': 'true' }
  });
  check('the preflight allows the game origin',
        pre.headers.get('access-control-allow-origin') === 'https://s0urce.io');
  check('and answers Private Network Access',
        pre.headers.get('access-control-allow-private-network') === 'true');

  const health = await (await realFetch(base + '/health')).json();
  check('/health answers', health.ok === true && typeof health.engines === 'object',
        JSON.stringify(health));

  // 1x1 png; with no engine installed this must degrade, not crash
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await realFetch(base + '/ocr', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: png, hint: { length: 7, pattern: 'expl?it' } })
  });
  const body = await r.json();
  check('/ocr returns well-formed JSON even with no engine',
        r.status === 200 && 'word' in body && Array.isArray(body.readings), JSON.stringify(body));

  const noImage = await realFetch(base + '/ocr', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hint: { length: 3 } })
  });
  check('a request with no image gives 400', noImage.status === 400,
        String(noImage.status));

  check('the charset is sanitized before tesseract',
        srv.sanitizeCharset('ab=c;rm -rf\n') === 'abcrmrf' &&
        srv.sanitizeCharset('') === null && srv.sanitizeCharset(null) === null);

  /* ---- hardening, proven against a live server rather than by reading it ----
   * Every case below is one a hostile page can actually produce. The earlier
   * version of the oversize check swallowed connection errors into a fake 400,
   * so it passed while the server was in fact resetting the socket; these
   * assert the status the caller really receives.
   */
  const post = (p, body, headers) => realFetch(base + p, {
    method: 'POST',
    headers: headers || { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

  const evil = await post('/ocr', { image: png },
                          { 'content-type': 'application/json', origin: 'https://evil.example' });
  check('a foreign origin is refused', evil.status === 403, String(evil.status));

  // CORS only hides the response; the side effects still run. Refusing the
  // request itself is what stops a form-style POST that skips the preflight.
  const simple = await post('/ocr', 'x',
                            { 'content-type': 'text/plain', origin: 'https://evil.example' });
  check('a simple request that dodges the preflight is refused too',
        simple.status === 403, String(simple.status));

  const noType = await post('/ocr', 'x', { 'content-type': 'text/plain' });
  check('a POST without a JSON content type is refused', noType.status === 415,
        String(noType.status));

  const notPng = await post('/ocr', { image: 'data:image/png;base64,QUJD' });
  check('a body that is not a PNG never reaches the engine', notPng.status === 400,
        String(notPng.status));

  // At width 5 a failing match explores every split: 8 holes took 7 ms and 12
  // took 5.1 s, so this must be refused before the expression is ever built.
  const holesAt = Date.now();
  const holes = await post('/ocr', { image: png, hint: { pattern: '?'.repeat(16), holeWidth: 5, maxLength: 40 } });
  const holesMs = Date.now() - holesAt;
  check('a pattern with too many holes is refused before the regex is built',
        holes.status === 400 && holesMs < 500, `${holes.status} in ${holesMs} ms`);

  const unbounded = await post('/ocr', { image: png, hint: { pattern: 'a?c', holeWidth: 3 } });
  check('variable-width holes without an upper bound are refused',
        unbounded.status === 400, String(unbounded.status));

  const leak = await post('/ocr', { image: png, hint: { pattern: '?'.repeat(200000) } });
  const leakBody = await leak.text();
  check('an error body never carries internals back to the caller',
        leak.status === 400 && leakBody.length < 1024,
        `${leak.status}, ${leakBody.length} bytes`);

  const huge = await post('/ocr', { image: 'data:image/png;base64,' + 'A'.repeat(9 << 20) });
  check('an oversize body is answered with 413, not a reset', huge.status === 413,
        String(huge.status));

  // /health spawns a process to detect engines; uncached it is a spawn loop.
  const counter = path.join(os.tmpdir(), 'autohack-tess-calls-' + Date.now());
  process.env.FAKE_TESS_COUNT = counter;
  for (let i = 0; i < 3; i++) await realFetch(base + '/health');
  delete process.env.FAKE_TESS_COUNT;
  const spawns = fs.existsSync(counter)
    ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  if (fs.existsSync(counter)) fs.unlinkSync(counter);
  check('repeated /health calls are cached instead of spawning each time',
        spawns <= 1, String(spawns));

  // Each /ocr spawns two processes and holds ~6 MB; the gate has to bind.
  process.env.FAKE_TESS_SLEEP = '1';
  const burst = await Promise.all(Array.from({ length: 6 },
    () => post('/ocr', { image: png }).then(r => r.status).catch(() => 'error')));
  delete process.env.FAKE_TESS_SLEEP;
  check('past 4 requests in flight the rest are turned away with 503',
        burst.filter(s => s === 503).length === 2 &&
        burst.filter(s => s === 200).length === 4, JSON.stringify(burst));

  // A caller that hangs up must not leave engines running. Regression: the
  // listener used to sit on the request, which has already emitted 'close' by
  // the time its body is read, so nothing was ever aborted.
  const DUR = '7.77';                 // distinctive: nothing else sleeps this long
  const cp = require('child_process');
  // Probed once, and separately from the counting: without this, a machine
  // with no pgrep took the catch below, counted zero engines in flight, and
  // failed the assertion with a message that blamed the server instead of the
  // missing binary. An absent tool is a skip, not a regression.
  const hasPgrep = (() => {
    try { cp.execSync('command -v pgrep', { stdio: 'ignore' }); return true; }
    catch (e) { return false; }
  })();
  const engines = () => {
    try {
      return +cp.execSync("pgrep -fc 'slee[p] " + DUR + "'").toString().trim();
    } catch (e) { return 0; }
  };
  process.env.FAKE_TESS_SLEEP = DUR;
  const hangup = new AbortController();
  realFetch(base + '/ocr', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: png }), signal: hangup.signal
  }).catch(() => {});
  await sleep(700);
  const running = engines();          // proves the measurement works at all
  hangup.abort();
  await sleep(1300);
  const survivors = engines();
  delete process.env.FAKE_TESS_SLEEP;
  check('a caller that hangs up leaves no engine running',
        running >= 1 && survivors === 0,
        `in flight ${running}, still alive ${survivors}`);

  // start() is the only entry point that binds a port, so the wildcard guard
  // has to be checked where it lives; it exits, hence a child process.
  const startsWith = origin => {
    try {
      require('child_process').execFileSync(
        process.execPath, ['-e', 'require(process.argv[1]).start()',
                           path.join(__dirname, '..', 'ocr-server', 'server.js')],
        { env: Object.assign({}, process.env, { OCR_ORIGIN: origin }),
          stdio: 'pipe', timeout: 5000 });
      return 0;
    } catch (e) { return e.status; }
  };
  check('a wildcard origin refuses to start', startsWith('*') === 1);
  // An unset variable means "use the default"; an explicitly empty one is a
  // mistake, and used to become the default silently, so the guard never saw it.
  check('an explicitly empty origin refuses to start too', startsWith('') === 1);

  const warm = await srv.warmOllama();
  check('preloading breaks nothing when ollama is missing', warm === false);

  const bad = await realFetch(base + '/ocr', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops'
  });
  check('an invalid body gives 400, not a crash', bad.status === 400);

  const fb = await realFetch(base + '/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'tesseract', reading: 'exploit', word: 'exploit', accepted: true })
  });
  check('/feedback accepts', (await fb.json()).ok === true);
  const logged = fs.readFileSync(logfile, 'utf8').trim().split('\n').map(JSON.parse);
  check('the log is usable',
        logged.length === 1 && logged[0].engine === 'tesseract' && logged[0].accepted === true,
        JSON.stringify(logged));
  fs.unlinkSync(logfile);
  srv.server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
