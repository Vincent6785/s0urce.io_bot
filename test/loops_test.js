// Housekeeping loops driven against a scriptable mock server.
const { MockWS } = require('./env.js');
const fs = require('fs'), path = require('path');
eval(fs.readFileSync(path.join(__dirname, '..', 's0urce-autohack.user.js'), 'utf8'));

const A = window.__autohack;
const { bot, cfg, wallet } = A;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name +
              (cond || extra === undefined ? '' : `\n      ${extra}`));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('unhandledRejection', e => console.log('UNHANDLED: ' + e.message));

// --- scriptable server ------------------------------------------------------
function server() {
  new WebSocket('wss://s0urce.io/socket.io/?EIO=4&transport=websocket&sid=x');
  const ws = MockWS.last;
  ws.send('2probe'); ws.deliver('3probe'); ws.send('5');   // real upgrade sequence
  const seen = [], routes = {}, served = new Set();
  const pump = setInterval(() => {
    for (let i = 0; i < ws.sent.length; i++) {
      if (served.has(i)) continue;
      served.add(i);
      const d = A.decodeFrame(ws.sent[i]);
      if (!d || !Array.isArray(d.payload) || d.payload[0] !== 'playerInput') continue;
      const req = d.payload[1];
      seen.push(req);
      const h = routes[req.event];
      const r = h ? h(req) : { status: 'success' };
      if (r !== undefined) ws.deliver(`43${d.id}[${JSON.stringify(r)}]`);
    }
  }, 1);
  return { ws, seen, routes, stop: () => clearInterval(pump) };
}
const sentEvents = s => s.seen.map(r => r.event);
const only = (s, ev) => s.seen.filter(r => r.event === ev);

// an inventory snapshot payload with `n` copies of one item plus free slots
// Equipment and machine slots (gpu, upgrader_*, ai_sell…) travel in this payload
// next to the inventory map. Earlier mocks put them in player_profile — where the
// client never reads them — and the tests passed while the real loops could not.
function inventory(items, freeCount, slots) {
  const map = {};
  items.forEach((it, i) => { map['slot_' + i] = it; });
  for (let i = 0; i < freeCount; i++) map['generatedSlot' + i] = null;
  return { status: 'success',
           data: Object.assign({ inventory: map, inventorySlots: items.length + freeCount }, slots || {}) };
}
const gear = (id, type, rarity, extra) =>
  Object.assign({ id, name: id, type, rarity, upgradePrice: 1, upgradeLevel: 1 }, extra || {});

