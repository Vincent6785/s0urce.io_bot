// Indexing, the write rule, deferred saves, compaction and the vocabulary
// rescue — checked against the real exported dictionary when one is present.
const fs = require('fs'), path = require('path');
const makeOcr = require('./extract.js').ocr;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name +
              (cond || extra === undefined ? '' : `\n      ${extra}`));
};

// the pre-index implementation, kept verbatim as the reference
function oldLookup(ocr, seg) {
  if (ocr.glyphs[seg.key]) return ocr.glyphs[seg.key];
  const shapePrefix = seg.shape + '@';
  for (const key in ocr.glyphs) if (key.startsWith(shapePrefix)) return ocr.glyphs[key];
  const dimPrefix = `${seg.gw}x${seg.gh}:`;
  const budget = Math.max(2, Math.floor(seg.gw * seg.gh * 0.10));
  let bestChar = null, bestDist = Infinity;
  for (const key in ocr.glyphs) {
    if (!key.startsWith(dimPrefix)) continue;
    const at = key.indexOf('@');
    if (at === -1) continue;
    const other = ocr.hexToBits(key.slice(dimPrefix.length, at), seg.gw * seg.gh);
    let dist = 0;
    for (let i = 0; i < other.length; i++) {
      if (other[i] !== seg.bits[i]) { dist++; if (dist > budget) break; }
    }
    if (dist <= budget && dist < bestDist) { bestDist = dist; bestChar = ocr.glyphs[key]; }
  }
  return bestChar;
}

function segFromKey(ocr, key, flips) {
  const m = /^(\d+)x(\d+):([0-9a-f]*)@(-?\d+)$/.exec(key);
  const gw = +m[1], gh = +m[2];
  const bits = ocr.hexToBits(m[3], gw * gh);
  for (let i = 0; i < (flips || 0); i++) bits[(i * 7) % bits.length] ^= 1;
  const shape = `${gw}x${gh}:${ocr.bitsToHex(bits)}`;
  return { gw, gh, absTop: +m[4], bits, shape, key: `${shape}@${m[4]}` };
}

// --- synthetic font, for the behaviour tests -------------------------------
const FONT = {
  a: ["01110","10001","10001","11111","10001","10001","10001"],
  b: ["11110","10001","11110","10001","10001","10001","11110"],
  c: ["01111","10000","10000","10000","10000","10000","01111"],
  d: ["11110","10001","10001","10001","10001","10001","11110"],
  e: ["11111","10000","11110","10000","10000","10000","11111"],
  z: ["11111","00001","00010","00100","01000","10000","11111"],
};
function render(word, noise) {
  const h = 7, gs = [...word].map(c => FONT[c]), w = gs.length * 5 + (gs.length - 1);
  const mask = new Uint8Array(w * h);
  let x = 0;
  for (const g of gs) {
    for (let y = 0; y < h; y++) for (let dx = 0; dx < 5; dx++) if (g[y][dx] === '1') mask[y * w + x + dx] = 1;
    x += 6;
  }
  for (let i = 0; i < (noise || 0); i++) mask[(i * 13) % mask.length] ^= 1;
  return { w, h, mask };
}

