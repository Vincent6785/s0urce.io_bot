const { MockWS, mockWindow } = require('./env.js');
const fs = require('fs');

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
  // A slow runner would otherwise fail the four result assertions below with
  // a truncated word list, hiding the single real cause.
  check('the hack completed within the deadline', victory, `victory=${victory}`);
  bot.stop();
  while (bot.loopActive) await sleep(10);

  check('typed every word the server served', JSON.stringify(words) === '["w1","w2","w3"]', JSON.stringify(words));
  check('victory recorded', bot.stats.wins === 1);
  check('btc accumulated', Math.abs(bot.stats.btc - 0.5) < 1e-9);
  check('loot collected automatically', lootTaken);

  // --- 6. a rejected word is re-asked, and each word logs exactly one line --
  words.length = 0;
  let asked = 0, misses = 0;
  A.ui.askWord = async () => { asked++; return 'correct'; };
  // The oracle reads before the prompt is ever shown, so failing the dictionary
  // and letting the oracle answer once stages both sources inside one hack:
  // the engine gets it wrong, you get it right.
  A.ocr.recognize = async () => ({ word: null, partial: '', segments: [], lineHash: 'h' });
  // Wrong once, silent once so the prompt is reached exactly once, then right
  // for good: the loop starts another hack before stop() lands, and without the
  // third branch that hack would reach the prompt too and break `asked === 1`.
  let askCalls = 0;
  A.oracle.ask = async () => {
    askCalls++;
    if (askCalls === 1) return { engine: 'glm-ocr', text: 'wrong' };
    if (askCalls === 2) return null;
    return { engine: 'glm-ocr', text: 'correct' };
  };
  // Nothing else tests WHEN a feedback line is emitted -- only its shape, by
  // calling report() directly. env.js seeds oracleEnabled false, so this path
  // is otherwise dead in every integration run; that is why it is flipped on
  // here and driven through a real hack.
  const feedback = [];
  const savedFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/feedback')) feedback.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({}) };
  };
  cfg.oracleEnabled = true;
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
  // The same call twice, with loopActive as the only difference: `running ===
  // false` alone would also pass if start() had bailed for any of its other
  // three reasons.
  bot.loopActive = true;
  bot.start();
  const heldBack = bot.running === false;
  bot.loopActive = false;
  bot.start();
  check('a second loop cannot start while one is unwinding',
        heldBack && bot.running === true,
        `heldBack=${heldBack} thenStarted=${bot.running}`);
  const d2 = Date.now() + 4000;
  while (bot.stats.wins === 0 && Date.now() < d2) await sleep(10);
  check('the retried hack completed within the deadline', bot.stats.wins > 0,
        `wins=${bot.stats.wins}`);
  bot.stop();
  while (bot.loopActive) await sleep(10);
  clearInterval(pump2);

  cfg.oracleEnabled = false;
  global.fetch = savedFetch;

  check('asked the user after a rejection', asked === 1, `asked=${asked}`);
  check('did not resend the misread word', words.filter(w => w === 'wrong').length === 1, JSON.stringify(words));
  check('retried with the corrected word', words.includes('correct'), JSON.stringify(words));

  // Holds however many hacks the loop got through before stop(): what matters
  // is that no line carries a word nobody confirmed.
  check('every logged line is a verdict, never a claim about the real word',
        feedback.length >= 2 &&
        feedback.every(f => !('word' in f) && !('confirmed' in f)),
        JSON.stringify(feedback));
  check('the engine is logged against the reading it actually produced',
        !!feedback[0] && feedback[0].engine === 'glm-ocr' &&
        feedback[0].reading === 'wrong' && feedback[0].accepted === false,
        JSON.stringify(feedback[0]));
  check('the word you typed is logged as yours, and as accepted',
        !!feedback[1] && feedback[1].engine === 'user' &&
        feedback[1].reading === 'correct' && feedback[1].accepted === true,
        JSON.stringify(feedback[1]));

  // --- 6b. two promises the log makes that phase 6 cannot stage ------------
  // (a) a word the dictionary reads alone consults no engine, so it must log
  // nothing at all; (b) a fumble of our own must never be blamed on one.
  const fb2 = [];
  const savedFetch2 = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/feedback')) fb2.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({}) };
  };
  cfg.oracleEnabled = true;
  let askedEngine = 0, won3 = false, sentWords = [];
  A.oracle.ask = async () => { askedEngine++; return null; };
  A.ocr.recognize = async () => ({ word: 'w1', segments: [], lineHash: 'h' });
  // `served` is reused deliberately: a fresh set would replay every frame the
  // earlier phases already sent.
  const pump3 = setInterval(() => {
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
        sentWords.push(req.word);
        if (req.word === 'typ0') reply({ effect: 'failed', tries_left: 4 });
        else { won3 = true; reply({ status: 'victory', effect: 'success', btcReward: 0, showLoot: false }); }
      } else reply({ status: 'success' });
    }
  }, 2);
  bot.stats.wins = 0;
  bot.start();
  let d3 = Date.now() + 4000;
  while (!won3 && Date.now() < d3) await sleep(10);
  bot.stop();
  while (bot.loopActive) await sleep(10);
  check('a word the dictionary read alone consults no engine and logs nothing',
        won3 && askedEngine === 0 && fb2.length === 0,
        `won=${won3} asked=${askedEngine} lines=${JSON.stringify(fb2)}`);

  // (b) deterministic fumble: a guard test must not itself be probabilistic.
  fb2.length = 0; sentWords = []; won3 = false;
  A.ocr.recognize = async () => ({ word: null, partial: '', segments: [], lineHash: 'h' });
  A.oracle.ask = async () => ({ engine: 'glm-ocr', text: 'correct' });
  const realTypo = bot.maybeTypo;
  let fumbles = 0;
  bot.maybeTypo = () => (++fumbles === 1 ? 'typ0' : null);
  bot.stats.wins = 0;
  bot.start();
  d3 = Date.now() + 4000;
  while (!won3 && Date.now() < d3) await sleep(10);
  bot.stop();
  while (bot.loopActive) await sleep(10);
  clearInterval(pump3);
  bot.maybeTypo = realTypo;
  cfg.oracleEnabled = false;
  global.fetch = savedFetch2;
  check('a fumble of our own is never logged against the engine',
        sentWords.includes('typ0') && won3 &&
        !fb2.some(f => f.accepted === false),
        `sent=${JSON.stringify(sentWords)} lines=${JSON.stringify(fb2)}`);

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

  // The per-engine counts only render when `engines` is non-empty, and every
  // other render test passes an empty map -- so this is the only assertion
  // that can see them.
  const dash = stats => {
    A.oracle.stats = stats;
    A.panel.select('dash'); A.panel.render();
    return A.panel.n && A.panel.n.stOracle && A.panel.n.stOracle.textContent;
  };
  check('the dashboard names which engine earned the answer',
        dash({ asked: 3, accepted: 2, rejected: 1, engines: { 'glm-ocr': 2 } }) === '2/3 (glm-ocr 2)',
        String(dash({ asked: 3, accepted: 2, rejected: 1, engines: { 'glm-ocr': 2 } })));
  check('with no engine recorded it shows the bare ratio, not empty brackets',
        dash({ asked: 3, accepted: 2, rejected: 1, engines: {} }) === '2/3',
        String(dash({ asked: 3, accepted: 2, rejected: 1, engines: {} })));
  check('and a dash before the oracle has ever been asked',
        dash({ asked: 0, accepted: 0, rejected: 0, engines: {} }) === '\u2014',
        String(dash({ asked: 0, accepted: 0, rejected: 0, engines: {} })));

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
  // Fire and forget, like the paced block below. Nothing acks these, so
  // awaiting them would wait out three 20 s request deadlines. The claim is
  // about frames reaching the wire, which is observable at once.
  [A.emit({ event: 'a' }), A.emit({ event: 'b' }), A.emit({ event: 'c' })]
    .forEach(p => p.catch(() => {}));
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