(async () => {
  bot.running = true;

  // --- 1. idle agents: the payload really uses filamentAgent/componentAgent --
  let s = server();
  s.routes.checkAgentLoot = () => ({
    status: 'success',
    player_agents: {
      filamentAgent: { level: 1, nextUpdateCost: 5, levelProgression: 0, elapsed: 10 },
      componentAgent: { level: 1, nextUpdateCost: 999, levelProgression: 0, elapsed: 10 },
      // the real payload nests these inside player_agents
      currentFilament: 7, maxFilament: 10, componentLoot: [{ id: 'comp1' }]
    }
  });
  s.routes.claimFilamentLoot = () => ({ status: 'success', filament: { D: 7 } });
  s.routes.claimComponentLoot = () => ({ status: 'success', player_inventory: {} });
  s.routes.levelUpFilamentAgent = () => ({ status: 'success', player_agents: {}, btcUpdate: { btc: 95, btcPerSecond: 0 } });
  wallet.absorb({ btc: 100, btcPerSecond: 0 });
  cfg.autoLevelAgents = true;
  await bot.doAgents();
  await sleep(20);
  check('filament agent loot is claimed', only(s, 'claimFilamentLoot').length === 1,
        sentEvents(s).join(', '));
  check('component agent loot is claimed', only(s, 'claimComponentLoot').length === 1);
  check('affordable agent level-up is taken', only(s, 'levelUpFilamentAgent').length === 1);
  check('unaffordable one is skipped', only(s, 'levelUpComponentAgent').length === 0);
  s.stop();

  // component loot when the inventory is full falls back to shredding
  s = server();
  s.routes.checkAgentLoot = () => ({ status: 'success',
    player_agents: { currentFilament: 0, componentLoot: [{ id: 'c' }] } });
  s.routes.claimComponentLoot = () => ({ status: 'error', message: 'Not enough space' });
  cfg.autoLevelAgents = false;
  await bot.doAgents();
  await sleep(20);
  check('full component loot is shredded instead', only(s, 'shredComponentLoot').length === 1,
        sentEvents(s).join(', '));
  s.stop();

  // --- 2. mail --------------------------------------------------------------
  s = server();
  s.routes.getPlayerMails = () => ({ status: 'success', mails: [
    { id: 1, read: false, claimed_reward: false, rewards: '{"btc":1}' },   // JSON string
    { id: 2, read: true, claimed_reward: true, rewards: '{"btc":1}' },     // already done
    { id: 3, read: true, claimed_reward: false, rewards: '{}' }            // nothing in it
  ] });
  s.routes.claimMailRewards = () => ({ rewards: { btcUpdate: { btc: 101, btcPerSecond: 0 } } });
  await bot.doMail();
  await sleep(20);
  check('unread mail is marked read', only(s, 'markMailAsRead').map(r => r.mailId).join() === '1',
        only(s, 'markMailAsRead').map(r => r.mailId).join());
  check('only the unclaimed, non-empty reward is claimed',
        only(s, 'claimMailRewards').map(r => r.mailId).join() === '1',
        only(s, 'claimMailRewards').map(r => r.mailId).join());
  s.stop();

  // --- 3. season pass -------------------------------------------------------
  s = server();
  bot.premium = false;
  s.routes.getSeasonPassData = () => ({ status: 'success',
    data: { seasonLevel: 3, seasonClaims: { 1: true } },
    season_rewards: { 1: { freePlayer: true }, 2: { freePlayer: true }, 3: { freePlayer: false } } });
  s.routes.claimSeasonPassReward = () => ({ status: 'success', inventory: {} });
  await bot.doSeasonPass();
  await sleep(20);
  check('claims only the reached, unclaimed, free tier',
        only(s, 'claimSeasonPassReward').map(r => r.id).join() === '2',
        only(s, 'claimSeasonPassReward').map(r => r.id).join());
  s.stop();

  // --- 4. upgrader ----------------------------------------------------------
  const four = [gear('a', 'gpu', 'rare'), gear('b', 'gpu', 'rare'),
                gear('c', 'gpu', 'rare'), gear('d', 'gpu', 'rare')];
  s = server();
  let snapCall = 0;
  s.routes.getInventory = () => { snapCall++; return inventory(four, 2); };
  s.routes.upgradeItem = () => ({ status: 'success', upgrader_0: gear('merged', 'gpu', 'epic'),
                                  btcUpdate: { btc: 99, btcPerSecond: 0 } });
  wallet.absorb({ btc: 100, btcPerSecond: 0 });
  await bot.doUpgrade();
  await sleep(20);
  const moves = only(s, 'moveItem');
  check('four items are loaded into the upgrader',
        moves.slice(0, 4).map(m => m.goalSlot).join() === 'upgrader_0,upgrader_1,upgrader_2,upgrader_3',
        moves.map(m => m.goalSlot).join());
  check('sources are inventory slots, never equipment',
        moves.slice(0, 4).every(m => /^slot_/.test(m.dragSlot)));
  check('the merge is requested', only(s, 'upgradeItem').length === 1);
  check('the result is moved back out of the machine',
        moves.length === 5 && moves[4].dragSlot === 'upgrader_0' && moves[4].dragID === 'merged',
        JSON.stringify(moves[4]));
  s.stop();

  // three of a kind, or no money: nothing happens
  s = server();
  s.routes.getInventory = () => inventory(four.slice(0, 3), 2);
  await bot.doUpgrade(); await sleep(20);
  check('three matching items are not merged', only(s, 'upgradeItem').length === 0);
  s.stop();

  s = server();
  s.routes.getInventory = () => inventory(four.map(i => gear(i.id, 'gpu', 'rare', { upgradePrice: 500 })), 2);
  wallet.absorb({ btc: 1, btcPerSecond: 0 });
  await bot.doUpgrade(); await sleep(20);
  check('an unaffordable merge is skipped', only(s, 'upgradeItem').length === 0);
  s.stop();

  // --- 5. gear: keep an improvement, revert a regression ---------------------
  cfg.equipTrials = 4;
  const worn = gear('old', 'gpu', 'common');
  const cand = gear('new', 'gpu', 'epic');

  s = server();
  let stat = 10;
  s.routes.getComputerInfo = () => ({ status: 'success',
    player_stats: { hackDamage: stat, hackTrueDamage: 0, hackArmorPenetration: 0, hackCriticalDamageBonus: 0 } });
  s.routes.getInventory = () => inventory([cand], 2, { gpu: worn });
  s.routes.moveItem = () => { stat = 20; return { status: 'success' }; };   // it helped
  await bot.doEquip(); await sleep(20);
  check('an improvement is kept (no revert)', only(s, 'moveItem').length === 1,
        JSON.stringify(only(s, 'moveItem')));
  s.stop();

  s = server();
  stat = 10;
  s.routes.getComputerInfo = () => ({ status: 'success',
    player_stats: { hackDamage: stat, hackTrueDamage: 0, hackArmorPenetration: 0, hackCriticalDamageBonus: 0 } });
  s.routes.getInventory = () => inventory([cand], 2, { gpu: worn });
  s.routes.moveItem = () => { stat = 5; return { status: 'success' }; };    // it hurt
  await bot.doEquip(); await sleep(20);
  const back = only(s, 'moveItem');
  check('a regression is reverted', back.length === 2 && back[1].dragSlot === 'gpu' &&
        back[1].goalSlot === 'slot_0' && back[1].dragID === 'new', JSON.stringify(back));
  // the swap left the previously worn item in that inventory slot, so it is the
  // id at the destination — passing the candidate's id here would be wrong
  check('the revert names the displaced item as the destination',
        back[1].goalID === 'old', JSON.stringify(back[1]));
  s.stop();

  // --- 6. auto-shred sends deltas only --------------------------------------
  s = server();
  bot.lootShred = { common: false, uncommon: true, rare: false, epic: false };
  bot.shredAsked = {};
  Object.assign(cfg, { shredCommon: true, shredUncommon: true, shredRare: false, shredEpic: false });
  await bot.doAutoShred(); await sleep(20);
  const shred = only(s, 'changeAutoShredSetting');
  check('only the differing rarity is pushed',
        shred.length === 1 && shred[0].key === 'common' && shred[0].value === true,
        JSON.stringify(shred));
  await bot.doAutoShred(); await sleep(20);
  check('an unconfirmed request is not repeated',
        only(s, 'changeAutoShredSetting').length === 1);
  s.stop();

  // --- 7. items stranded in a machine are recovered -------------------------
  s = server();
  s.routes.getInventory = () => inventory([], 3, { upgrader_2: gear('stuck', 'gpu', 'rare') });
  await bot.freeStuckItems(); await sleep(20);
  const rescue = only(s, 'moveItem');
  check('a stranded item is moved back to the inventory',
        rescue.length === 1 && rescue[0].dragSlot === 'upgrader_2' && rescue[0].dragID === 'stuck',
        JSON.stringify(rescue));
  s.stop();

  // --- 8. wallet projects the balance forward -------------------------------
  wallet.absorb({ btc: 10, btcPerSecond: 100 });
  await sleep(120);
  const projected = wallet.now();
  check('balance accrues at btcPerSecond', projected > 10 && projected < 40,
        String(projected));
  check('affordability uses the projection', wallet.canAfford(10) === true);

  // --- 9. printer ids are learned from your own prints ----------------------
  s = server();
  bot.knownPrints.length = 0;
  s.ws.send('4210["playerInput",{"event":"printItem","id":"cable_x"}]');
  check('a manual print teaches its id', bot.knownPrints.join() === 'cable_x',
        bot.knownPrints.join());
  s.stop();

  // --- 9a. and the bot learns from the prints IT makes ---------------------
  // knownPrints is fed by watching the real client's frames; the bot's own
  // frames leave through rawSend and bypass that hook entirely, so this is a
  // separate path. Teaching a REFUSED id would be the worse regression: it
  // persists to localStorage and becomes the default for every later pass.
  const { store } = require('./env.js');
  s = server();
  bot.knownPrints.length = 0;
  Object.assign(cfg, { printItemId: 'cable_x', printerUpgrade: false });
  s.routes.printItem = () => ({ status: 'success', notification_success: true });
  await bot.doPrint();
  check('a print the bot made teaches its id too',
        bot.knownPrints.join() === 'cable_x', bot.knownPrints.join());
  check('and it is persisted, not merely held in memory',
        JSON.parse(store.get('s0urce_bot_prints') || '[]').join() === 'cable_x',
        String(store.get('s0urce_bot_prints')));
  await bot.doPrint();
  check('printing it again does not duplicate it', bot.knownPrints.length === 1,
        bot.knownPrints.join());
  s.stop();

  s = server();
  bot.knownPrints.length = 0;
  cfg.printItemId = 'bad_id';
  s.routes.printItem = () => ({ status: 'success', notification_error: 'no filament' });
  await bot.doPrint();
  check('a refused print teaches nothing', bot.knownPrints.length === 0,
        bot.knownPrints.join());
  s.stop();

  s = server();
  cfg.printItemId = '';
  bot.knownPrints.length = 0;
  await bot.doPrint();
  check('nothing configured and nothing learned: no print is attempted',
        only(s, 'printItem').length === 0, JSON.stringify(sentEvents(s)));
  s.stop();

  // --- 9b. fixes after a real session: requests the server never answers ---
  // Season pass: a reached tier with no reward entry is never claimed.
  s = server();
  bot.premium = false;
  s.routes.getSeasonPassData = () => ({ status: 'success',
    data: { seasonLevel: 4, seasonClaims: {} },
    season_rewards: { 2: { freePlayer: true }, 4: { freePlayer: false } } });
  s.routes.claimSeasonPassReward = () => ({ status: 'success', inventory: {} });
  await bot.doSeasonPass(); await sleep(20);
  check('a season pass tier with no reward is never claimed',
        only(s, 'claimSeasonPassReward').map(r => r.id).join() === '2',
        only(s, 'claimSeasonPassReward').map(r => r.id).join());
  s.stop();

  // AI market: nothing is asked while the ai_sell slot is empty.
  s = server();
  s.routes.getInventory = () => inventory([], 2);
  await bot.doAiMarket(); await sleep(20);
  check('AI market: an empty slot asks for no sale', only(s, 'sellToAiMarket').length === 0);
  s.routes.getInventory = () => inventory([], 2, { ai_sell: gear('junk', 'gpu', 'common') });
  s.routes.sellToAiMarket = () => ({ status: 'success', btcUpdate: { btc: 1, btcPerSecond: 0 } });
  await bot.doAiMarket(); await sleep(20);
  check('AI market: an item in the slot is sold', only(s, 'sellToAiMarket').length === 1);
  s.stop();

  // Stuck recovery reads the inventory payload, not player_profile.
  s = server();
  s.routes.getComputerInfo = () => ({ status: 'success', player_stats: {},
                                      player_profile: { upgrader_1: gear('ghost', 'gpu', 'rare') } });
  s.routes.getInventory = () => inventory([], 3);
  await bot.freeStuckItems(); await sleep(20);
  check('a slot present only in player_profile is ignored',
        only(s, 'moveItem').length === 0);
  s.stop();

  // An unanswered chore is paused, doubled, and cleared by a later success.
  const realSeason = bot.doSeasonPass;
  let seasonCalls = 0, seasonTimesOut = true;
  bot.doSeasonPass = async () => {
    seasonCalls++;
    if (seasonTimesOut) throw new Error('timeout on claimSeasonPassReward');
  };
  const savedCfg = Object.assign({}, cfg);
  Object.assign(cfg, { autoMail: false, autoSeasonPass: true, autoAgents: false, autoShredSync: false,
                       autoAiMarket: false, autoEquip: false, autoUpgrade: false, autoPrint: false });
  bot.choreBackoff = {};
  await bot.housekeeping();
  check('a chore with no reply is paused', !!bot.choreBackoff['season pass'] &&
        bot.choreBackoff['season pass'].ms === 5 * 60000, JSON.stringify(bot.choreBackoff));
  check('and the pause is announced in the log',
        A.ui.lines.some(l => /season pass: timeout on claimSeasonPassReward — paused 5 min/.test(l)));
  await bot.housekeeping();
  check('while paused, the chore is not run again', seasonCalls === 1, String(seasonCalls));
  bot.choreBackoff['season pass'].until = 0;          // pause elapsed
  await bot.housekeeping();
  check('another failure doubles the pause', bot.choreBackoff['season pass'].ms === 10 * 60000,
        JSON.stringify(bot.choreBackoff));
  seasonTimesOut = false; bot.choreBackoff['season pass'].until = 0;
  await bot.housekeeping();
  check('a success clears the pause', !bot.choreBackoff['season pass']);
  bot.doSeasonPass = realSeason;
  Object.assign(cfg, savedCfg);

  // The value, asserted directly. Waiting the 8 s out proved only "somewhere
  // between 7.5 and 12 s", and cost a fifth of the whole suite's runtime.
  bot.chore = 'probe';
  const choreTimeout = A.defaultTimeout();
  bot.chore = null;
  const idleTimeout = A.defaultTimeout();
  check('housekeeping gives up at 8 s, an ordinary request at 20 s',
        choreTimeout === 8000 && idleTimeout === 20000, `${choreTimeout} / ${idleTimeout}`);

  // And the mechanism, on an explicit short deadline so the suite never has
  // to live through either value.
  s = server();
  s.routes.getInventory = () => undefined;             // never answered
  const t0 = Date.now();
  let msg = null;
  await A.emit({ event: 'getInventory' }, 300).catch(e => { msg = e.message; });
  const waited = Date.now() - t0;
  check('an unanswered request gives up on its deadline',
        msg === 'timeout on getInventory' && waited >= 250 && waited < 3000,
        `${waited} ms, ${msg}`);
  s.stop();

  // Server refusals pushed as notifications now reach the log.
  s = server();
  s.ws.deliver('42["event",{"event":"newHoverNotification","arguments":[{"status":"error","message":"Target is on cooldown"}]}]');
  check('server notifications reach the log',
        A.ui.lines.some(l => /server error: Target is on cooldown/.test(l)));
  s.stop();

  // A failing target list surfaces as an error the loop can back off on.
  s = server();
  s.routes.getClosestPlayersAndNPC = () => undefined;  // never answered
  const pick = bot.pickTarget();
  await sleep(10);
  s.ws.close();                                          // rejects everything pending
  let pickErr = null;
  await pick.catch(e => { pickErr = e.message; });
  check('a failing target list surfaces as an error', pickErr === 'socket closed', String(pickErr));
  s.stop();

  // --- 10. housekeeping never runs during a hack, and the comment does -----
  bot.running = false;
  A.ocr.recognize = async () => ({ word: 'w', segments: [], lineHash: 'h' });
  A.ocr.learn = async () => {}; A.ocr.forget = async () => {};
  Object.assign(cfg, {
    wpm: 400, humanPauses: false, chatter: false, typoRate: 0, betweenHacks: [1, 2],
    targetMode: 'npc', port: 0, lootAction: 'none', autoMail: true, autoSeasonPass: false,
    autoAgents: false, autoAiMarket: false, autoEquip: false, autoUpgrade: false,
    autoPrint: false, autoShredSync: false, autoComment: true, commentText: 'gg|nice',
    housekeepingSeconds: 0, maxSessionMinutes: 0, autoLevelAgents: false
  });

  s = server();
  let words = 0, won = false;
  s.routes.getClosestPlayersAndNPC = () => ({ status: 'success',
    data: [{ id: 'npc1', username: 'v', isNpc: true }], npcList: [] });
  s.routes.attackNpcPort = () => ({ status: 'success', profile: {}, tries_left: 5, image: 'IMG' });
  s.routes.sendWord = () => {
    words++;
    if (words < 3) return { effect: 'success', progression: 30 * words, image: 'IMG' + words };
    won = true;
    return { status: 'victory', effect: 'success', btcReward: 0.1, showLoot: false };
  };
  s.routes.getPlayerMails = () => ({ status: 'success', mails: [] });

  bot.start();
  const deadline = Date.now() + 5000;
  while (!won && Date.now() < deadline) await sleep(10);
  // Without this, a slow runner reports three confusing failures about
  // truncated event lists instead of the one true cause.
  check('the hack completed within the deadline', won, `won=${won}`);
  bot.stop();
  while (bot.loopActive) await sleep(10);
  await sleep(30);

  const order = sentEvents(s);
  const attackAt = order.indexOf('attackNpcPort');
  const lastWordAt = order.lastIndexOf('sendWord');
  const mailDuring = order.slice(attackAt, lastWordAt)
                          .filter(e => e === 'getPlayerMails').length;
  check('housekeeping never interleaves with a hack', mailDuring === 0,
        order.slice(attackAt, lastWordAt + 1).join(', '));
  check('housekeeping did run around the hack', order.includes('getPlayerMails'),
        order.join(', '));
  const comments = only(s, 'addCommentToTarget');
  check('a comment is left after a win',
        comments.length === 1 && ['gg', 'nice'].includes(comments[0].description),
        JSON.stringify(comments));
  s.stop();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
