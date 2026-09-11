// Server-side tesseract policy: a reading is only offered when psm 7 and psm 8
// agree. Uses test/fakebin/tesseract, so results do not depend on the real OCR.
const path = require('path');
process.env.PATH = path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH;
process.env.OLLAMA_URL = 'http://127.0.0.1:9';      // nothing listens: the model is "absent"
const srv = require('../ocr-server/server.js');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name +
              (cond || extra === undefined ? '' : `\n      ${extra}`));
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ask = (t7, t8, hint) => {
  process.env.FAKE_TESS_7 = t7;
  process.env.FAKE_TESS_8 = t8;
  return srv.handleOcr({ image: PNG, hint });
};

(async () => {
  const hint = { length: 7, pattern: 'expl?it' };

  let r = await ask('exploit', 'exploit', hint);
  check('both modes agree: a reading is proposed',
        r.word === 'exploit' && r.engine === 'tesseract' && r.readings.length === 1,
        JSON.stringify(r));
  check('and nothing is discarded', r.discarded.length === 0);

  r = await ask('exploit', 'explait', hint);
  check('disagreement: no reading is proposed', r.word === null && r.readings.length === 0,
        JSON.stringify(r));
  check('both readings are kept for diagnostics',
        r.discarded.map(d => d.engine).join() === 'tesseract-psm7,tesseract-psm8',
        JSON.stringify(r.discarded));

  // The client picks any reading that fits the pattern — a lone mode must never
  // reach `readings`, even when it happens to fit.
  r = await ask('', 'exploit', hint);
  check('a lone mode, even a fitting one, does not pass', r.readings.length === 0 && r.word === null,
        JSON.stringify(r));
  check('it is discarded, not lost',
        r.discarded.length === 1 && r.discarded[0].text === 'exploit');

  // 'expzoit' puts a 'z' where the dictionary is sure of an 'l' — unlike
  // 'explzit', which only fills the hole and genuinely fits
  r = await ask('expzoit', 'expzoit', hint);
  check('agreement but the pattern does not fit: proposed without being retained',
        r.word === null && r.readings.length === 1 && r.readings[0].fits === false,
        JSON.stringify(r));

  r = await ask('', '', hint);
  check('no reading: an empty but well-formed response',
        r.word === null && Array.isArray(r.readings) && Array.isArray(r.discarded));

  // the two modes really run with distinct psm values
  process.env.FAKE_TESS_7 = 'seven'; process.env.FAKE_TESS_8 = 'eight';
  const [a, b] = await Promise.all([srv.runTesseract(Buffer.from('x'), 'abc', 7),
                                    srv.runTesseract(Buffer.from('x'), 'abc', 8)]);
  check('psm 7 and psm 8 really are two distinct calls', a === 'seven' && b === 'eight',
        `${a} / ${b}`);

  // --- touching letters: '?' may hide several characters -------------------
  const wide = { pattern: 'victi?upport', holeWidth: 3, minLength: 12, maxLength: 14 };
  check('a wide hole accepts touching letters', srv.fits('victimSupport', wide) === true);
  check('but not a known letter contradicted', srv.fits('vixtimSupport', wide) === false);
  check('nor a word that is too long', srv.fits('victimSupportXY', wide) === false);
  check("with no holeWidth, the old exact semantics still apply",
        srv.fits('explicit', { length: 7, pattern: 'expl?it' }) === false &&
        srv.fits('exploit', { length: 7, pattern: 'expl?it' }) === true);
  check('holeWidth is capped', srv.fits('abXXXXXXcd', { pattern: 'ab?cd', holeWidth: 99 }) === false);
  r = await ask('victimSupport', 'victimSupport', wide);
  check('tesseract agreement on a word with touching letters: retained',
        r.word === 'victimSupport', JSON.stringify(r));

  // --- model presence: the API answering is not the model being pulled -----
  check('a name with no tag matches :latest',
        srv.modelListed([{ name: 'qwen2.5vl:latest' }], 'qwen2.5vl') === true);
  check('an explicit tag must match exactly',
        srv.modelListed([{ name: 'qwen2.5vl:latest' }], 'qwen2.5vl:3b') === false &&
        srv.modelListed([{ name: 'qwen2.5vl:3b' }], 'qwen2.5vl:3b') === true);
  check('another model does not count',
        srv.modelListed([{ name: 'llava:latest' }], 'qwen2.5vl') === false &&
        srv.modelListed(undefined, 'qwen2.5vl') === false);

  // a fake Ollama that only has llava pulled
  const http = require('http');
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llava:latest' }] }));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  const fresh = model => {
    process.env.OLLAMA_URL = fakeUrl;
    process.env.OLLAMA_MODEL = model;
    delete require.cache[require.resolve('../ocr-server/server.js')];
    return require('../ocr-server/server.js');
  };

  let s2 = fresh('qwen2.5vl');
  await s2.detectEngines();
  check('API up but model missing: reported as such',
        s2.engines.ollama === true && s2.engines.model === false, JSON.stringify(s2.engines));
  check('and no attempt is made to preload it', (await s2.warmOllama()) === false);

  s2 = fresh('llava');
  await s2.detectEngines();
  check('model actually pulled: recognized', s2.engines.model === true, JSON.stringify(s2.engines));
  fake.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
