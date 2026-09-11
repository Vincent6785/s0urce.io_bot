// Runs with a pristine config: the page-context handle must not exist.
const { store } = require('./env.js');
store.delete('s0urce_bot_cfg');            // undo the suite's debug seed
const fs = require('fs'), path = require('path');
eval(fs.readFileSync(path.join(__dirname, '..', 's0urce-autohack.user.js'), 'utf8'));

const ok = typeof window.__autohack === 'undefined';
console.log((ok ? 'ok  ' : 'FAIL') + '  no page global when debug is off');
console.log(`\n${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
