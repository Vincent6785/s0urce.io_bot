const { MockWS, mockWindow } = require('./env.js');
const fs = require('fs');

// load the userscript into this environment
const src = fs.readFileSync(require('path').join(__dirname, '..', 's0urce-autohack.user.js'), 'utf8');
eval(src);

const A = window.__autohack;
const { bus, bot, cfg } = A;
const realAskWord = A.ui.askWord;      // phase 6 replaces it with a stub

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name + (cond || extra === undefined ? '' : `\n      ${extra}`));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('unhandledRejection', e => { console.log('UNHANDLED: ' + e.message); });

// helpers -------------------------------------------------------------------
// s0urce runs socket.io with the default transports, so the session is
// established over HTTP polling and the websocket only appears at the upgrade.
// The socket.io CONNECT packet ("40") therefore travels over XHR and is NEVER
// seen on this socket — replay the sequence that actually occurs.
function connect(mode) {
  new WebSocket('wss://s0urce.io/socket.io/?EIO=4&transport=websocket&sid=abc');
  // the Proxy in the script wraps construction, so grab what it attached to
  const live = MockWS.last;
  if (mode === 'websocket-first') {
    live.deliver('40{"sid":"abc"}');         // rememberUpgrade: CONNECT on the ws
  } else {
    live.send('2probe');                     // engine.io probe
    live.deliver('3probe');
    live.send('5');                          // UPGRADE — this socket is now live
  }
  return live;
}
const framesOf = ws => ws.sent.map(f => {
  const d = A.decodeFrame(f);
  return d && Array.isArray(d.payload) ? { id: d.id, ...d.payload[1] } : null;
}).filter(Boolean);
const lastFrame = ws => framesOf(ws).slice(-1)[0];
const ackFor = (ws, matcher) => framesOf(ws).find(matcher);
const rawIdOf = (ws, i) => A.decodeFrame(ws.sent[i]).id;

