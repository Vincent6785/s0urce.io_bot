// Pulls live objects straight out of the userscript, so a suite can never run
// against a stale generated copy — that trap silently tested old code once.
//
// Every marker below is matched literally, leading indentation included
// ('    const MAX_MERGE', '    const ocr = {'). Reindenting or reflowing the
// userscript breaks four suites at once. They fail loudly rather than quietly
// — each lookup throws 'extract: markers moved' — so when that happens the fix
// is to update the marker here, not to reformat the userscript around it.
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 's0urce-autohack.user.js'), 'utf8');

function between(startMark, endMark) {
  const i = SRC.indexOf(startMark), j = SRC.indexOf(endMark);
  if (i === -1 || j === -1 || j <= i) throw new Error('extract: markers moved — ' + startMark);
  return SRC.slice(i, j);
}

// Helpers the OCR object closes over, taken from the userscript itself so the
// suites exercise the real code. Found by line markers: the regex inside
// patternRegex contains braces, so brace counting would miscount.
function sharedHelpers() {
  const start = SRC.indexOf('    const MAX_MERGE');
  const fn = SRC.indexOf('    function patternRegex(', start);
  if (start === -1 || fn === -1) throw new Error('extract: helper markers moved');
  const end = SRC.indexOf('\n    }\n', fn);
  if (end === -1) throw new Error('extract: end of patternRegex not found');
  return SRC.slice(start, end + '\n    }\n'.length);
}

// The OCR object, with the few globals it closes over stubbed out.
exports.ocr = function () {
  const store = {};
  const LS = { get: (k, f) => (k in store ? store[k] : f), set: (k, v) => { store[k] = v; } };
  const K_GLYPHS = 'g', K_WORDS = 'w';
  const ui = { status() {}, log() {} };
  const bot = { knownPrints: [] };
  const body = between('    const ocr = {',
    '    /* ======================================================================\n     * 4. Game actions');
  return eval('(() => {' + sharedHelpers() + body + '\nreturn ocr; })()');
};

exports.decodeFrame = function () {
  const body = between('    function decodeFrame(data) {', '    function noteImage(res) {');
  return eval('(() => {' + body + '\nreturn decodeFrame; })()');
};