(async () => {
  // ======================= real dictionary =================================
  const bckPath = path.join(__dirname, '..', 'bck');
  if (fs.existsSync(bckPath)) {
    const bck = JSON.parse(fs.readFileSync(bckPath, 'utf8'));
    const ocr = makeOcr();
    ocr.glyphs = bck.glyphs; ocr.words = bck.words; ocr.index = null;
    const keys = Object.keys(ocr.glyphs);
    console.log(`   (real dictionary: ${keys.length} glyphs)`);

    // sample across the whole key space
    const step = Math.max(1, Math.floor(keys.length / 500));
    const sample = keys.filter((_, i) => i % step === 0);

    let mismatch = 0, firstBad = null;
    for (const key of sample) {
      for (const flips of [0, 1, 3]) {
        const seg = segFromKey(ocr, key, flips);
        const a = oldLookup(ocr, seg), b = ocr.lookupGlyph(seg);
        if (a !== b) { mismatch++; if (!firstBad) firstBad = `${key} flips=${flips}: ${a} vs ${b}`; }
      }
    }
    check(`the index returns exactly the same result as the scan (${sample.length * 3} real cases)`,
          mismatch === 0, firstBad);

    // timing, informational
    const seg = segFromKey(ocr, sample[0], 3);
    const t = fn => { const s = process.hrtime.bigint(); for (let i = 0; i < 200; i++) fn();
                      return Number(process.hrtime.bigint() - s) / 1e6 / 200; };
    const before = t(() => oldLookup(ocr, seg));
    const after = t(() => ocr.lookupGlyph(seg));
    console.log(`   fuzzy lookup: ${before.toFixed(3)} ms -> ${after.toFixed(3)} ms ` +
                `(${(before / after).toFixed(0)}x faster)`);
    check('the indexed lookup is much faster', after < before / 5,
          `${before.toFixed(3)} -> ${after.toFixed(3)}`);

    // compaction on the real data
    const sizeBefore = Object.keys(ocr.glyphs).length;
    const removedKeys = [];
    const snapshot = Object.assign({}, ocr.glyphs);
    const r = ocr.compact();
    for (const k in snapshot) if (!(k in ocr.glyphs)) removedKeys.push(k);
    console.log(`   compaction: ${r.before} -> ${r.after} entries (${r.beforeKB} -> ${r.afterKB} KB)`);
    check('compaction shrinks the dictionary substantially', r.after < r.before / 3,
          `${r.before} -> ${r.after}`);
    check('the reported counters are consistent',
          r.before === sizeBefore && r.removed === removedKeys.length);

    let lost = 0, firstLost = null;
    for (const key of removedKeys) {
      const s2 = segFromKey(ocr, key);
      const got = ocr.lookupGlyph(s2);
      if (got !== snapshot[key]) { lost++; if (!firstLost) firstLost = `${key}: ${snapshot[key]} -> ${got}`; }
    }
    check('every removed entry is still recognized correctly', lost === 0,
          `${lost} lost, e.g. ${firstLost}`);

    const badKey = Object.keys(ocr.glyphs).find(k => !/^\d+x\d+:[0-9a-f]*@-?\d+$/.test(k));
    check('the key format survives compaction', !badKey, badKey);

    // the user's own backup must still import cleanly and round-trip
    const fresh = makeOcr();
    const res = fresh.importData(JSON.stringify(bck));
    check('the real backup reimports in full',
          res.glyphs === Object.keys(bck.glyphs).length && res.skipped === 0,
          JSON.stringify(res));
    const again = JSON.parse(JSON.stringify(fresh.exportData()));
    check('export -> import -> export gives back the same dictionary',
          JSON.stringify(again.glyphs) === JSON.stringify(bck.glyphs) &&
          JSON.stringify(again.words) === JSON.stringify(bck.words));
  } else {
    console.log('   (no bck file — real-data tests skipped)');
  }

  // ======================= write rule ======================================
  {
    const ocr = makeOcr();
    ocr.toMask = async tag => render(tag, tag === 'noisy' ? 2 : 0);
    await ocr.learn('abc', 'abc');
    const n1 = Object.keys(ocr.glyphs).length;
    await ocr.learn('abc', 'abc');
    check('relearning the same word adds nothing', Object.keys(ocr.glyphs).length === n1,
          `${n1} -> ${Object.keys(ocr.glyphs).length}`);

    ocr.toMask = async () => render('abc', 2);          // same word, 2 pixels off
    await ocr.learn('slightly-off', 'abc');
    check('a near variant is not stored again', Object.keys(ocr.glyphs).length === n1,
          `${n1} -> ${Object.keys(ocr.glyphs).length}`);

    ocr.toMask = async () => render('dez');             // genuinely new shapes
    await ocr.learn('new', 'dez');
    check('genuinely new shapes are learned',
          Object.keys(ocr.glyphs).length > n1);
  }

  // ======================= deferred save ===================================
  {
    const ocr = makeOcr();
    ocr.toMask = async tag => render(tag);
    let writes = 0;
    const realFlush = ocr.flush.bind(ocr);
    ocr.flush = function () { if (this.dirty) writes++; realFlush(); };
    for (let i = 0; i < 5; i++) await ocr.learn('abc', 'abc');
    check('learning several times does not write every time', writes === 0, String(writes));
    ocr.flush();
    check('an explicit flush writes once', writes === 1, String(writes));
    ocr.flush();
    check('a flush with no change writes nothing', writes === 1, String(writes));
  }

  // ======================= vocabulary rescue ===============================
  {
    const ocr = makeOcr();
    ocr.toMask = async tag => render(tag);
    await ocr.learn('abcde', 'abcde');       // 5 letters, all known
    ocr.words['h1'] = 'abcde'; ocr.index = null;

    // drop 'e' from the dictionary: 4 known letters, 1 hole, one candidate
    for (const k of Object.keys(ocr.glyphs)) if (ocr.glyphs[k] === 'e') delete ocr.glyphs[k];
    ocr.index = null;
    const before = Object.keys(ocr.glyphs).length;
    let r = await ocr.recognize('abcdz');    // renders a b c d z -> 'abcd' + hole
    check('a single candidate resolves the word', r.word === 'abcde' && r.fromVocabulary === true,
          JSON.stringify({ word: r.word, partial: r.partial }));
    check('vocabulary rescue writes nothing',
          Object.keys(ocr.glyphs).length === before, `${before} -> ${Object.keys(ocr.glyphs).length}`);

    // two candidates that both fit -> refuse to guess
    ocr.words['h2'] = 'abcdc'; ocr.index = null;
    r = await ocr.recognize('abcdz');
    check('two candidates means no guess', r.word === null, JSON.stringify(r.word));

    // too few known letters to be safe
    const ocr2 = makeOcr();
    ocr2.toMask = async tag => render(tag);
    await ocr2.learn('abc', 'abc');
    ocr2.words['h'] = 'abc';
    for (const k of Object.keys(ocr2.glyphs)) if (ocr2.glyphs[k] === 'c') delete ocr2.glyphs[k];
    ocr2.index = null;
    r = await ocr2.recognize('abz');
    check('fewer than 3 certain letters means no attempt', r.word === null, JSON.stringify(r.word));
  }

  // ======================= touching letters ================================
  // From a real session: each partial matched exactly one lexicon word once a
  // hole was allowed to hide several letters, and none with one letter per hole.
  {
    const ocr = makeOcr();
    ocr.words = { a: 'victimSupport', b: 'emailCompromised', c: 'timestamp', d: 'exploit' };
    ocr.index = null;
    check('victi…upport -> victimSupport (1 extra letter)',
          ocr.fromVocabulary('victi…upport', [5]) === 'victimSupport');
    check('e…il…mpromised -> emailCompromised (2 extra)',
          ocr.fromVocabulary('e…il…mpromised', [1, 4]) === 'emailCompromised');
    check('t…st…p -> timestamp (3 extra)',
          ocr.fromVocabulary('t…st…p', [1, 4]) === 'timestamp');
    check('a hole hiding a single letter still works',
          ocr.fromVocabulary('expl…it', [4]) === 'exploit');

    ocr.words.e = 'victimsSupport'; ocr.index = null;   // also fits victi…upport
    check('two matching words of different lengths means no guess',
          ocr.fromVocabulary('victi…upport', [5]) === null);

    const ocr2 = makeOcr();
    ocr2.words = { a: 'abXXXXcd' }; ocr2.index = null;  // the hole would hide 4 > MAX_MERGE
    check('a hole hides at most 3 letters', ocr2.fromVocabulary('ab…cd', [2]) === null);

    const ocr3 = makeOcr();
    ocr3.words = { a: 'a.b*c' }; ocr3.index = null;     // regex metacharacters inside words
    check('pattern metacharacters stay literal',
          ocr3.fromVocabulary('a.…*c', [2]) === 'a.b*c' && ocr3.fromVocabulary('aX…*c', [2]) === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
