const ocr = require('./extract.js').ocr();

// Build a fake glyph-line mask: 5x7 letters separated by 1 empty column.
// 'A','B','C' with distinct patterns, plus a short 'i' that sits lower.
const FONT = {
  a: ["01110","10001","10001","11111","10001","10001","10001"],
  b: ["11110","10001","11110","10001","10001","10001","11110"],
  c: ["01111","10000","10000","10000","10000","10000","01111"],
  i: ["00000","00000","00100","00100","00100","00100","00100"],  // vertically offset
};

function render(word, noise=0) {
  const h = 7;
  const glyphs = [...word].map(ch => FONT[ch]);
  const w = glyphs.length * 5 + (glyphs.length - 1); // 1px gap
  const mask = new Uint8Array(w*h);
  let x = 0;
  for (const g of glyphs) {
    for (let y=0;y<h;y++) for (let dx=0;dx<5;dx++)
      if (g[y][dx]==='1') mask[y*w + x + dx] = 1;
    x += 6;
  }
  if (noise) {
    for (let k=0;k<noise;k++) {
      const p = Math.floor(Math.random()*w*h);
      mask[p] ^= 1;
    }
  }
  return {w,h,mask};
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name +
              (cond || extra === undefined ? '' : `\n      ${extra}`));
};

// 1. segmentation splits on empty columns
let seg = ocr.segment(render('abc'));
check('segments abc into 3 glyphs', seg.segments.length === 3);
check('line hash produced', !!seg.lineHash);

// 2. learn then recognize (recognize needs toMask -> stub it)
ocr.toMask = async (tag) => render(tag);
(async () => {
  await ocr.learn('abc', 'abc');
  let r = await ocr.recognize('abc');
  check('recognizes the learned word', r.word === 'abc');

  // 3. new arrangement of known glyphs
  r = await ocr.recognize('cab');
  check('recognizes an unseen combination', r.word === 'cab');

  // 4. baseline offset keeps i distinct from a full-height glyph
  await ocr.learn('bib', 'bib');
  r = await ocr.recognize('iii');
  check('recognizes the offset glyph', r.word === 'iii');

  // 5. unknown glyph -> no word, partial read reported
  FONT.z = ["11111","00001","00010","00100","01000","10000","11111"];
  r = await ocr.recognize('abz');
  check('unknown glyph is not guessed', r.word === null);
  check('partial read exposed', r.partial === 'ab…');

  // 6. word cache rescues an image whose glyphs are unknown
  await ocr.learn('abz', 'abz');
  const savedGlyphs = JSON.parse(JSON.stringify(ocr.glyphs));
  ocr.glyphs = {}; ocr.index = null;
  r = await ocr.recognize('abz');
  check('word cache hit when glyphs are gone', r.word === 'abz' && r.fromCache === true);
  ocr.glyphs = savedGlyphs; ocr.index = null;

  // 7. tolerant match survives a couple of flipped pixels
  const noisy = render('abc'); noisy.mask[0] ^= 1; noisy.mask[8] ^= 1;
  ocr.toMask = async () => noisy;
  r = await ocr.recognize('noisy');
  check('fuzzy match survives 2 flipped pixels', r.word === 'abc');

  // 8. forget removes what we learned
  ocr.toMask = async (tag) => render(tag);
  await ocr.forget('abc');
  r = await ocr.recognize('abc');
  check('forget clears the bad mapping', r.word === null);

  // 9. backup round-trip
  ocr.glyphs = {}; ocr.words = {}; ocr.index = null;
  await ocr.learn('abc', 'abc');
  const dump = JSON.stringify(ocr.exportData());
  const glyphCount = Object.keys(ocr.glyphs).length;
  // `dump.includes('"words"')` was guaranteed by the key name alone, and
  // glyphCount measures the live object rather than the export.
  const parsed = JSON.parse(dump);
  check('the export itself carries the glyphs and the word',
        glyphCount === 3 && Object.keys(parsed.glyphs).length === 3 &&
        Object.keys(parsed.words).length === 1,
        JSON.stringify({ g: Object.keys(parsed.glyphs).length, w: Object.keys(parsed.words).length }));

  ocr.reset();
  check('reset really empties it', Object.keys(ocr.glyphs).length === 0);
  let r9 = ocr.importData(dump);
  check('import reports what it merged', r9.glyphs === 3 && r9.words === 1, JSON.stringify(r9));
  r9 = await ocr.recognize('abc');
  check('the imported dictionary works again', r9.word === 'abc');

  // 10. the hand-written localStorage backup (fields are raw JSON strings)
  ocr.glyphs = {}; ocr.words = {}; ocr.index = null;
  const manual = JSON.stringify({
    glyphs: JSON.stringify(JSON.parse(dump).glyphs),
    words: JSON.stringify(JSON.parse(dump).words),
    prints: JSON.stringify(['cable_x'])
  });
  const r10 = ocr.importData(manual);
  check('accepts the console-style backup too', r10.glyphs === 3 && r10.prints === 1,
        JSON.stringify(r10));

  // 11. import merges instead of replacing
  await ocr.learn('bib', 'bib');
  const before = Object.keys(ocr.glyphs).length;
  ocr.importData(dump);
  check('import keeps what was already learned',
        Object.keys(ocr.glyphs).length >= before, `${before} -> ${Object.keys(ocr.glyphs).length}`);

  // 12. rubbish and stale keys are refused, not silently stored
  let err = null;
  try { ocr.importData('not json at all'); } catch (e) { err = e.message; }
  check('invalid JSON is refused', /not valid JSON/.test(err || ''), err);
  err = null;
  try { ocr.importData('{"hello":1}'); } catch (e) { err = e.message; }
  check('a JSON blob with nothing usable is refused', /nothing importable/.test(err || ''), err);

  // 12b. a newer export format is refused instead of being half-eaten by the
  // shape sniffing below. The string case is the one that matters: it only
  // works because of the Number() coercion, and "simplifying" to data.v > 1
  // would silently stop refusing it.
  err = null;
  try { ocr.importData('{"v":2,"glyphs":{}}'); } catch (e) { err = e.message; }
  check('a backup from a newer version is refused', /newer version/.test(err || ''), err);
  err = null;
  try { ocr.importData('{"v":"2","glyphs":{}}'); } catch (e) { err = e.message; }
  check('a version written as a string counts too', /newer version/.test(err || ''), err);
  const cur = ocr.importData(dump);          // v:1 -- still the current format
  check('the current format still imports', cur.glyphs === 3, JSON.stringify(cur));

  const stale = JSON.stringify({ glyphs: { '5x7+0:abcd': 'a', '1x1:f@0': 'b' } });
  const r12 = ocr.importData(stale);
  check('old-format glyph keys are skipped, current ones kept',
        r12.glyphs === 1 && r12.skipped === 1, JSON.stringify(r12));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
