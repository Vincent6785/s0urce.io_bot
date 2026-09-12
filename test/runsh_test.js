// The TEST_WATCHDOG_MS prologue of run.sh, exercised on its own. CI only ever
// runs the script with the default, so none of this logic is covered otherwise
// -- and its failure mode is silent: `timeout 0s` means NO timeout at all, so a
// regression here leaves every suite green while the guard is quietly gone.
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name +
              (cond || extra === undefined ? '' : `\n      ${extra}`));
};

// Sliced by literal markers, the same trade extract.js makes: it breaks loudly
// if the script is restructured, rather than testing a stale copy.
const SH = fs.readFileSync(path.join(__dirname, 'run.sh'), 'utf8');
const from = SH.indexOf('MS=${TEST_WATCHDOG_MS');
const to = SH.indexOf('\nfor t in ');
if (from === -1 || to === -1) throw new Error('runsh: markers moved in run.sh');
const prologue = SH.slice(from, to) + '\necho "$SECS|$RUN"\n';

// One invocation per case, and stderr captured rather than inherited: the
// refusal cases below are expected, and letting them print would litter the
// CI log with messages that mean the test is working.
const run = value => {
  const env = Object.assign({}, process.env);
  if (value === null) delete env.TEST_WATCHDOG_MS; else env.TEST_WATCHDOG_MS = value;
  try {
    const out = execFileSync('sh', ['-c', prologue],
                             { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const [secs, cmd] = out.split('|');
    return { secs, cmd, status: 0 };
  } catch (e) {
    return { secs: null, cmd: null, status: e.status, err: String(e.stderr || '').trim() };
  }
};

const dflt = run(null);
check('unset gives the documented 180 s', dflt.secs === '180', JSON.stringify(dflt));
check('a plain value is honoured', run('30000').secs === '30');

// The whole point of the floor: integer division sent anything under 1000 to
// `timeout 0s`, which disables the timeout instead of tightening it.
const half = run('500'), zero = run('0');
check('under a second is floored to one, never to zero',
      half.secs === '1' && zero.secs === '1', `${half.secs} / ${zero.secs}`);

// 010000 is the discriminating case: 10 s read as decimal, 4 s read as octal.
// 00500 would give 1 s either way and would prove nothing.
const octalish = run('010000'), padded = run('0900');
check('a leading zero is not read as octal', octalish.secs === '10', JSON.stringify(octalish));
check('a leading zero does not abort the arithmetic either',
      padded.status === 0 && padded.secs === '1', JSON.stringify(padded));

const word = run('abc'), suffixed = run('5s');
check('a non-number is refused with its own exit code',
      word.status === 2 && /whole number/.test(word.err), JSON.stringify(word));
check('and so is a value with a unit suffix', suffixed.status === 2, JSON.stringify(suffixed));

check('the timeout command line is well formed when one is available',
      dflt.cmd === '' || /^timeout (-k 10s )?180s$/.test(dflt.cmd), JSON.stringify(dflt.cmd));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