(async () => {
  // --- 1. ack ids continue the client's sequence, they don't jump ----------
  let ws = connect();
  ws.send('425["playerInput",{"event":"getInventory"}]');       // the real client
  const p1 = A.emit({ event: 'getComputerInfo' });
  const botId = rawIdOf(ws, ws.sent.length - 1);
  check('bot ack id follows the client counter', botId === 6, `got ${botId}, wanted 6`);
  check('bot id is not in a giveaway range', botId < 1000);
  ws.deliver(`43${botId}[{"status":"success"}]`);
  check('request resolves on its ack', (await p1).status === 'success');

  // --- 2. collision: client reuses an id we still have in flight -----------
  const p2 = A.emit({ event: 'getInventory' });
  const firstId = rawIdOf(ws, ws.sent.length - 1);
  const before = ws.sent.length;
  ws.send(`42${firstId}["playerInput",{"event":"getPlayerMails"}]`);  // client clashes
  // our re-issue is emitted synchronously, before the client's frame is forwarded
  const ours = framesOf(ws).filter(f => f.event === 'getInventory' && f.id > firstId);
  const reissued = ours.length ? ours[ours.length - 1].id : firstId;
  check('collision triggers a re-issue', ws.sent.length > before && reissued > firstId,
        `first=${firstId} reissued=${reissued}`);
  check('re-issue is ordered before the clashing client frame',
        A.decodeFrame(ws.sent[ws.sent.length - 2]).id === reissued &&
        A.decodeFrame(ws.sent[ws.sent.length - 1]).id === firstId);
  ws.deliver(`43${reissued}[{"status":"success","data":[]}]`);
  check('re-issued request still resolves', (await p2).status === 'success');

  // --- 3. emitting before the handshake is refused -------------------------
  bus.ready = false;
  let refused = false;
  await A.emit({ event: 'getInventory' }).catch(e => { refused = /not connected/.test(e.message); });
  check('refuses to emit before CONNECT', refused);
  bus.ready = true;

  // --- 4. disconnect rejects everything in flight and stops the bot --------
  bot.running = true;
  const p4 = A.emit({ event: 'getInventory' });
  let rejected = null;
  p4.catch(e => { rejected = e.message; });
  ws.close();
  await sleep(5);
  check('pending rejected on disconnect', /closed/.test(rejected || ''), rejected);
  check('bot stopped on disconnect', bot.running === false);
  check('generation bumped', bus.generation > 0);

  // --- 5. full hack: attack -> words -> victory -> loot --------------------
  ws = connect();
  Object.assign(cfg, {
    wpm: 400, humanPauses: false, chatter: false, typoRate: 0,
    betweenHacks: [1, 2], targetMode: 'npc', port: 0, lootAction: 'take',
    autoAgents: false, autoAiMarket: false, maxSessionMinutes: 0
  });
  A.ocr.recognize = async img => ({ word: 'w' + img.slice(-1), segments: [], lineHash: 'h' });
  A.ocr.learn = async () => {};
  A.ocr.forget = async () => {};

  const words = [];
  let victory = false, lootTaken = false;
  const served = new Set();
  const serve = () => {
    for (let i = 0; i < ws.sent.length; i++) {
      if (served.has(i)) continue;
      served.add(i);
      const d = A.decodeFrame(ws.sent[i]);
      if (!d || !Array.isArray(d.payload)) continue;
      const req = d.payload[1];
      const reply = r => ws.deliver(`43${d.id}[${JSON.stringify(r)}]`);
      if (req.event === 'getClosestPlayersAndNPC')
        reply({ status: 'success', data: [{ id: 'npc1', username: 'bot-victim', isNpc: true }], npcList: [] });
      else if (req.event === 'attackNpcPort')
        reply({ status: 'success', profile: { id: 'npc1' }, tries_left: 5, image: 'AAAA1' });
      else if (req.event === 'sendWord') {
        words.push(req.word);
        if (words.length < 3) reply({ effect: 'success', progression: 30 * words.length, image: 'AAAA' + (words.length + 1) });
        else { victory = true; reply({ status: 'victory', effect: 'success', btcReward: 0.5, showLoot: true }); }
      } else if (req.event === 'takeAllLoot') { lootTaken = true; reply({ status: 'success', tookAll: true, inventory: [] }); }
      else reply({ status: 'success' });
    }
  };
  const pump = setInterval(serve, 2);

  bot.stats = { hacks: 0, wins: 0, losses: 0, words: 0, misses: 0, btc: 0, started: Date.now() };
  bot.start();
  const deadline = Date.now() + 4000;
  while (!victory && Date.now() < deadline) await sleep(10);
  bot.stop();
  while (bot.loopActive) await sleep(10);

  check('typed every word the server served', JSON.stringify(words) === '["w1","w2","w3"]', JSON.stringify(words));
  check('victory recorded', bot.stats.wins === 1);
  check('btc accumulated', Math.abs(bot.stats.btc - 0.5) < 1e-9);
  check('loot collected automatically', lootTaken);

  // --- 6. a rejected word is re-asked, not blindly resent ------------------
  words.length = 0;
  let asked = 0, misses = 0;
  A.ui.askWord = async () => { asked++; return 'correct'; };
  A.ocr.recognize = async () => ({ word: 'wrong', segments: [], lineHash: 'h' });
  clearInterval(pump);
  const pump2 = setInterval(() => {
    for (let i = 0; i < ws.sent.length; i++) {
      if (served.has(i)) continue;
      served.add(i);
      const d = A.decodeFrame(ws.sent[i]);
      if (!d || !Array.isArray(d.payload)) continue;
      const req = d.payload[1];
      const reply = r => ws.deliver(`43${d.id}[${JSON.stringify(r)}]`);
      if (req.event === 'getClosestPlayersAndNPC')
        reply({ status: 'success', data: [{ id: 'npc1', isNpc: true }], npcList: [] });
      else if (req.event === 'attackNpcPort')
        reply({ status: 'success', profile: {}, tries_left: 5, image: 'IMG' });
      else if (req.event === 'sendWord') {
        words.push(req.word);
        if (req.word === 'wrong') { misses++; reply({ effect: 'failed', tries_left: 4 }); }   // NO new image
        else reply({ status: 'victory', effect: 'success', btcReward: 0, showLoot: false });
      } else reply({ status: 'success' });
    }
  }, 2);

  bot.stats.wins = 0;
  // Drive the guard instead of asserting the state it happens to be in. Only
  // "not running, previous loop still unwinding" reaches the second branch of
  // start(); the old assertion never called start() twice at all.
  bot.loopActive = true;
  bot.start();
  check('a second loop cannot start while one is unwinding',
        bot.running === false, `running=${bot.running}`);
  bot.loopActive = false;
  bot.start();
  const d2 = Date.now() + 4000;
  while (bot.stats.wins === 0 && Date.now() < d2) await sleep(10);
  bot.stop();
  while (bot.loopActive) await sleep(10);
  clearInterval(pump2);

  check('asked the user after a rejection', asked === 1, `asked=${asked}`);
  check('did not resend the misread word', words.filter(w => w === 'wrong').length === 1, JSON.stringify(words));
  check('retried with the corrected word', words.includes('correct'), JSON.stringify(words));

  // --- 7. timing model -----------------------------------------------------
  cfg.humanPauses = true; cfg.wpm = 80;
  const samples = Array.from({ length: 400 }, () => bot.wordDelay('firewall'));
  const uniq = new Set(samples.map(Math.round)).size;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  check('delays are not constant', uniq > 300, `${uniq} distinct`);
  check('mean is in the right ballpark for 80 wpm', mean > 700 && mean < 2600, `mean=${Math.round(mean)}ms`);
  cfg.wpm = 160;
  const fast = Array.from({ length: 400 }, () => bot.wordDelay('firewall'))
                    .reduce((a, b) => a + b, 0) / 400;
  check('doubling wpm roughly halves the time', fast < mean * 0.75, `${Math.round(mean)} -> ${Math.round(fast)}`);

  // --- 8. typo model -------------------------------------------------------
  cfg.typoRate = 1;
  const typo = bot.maybeTypo('firewall', 5);
  check('typo differs from the word', typo && typo !== 'firewall', String(typo));
  check('no typo when tries run low', bot.maybeTypo('firewall', 2) === null);
  cfg.typoRate = 0;
  check('no typo when disabled', bot.maybeTypo('firewall', 5) === null);

  // --- 9. the console builds and renders on every tab --------------------
  window.open = () => mockWindow();
  A.panel.open();
  check('console opens', A.panel.live() === true);
  let threw = null;
  try {
    for (const tab of ['dash', 'charts', 'ocr', 'socket', 'config', 'log']) {
      A.panel.select(tab);
      A.panel.render();
    }
  } catch (e) { threw = e; }
  check('every tab renders without throwing', threw === null, threw && threw.stack);

  // a closed popup must tear the render loop down, not spin on a dead window
  A.panel.win.closed = true;
  A.panel.render();
  check('render stops when the popup is closed', A.panel.win === null && A.panel.timer === null);

  // --- 10. askWord routes to the console, falls back to the page ----------
  let viaPanel = 0, viaPage = 0;
  A.ui.askWord = realAskWord;          // restore the real dispatch
  A.panel.askWord = async () => { viaPanel++; return 'x'; };
  A.ui.fallbackAskWord = async () => { viaPage++; return 'x'; };
  await A.ui.askWord('data:,', null);
  check('falls back to the page when the console is shut', viaPage === 1 && viaPanel === 0);
  window.open = () => mockWindow();
  A.panel.open();
  await A.ui.askWord('data:,', null);
  check('uses the console when it is open', viaPanel === 1 && viaPage === 1);
  A.panel.close();

  // --- 11. config schema ---------------------------------------------------
  const missing = A.SCHEMA.filter(f => !(f.key in A.cfg)).map(f => f.key);
  check('every schema key exists in the config', missing.length === 0, missing.join(', '));
  const portField = A.SCHEMA.find(f => f.key === 'port');
  check('port reads back as a number',
        portField.read('2') === 2 && portField.read('random') === 'random');
  const typoField = A.SCHEMA.find(f => f.key === 'typoRate');
  check('typo rate round-trips through the control',
        Math.abs(typoField.read(typoField.write(0.03)) - 0.03) < 1e-9);

  // --- 12. ring buffers stay bounded --------------------------------------
  for (let i = 0; i < 5000; i++) A.bot.record({ kind: 'word', ms: 100, len: 5, ok: true });
  check('history stays capped', A.bot.history.length === 2000, String(A.bot.history.length));
  for (let i = 0; i < 600; i++) ws.deliver('42["event",{"event":"noop","arguments":[]}]');
  check('socket trace stays capped', bus.trace.length === 400, String(bus.trace.length));

  // --- 13. the trace must never hold a word image -------------------------
  const big = 'B'.repeat(6000);
  const p13 = A.emit({ event: 'sendWord', word: 'x' });
  const bigId = A.decodeFrame(ws.sent[ws.sent.length - 1]).id;
  ws.deliver(`43${bigId}[{"effect":"success","image":"${big}"}]`);
  await p13;
  const tainted = bus.trace.filter(e => JSON.stringify(e).includes('BBBBBBBBBBBBBBBB'));
  check('base64 payloads never reach the trace', tainted.length === 0,
        `${tainted.length} tainted entries`);
  const biggest = Math.max(...bus.trace.map(e => JSON.stringify(e).length));
  check('trace entries stay small', biggest < 400, `largest ${biggest} bytes`);
  check('the redacted size is still reported',
        bus.trace.some(e => /<6000 B>/.test(e.summary)));

  // --- 14. a stored glyph can be drawn back exactly ------------------------
  const bits = Uint8Array.from([1,0,1, 0,1,0, 1,1,1]);
  const hex = A.ocr.bitsToHex(bits);
  const back = A.ocr.hexToBits(hex, 9);
  check('glyph bitmap round-trips for the OCR tab',
        Array.from(back).join('') === Array.from(bits).join(''));

  // --- 15. transport readiness -------------------------------------------
  // Regression: readiness used to require the socket.io CONNECT packet, which
  // a polling-first session never sends over the websocket. START was then
  // permanently refused with "no live socket yet" on a perfectly good game.
  bus.ready = false; bus.ws = null; bus.connected = false;
  const upgraded = connect();
  check('a polling-first upgrade marks the socket live', bus.ready === true);
  check('the socket is usable straight after the upgrade', bus.ws === upgraded);

  bus.ready = false; bus.ws = null;
  const wsFirst = connect('websocket-first');
  check('a websocket-first session is live on CONNECT', bus.ready === true && bus.ws === wsFirst);

  // traffic alone is enough, even if the probe was missed entirely
  bus.ready = false; bus.ws = null;
  new WebSocket('wss://s0urce.io/socket.io/?EIO=4&transport=websocket');
  const late = MockWS.last;
  check('a socket attached mid-session is not live yet', bus.ready === false);
  late.deliver('42["event",{"event":"noop","arguments":[]}]');
  check('any message frame marks it live', bus.ready === true);

  // --- 16. the console shortcut must survive a non-QWERTY layout ----------
  const L = A.hotkeyLetter;
  check('qwerty: A resolves to a', L({ key: 'a', code: 'KeyA' }) === 'a');
  check('azerty: A resolves to a (code says KeyQ)', L({ key: 'a', code: 'KeyQ' }) === 'a');
  check('azerty: Q is not mistaken for A', L({ key: 'q', code: 'KeyA' }) === 'q');
  check('qwerty: S resolves to s', L({ key: 's', code: 'KeyS' }) === 's');
  check('altgr symbol falls back to the physical key', L({ key: '\u00e6', code: 'KeyA' }) === 'a');
  check('dead key falls back to the physical key', L({ key: 'Dead', code: 'KeyS' }) === 's');
  check('unmapped key yields nothing', L({ key: 'Shift', code: 'ShiftLeft' }) === '');

  // --- 17. requests are spaced out -----------------------------------------
  // Four different events have timed out at the tail of a burst across real
  // sessions; the pacing is the experiment that tests the "server drops bursts"
  // reading of that. It must be off by default in the suites.
  ws = connect();
  cfg.minRequestGap = 0;
  let sentBefore = ws.sent.length;
  await Promise.all([A.emit({ event: 'a' }), A.emit({ event: 'b' }), A.emit({ event: 'c' })]
    .map(p => p.catch(() => {})));
  await sleep(30);
  check('with no pacing, requests go out immediately',
        ws.sent.length - sentBefore === 3, String(ws.sent.length - sentBefore));

  cfg.minRequestGap = 120;
  sentBefore = ws.sent.length;
  const t0 = Date.now();
  [A.emit({ event: 'x' }), A.emit({ event: 'y' }), A.emit({ event: 'z' })].forEach(p => p.catch(() => {}));
  await sleep(500);
  const elapsedForThree = Date.now() - t0;
  check('with pacing, the three requests are spread out',
        ws.sent.length - sentBefore === 3 && elapsedForThree >= 240,
        `${ws.sent.length - sentBefore} requests in ${elapsedForThree} ms`);
  const ids = framesOf(ws).slice(-3).map(f => f.id);
  check('and the ack ids stay in send order',
        ids[0] < ids[1] && ids[1] < ids[2], JSON.stringify(ids));
  cfg.minRequestGap = 0;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
