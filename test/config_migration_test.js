// The stored 6 s oracle timeout predates the vision-model measurement (~27 s on
// CPU) and must be migrated; a value picked on purpose must survive. Each case
// runs in its own process, because the userscript builds its config once.
const { execFileSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name +
              (cond || extra === undefined ? '' : `\n      ${extra}`));
};

function timeoutWith(stored) {
  const code = `
    const { store } = require(${JSON.stringify(path.join(__dirname, 'env.js'))});
    store.set('s0urce_bot_cfg', JSON.stringify(${JSON.stringify(stored)}));
    eval(require('fs').readFileSync(${JSON.stringify(path.join(__dirname, '..', 's0urce-autohack.user.js'))}, 'utf8'));
    process.stdout.write('RESULT=' + window.__autohack.cfg.oracleTimeoutMs);
    process.exit(0);`;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  const m = /RESULT=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

check('the stored old default (6 s) is migrated',
      timeoutWith({ debug: true, oracleTimeoutMs: 6000 }) === 40000);
check('a value picked on purpose is kept',
      timeoutWith({ debug: true, oracleTimeoutMs: 12000 }) === 12000);
check('with no stored value, the new default applies',
      timeoutWith({ debug: true }) === 40000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
