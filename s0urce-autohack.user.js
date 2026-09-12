// ==UserScript==
// @name         s0urce.io — Auto Hack
// @namespace    https://github.com/Vincent6785
// @version      1.0.0
// @description  Full gameplay automation for s0urce.io: target selection, port attack, word OCR + typing, loot handling, idle-agent claiming. Self-training image OCR (the game sends every word as a PNG).
// @author       Anatacker
// @license      MIT
// @match        https://s0urce.io/*
// @match        https://www.s0urce.io/*
// @run-at       document-start
// @grant        none
// @icon         https://s0urce.io/favicon.ico
// @homepageURL  https://github.com/Vincent6785/s0urce.io_bot
// @supportURL   https://github.com/Vincent6785/s0urce.io_bot/issues
// @downloadURL  https://raw.githubusercontent.com/Vincent6785/s0urce.io_bot/main/s0urce-autohack.user.js
// @updateURL    https://raw.githubusercontent.com/Vincent6785/s0urce.io_bot/main/s0urce-autohack.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * HOW IT WORKS
 * ---------------------------------------------------------------------------
 * s0urce.io talks to its server with socket.io v4 over a single event:
 *
 *     socket.emit("playerInput", { event: "<name>", ...args }, ack => ...)
 *
 * The interesting ones:
 *     getClosestPlayersAndNPC              -> { data: [targets], npcList: [...] }
 *     attackPort    {id,isNpc,port}        -> { profile, image, tries_left }
 *     attackNpcPort {id,isNpc,port}        -> same (NPC variant)
 *     sendWord      {word,debug_free_premium}
 *                                          -> { effect, image, progression,
 *                                               tries_left, status, btcReward, ... }
 *     takeAllLoot / sellAllLoot / filamentAllLoot
 *     checkAgentLoot / claimFilamentLoot / claimComponentLoot
 *     sellToAiMarket / rerollNPC
 *
 * The word you must type is NEVER sent as text — it arrives as a base64 PNG in
 * `image`. That is the game's anti-bot measure, so this script carries a small
 * self-training OCR:
 *
 *   1. The image is decoded to a bitmap, the background colour is detected from
 *      the border pixels and the glyphs are cut apart on empty pixel columns.
 *   2. Each glyph bitmap becomes a key -> character entry in a dictionary kept
 *      in localStorage. Once a character has been seen once it is known forever.
 *   3. The dictionary is filled two ways:
 *        - passively: while YOU play normally, the script watches the real
 *          client's own `sendWord` frames and pairs the word you typed with the
 *          image that was on screen (only when the server answers "success").
 *        - actively: if the bot meets an unknown glyph it pauses and shows the
 *          image, you type it once, and it learns.
 *      After ~3-5 words the whole alphabet is usually covered and it never asks
 *      again.
 *
 * The bot then drives the game at the socket level (same messages the real
 * client sends), with a configurable words-per-minute so the server-side WPM
 * stat stays plausible.
 *
 * NOTE: while the bot runs, the game's own windows are not kept in sync (BTC,
 * inventory, terminal). Refresh the page to resync the UI. Don't play manually
 * and run the bot at the same time.
 * ---------------------------------------------------------------------------
 */

(function () {
    'use strict';
    if (window.top !== window.self) return;

    /* ======================================================================
     * 0. Small helpers
     * ==================================================================== */

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = (a, b) => a + Math.random() * (b - a);

    // Letters that touch are segmented as a single blob ("mS" in victimSupport),
    // so one unreadable segment may hide up to this many characters. Seen in a
    // real session: victi…upport, e…il…mpromised and t…st…p hid 1, 2 and 3.
    const MAX_MERGE = 3;

    // Pattern -> anchored RegExp, each hole standing for 1..width characters.
    function patternRegex(pattern, holeChar, width) {
        let src = '^';
        for (const ch of pattern) {
            src += ch === holeChar ? `.{1,${width}}` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        return new RegExp(src + '$');
    }
    // Box-Muller: human inter-key intervals are roughly lognormal, a flat
    // uniform jitter is a recognisable machine signature.
    const lognormal = (median, sigma) => {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return median * Math.exp(sigma * z);
    };
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const now = () => Date.now();

    const LS = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (e) { return fallback; }
        },
        set(key, value) {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
        }
    };

    const K_CFG = 's0urce_bot_cfg';
    const K_GLYPHS = 's0urce_bot_glyphs';
    const K_WORDS = 's0urce_bot_words';

    /* ======================================================================
     * 1. Configuration
     * ==================================================================== */

    const DEFAULTS = {
        targetMode: 'npc',        // 'npc' | 'players' | 'any'
        port: 'random',           // 0 | 1 | 2 | 'random'
        wpm: 95,                  // typing speed the bot simulates
        betweenHacks: [1200, 2600], // ms pause after a finished hack
        lootAction: 'take',       // 'take' | 'sell' | 'filament' | 'none'
        sellOverflow: true,       // sell the loot that did not fit in the inventory
        autoAgents: true,         // claim filament / component idle agents
        autoAiMarket: true,       // sell the item placed in the AI market slot, if any
        autoReroll: false,        // reroll the NPC list when nothing is attackable
        stopOnUnknown: false,     // true = stop instead of asking when OCR fails

        // --- stealth ---
        humanPauses: true,        // lognormal keystrokes, hesitations, short breaks
        chatter: true,            // mirror the side requests the real client makes
        typoRate: 0,              // 0..0.05 — deliberate misses. COSTS TRIES, opt-in.
        maxSessionMinutes: 0,     // auto-stop after N minutes (0 = never)
        minRequestGap: 250,       // ms between requests; 0 disables the pacing

        // --- robustness ---
        autoReload: false,        // reload the page when the server drops us

        // --- housekeeping (between hacks, never during one) ---
        housekeepingSeconds: 60,
        autoMail: true,
        autoSeasonPass: true,
        autoLevelAgents: true,    // spends BTC
        autoShredSync: true,      // push the auto-shred rarities to the server
        shredCommon: true,
        shredUncommon: true,
        shredRare: false,
        shredEpic: false,
        autoEquip: true,
        equipTrials: 6,           // gear swaps attempted per pass (2 requests each)
        autoUpgrade: true,        // merge 4 identical items, spends BTC
        autoPrint: false,
        printerUpgrade: false,
        printItemId: '',
        autoComment: true,
        commentText: 'gg|nice setup|good game|well played',

        // --- OCR oracle (local server, see ocr-server/) ---
        oracleEnabled: true,      // harmless when the server is down: it stands
                                  // down after one failure and asks you instead
        oracleUrl: 'http://127.0.0.1:8787/ocr',
        // Measured: glm-ocr answers in ~46 ms per word on a GPU. The ceiling is
        // not sized for that case but for the bad ones — a first load takes
        // seconds, and the previous default needed ~27 s per word on CPU. A
        // ceiling costs nothing when the answer is fast, whereas one below the
        // model's latency means the model never answers at all.
        oracleTimeoutMs: 40000,

        // --- interface ---
        consoleGeom: { w: 1080, h: 720, x: 80, y: 60 },
        debug: false              // expose window.__autohack on the game page
    };

    // Declarative description of everything the console can configure. The
    // Config tab and its bindings are generated from this, so adding a setting
    // is one entry here instead of three edits that can drift apart.
    const SCHEMA = [
        { key: 'targetMode', group: 'Targeting', label: 'targets', type: 'select',
          options: [['npc', 'NPCs only'], ['players', 'players only'], ['any', 'anything']] },
        { key: 'port', group: 'Targeting', label: 'port', type: 'select',
          options: [['random', 'random'], ['0', '0'], ['1', '1'], ['2', '2']],
          read: v => (v === 'random' ? 'random' : Number(v)) },
        { key: 'autoReroll', group: 'Targeting', label: 'reroll NPC list', type: 'bool',
          help: 'reroll when nothing is attackable' },

        { key: 'wpm', group: 'Typing', label: 'WPM', type: 'number', min: 20, max: 400,
          help: 'the server records this and shows it to your victims' },
        { key: 'humanPauses', group: 'Typing', label: 'human pauses', type: 'bool',
          help: 'lognormal keystrokes, hesitations, short breaks' },
        { key: 'typoRate', group: 'Typing', label: 'typo rate %', type: 'number',
          min: 0, max: 5, step: 0.5, help: 'deliberate misses — every one costs a try',
          read: v => clamp(Number(v) || 0, 0, 5) / 100, write: v => (v * 100).toFixed(1) },

        { key: 'lootAction', group: 'Loot', label: 'loot', type: 'select',
          options: [['take', 'take all'], ['sell', 'sell all'], ['filament', 'shred all'], ['none', 'leave']] },
        { key: 'sellOverflow', group: 'Loot', label: 'sell overflow', type: 'bool',
          help: 'sell whatever did not fit in the inventory' },
        { key: 'autoAgents', group: 'Loot', label: 'idle agents', type: 'bool' },
        { key: 'autoAiMarket', group: 'Loot', label: 'AI market', type: 'bool',
          help: 'sells the item you drop in the AI market slot' },

        { key: 'minRequestGap', group: 'Stealth', label: 'gap between requests (ms)',
          type: 'number', min: 0, max: 2000,
          help: 'experiment: the server seems to ignore bursts; 0 disables' },
        { key: 'chatter', group: 'Stealth', label: 'client chatter', type: 'bool',
          help: 'also send the side requests the real client makes' },
        { key: 'maxSessionMinutes', group: 'Stealth', label: 'stop after (min)',
          type: 'number', min: 0, max: 1440, help: '0 = never' },

        { key: 'housekeepingSeconds', group: 'Housekeeping', label: 'every (seconds)',
          type: 'number', min: 15, max: 3600 },
        { key: 'autoMail', group: 'Housekeeping', label: 'mail rewards', type: 'bool' },
        { key: 'autoSeasonPass', group: 'Housekeeping', label: 'season pass', type: 'bool' },
        { key: 'autoLevelAgents', group: 'Housekeeping', label: 'level up agents', type: 'bool',
          help: 'spends BTC when affordable' },
        { key: 'autoComment', group: 'Housekeeping', label: 'comment after a win', type: 'bool' },
        { key: 'commentText', group: 'Housekeeping', label: 'comments', type: 'text',
          help: 'picked at random, separate with |' },

        { key: 'autoShredSync', group: 'Items', label: 'sync auto-shred', type: 'bool',
          help: "uses the game's own setting; confirmed on next reload" },
        { key: 'shredCommon', group: 'Items', label: '· shred common', type: 'bool' },
        { key: 'shredUncommon', group: 'Items', label: '· shred uncommon', type: 'bool' },
        { key: 'shredRare', group: 'Items', label: '· shred rare', type: 'bool' },
        { key: 'shredEpic', group: 'Items', label: '· shred epic', type: 'bool' },
        { key: 'autoEquip', group: 'Items', label: 'auto-equip gear', type: 'bool',
          help: 'measures hackDamage, reverts if it drops' },
        { key: 'equipTrials', group: 'Items', label: '· swaps per pass', type: 'number',
          min: 1, max: 30 },
        { key: 'autoUpgrade', group: 'Items', label: 'upgrader', type: 'bool',
          help: 'merges 4 identical items, spends BTC' },
        { key: 'autoPrint', group: 'Items', label: '3D printer', type: 'bool' },
        { key: 'printerUpgrade', group: 'Items', label: '· upgrade printer', type: 'bool' },
        { key: 'printItemId', group: 'Items', label: '· item to print', type: 'text',
          help: 'blank = the last id you printed by hand' },

        { key: 'oracleEnabled', group: 'OCR oracle', label: 'use the local oracle', type: 'bool',
          help: 'reads unknown words so the bot never waits for you' },
        { key: 'oracleUrl', group: 'OCR oracle', label: 'endpoint', type: 'text' },
        { key: 'oracleTimeoutMs', group: 'OCR oracle', label: 'timeout (ms)', type: 'number',
          min: 500, max: 60000 },

        { key: 'stopOnUnknown', group: 'Recovery', label: 'stop on unknown glyph', type: 'bool' },
        { key: 'autoReload', group: 'Recovery', label: 'reload on drop', type: 'bool' },
        { key: 'debug', group: 'Recovery', label: 'expose __autohack', type: 'bool',
          help: 'page-context global for debugging — applies on reload' }
    ];

    const cfg = Object.assign({}, DEFAULTS, LS.get(K_CFG, {}));
    // saveCfg stores the whole object, so anyone who ever touched a setting has
    // the old 6 s default saved — below the vision model's measured latency.
    // Only that exact value is migrated; anything else was chosen on purpose.
    if (cfg.oracleTimeoutMs === 6000) cfg.oracleTimeoutMs = DEFAULTS.oracleTimeoutMs;
    const saveCfg = () => LS.set(K_CFG, cfg);

    /* ======================================================================
     * 2. socket.io transport hook
     *
     * We wrap window.WebSocket before the page's bundle runs, grab the
     * socket.io connection and speak the protocol directly:
     *     outgoing event with ack :  42<ackId>["playerInput",{...}]
     *     incoming ack            :  43<ackId>[{...}]
     *     incoming server push    :  42["event",{event:"...",arguments:[...]}]
     *
     * Ack ids continue the real client's own sequence instead of jumping to
     * some private range: a vanilla client counts 0,1,2,… so a socket that
     * suddenly emits id 912345 is trivially separable server-side. We track the
     * highest id the client has used and stay just above it. The client is
     * behind us and will eventually reuse an id we already spent — if it does
     * so while one of ours is still in flight we re-issue ours under a fresh id
     * (see emit) so the two acks can never be confused.
     * ==================================================================== */

    const bus = {
        ws: null,
        rawSend: null,
        connected: false,
        ready: false,         // socket.io CONNECT seen on this connection
        generation: 0,        // bumped on every disconnect
        nextAck: 1,
        maxClientAck: 0,      // highest ack id the real client has used
        pending: new Map(),   // ackId -> {gen, resolve, reject, reissue, timer}
        outgoing: new Map(),  // ackId -> {event, word, image}   (ours + client's)
        lastImage: null,      // most recent word image seen on the wire
        listeners: [],        // server-push listeners
        lastSend: 0,          // when the last playerInput left, for pacing
        trace: [],            // recent frames, for the Socket tab
        traceSeq: 0           // bumped on every push so the UI can skip redraws
    };

    const TRACE_CAP = 400;

    // A single word image is several KB of base64 and one arrives per word, so
    // the trace stores a redacted digest — never the payload itself. Long
    // strings collapse to their size and the whole line is capped.
    function redact(value) {
        try {
            let out = JSON.stringify(value, (k, v) =>
                (typeof v === 'string' && v.length > 40) ? `<${v.length} B>` : v);
            if (!out) return '';
            return out.length > 220 ? out.slice(0, 219) + '…' : out;
        } catch (e) { return '<unserialisable>'; }
    }

    function traceAdd(entry) {
        bus.trace.push(entry);
        if (bus.trace.length > TRACE_CAP) bus.trace.splice(0, bus.trace.length - TRACE_CAP);
        bus.traceSeq++;
    }

    function allocAck() {
        if (bus.nextAck <= bus.maxClientAck) bus.nextAck = bus.maxClientAck + 1;
        return bus.nextAck++;
    }

    function dropPending(reason) {
        for (const [, p] of bus.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
        bus.pending.clear();
    }

    function decodeFrame(data) {
        if (typeof data !== 'string' || data.charCodeAt(0) !== 52 /* '4' */) return null;
        let rest = data.slice(1);
        const sioType = rest[0];
        rest = rest.slice(1);
        if (sioType === '5' || sioType === '6') {            // binary attachments
            const dash = rest.indexOf('-');
            if (dash !== -1) rest = rest.slice(dash + 1);
        }
        if (rest[0] === '/') {                                // explicit namespace
            const c = rest.indexOf(',');
            rest = c === -1 ? '' : rest.slice(c + 1);
        }
        let id = null;
        const m = /^\d+/.exec(rest);
        if (m) { id = parseInt(m[0], 10); rest = rest.slice(m[0].length); }
        let payload = null;
        if (rest) { try { payload = JSON.parse(rest); } catch (e) { return null; } }
        return { sioType, id, payload };
    }

    function noteImage(res) {
        if (res && typeof res.image === 'string' && res.image.length > 16) {
            bus.lastImage = 'data:image/png;base64,' + res.image;
            return bus.lastImage;
        }
        return null;
    }

    // Registers an outgoing playerInput so we can pair the eventual ack with it.
    function registerOutgoing(id, payload) {
        if (!payload || typeof payload !== 'object') return;
        bus.outgoing.set(id, { event: payload.event, word: payload.word, image: bus.lastImage });
        if (bus.outgoing.size > 200) {
            const first = bus.outgoing.keys().next().value;
            bus.outgoing.delete(first);
        }
    }

    function onIncoming(data) {
        // engine.io keeps the session on HTTP polling and only upgrades to this
        // socket afterwards, so the socket.io CONNECT packet ("40") is delivered
        // over XHR and is never seen here. Any message frame means the upgrade
        // completed and this transport is live.
        if (typeof data === 'string' && data.charCodeAt(0) === 52 && !bus.ready) {
            bus.ready = true;
            ui.status();
        }

        const f = decodeFrame(data);
        if (!f) return;

        if (f.sioType === '0') {              // CONNECT, on a websocket-first session
            bus.ready = true;
            ui.status();
            return;
        }

        if (f.sioType === '2' && Array.isArray(f.payload)) {           // server push
            const [name, arg] = f.payload;
            traceAdd({
                t: now(), dir: '<', src: 'server', kind: 'push', id: f.id,
                event: (arg && arg.event) || name, bytes: data.length,
                summary: redact(arg)
            });
            if (name === 'event' && arg && arg.event) {
                bus.listeners.forEach(fn => { try { fn(arg.event, arg.arguments || []); } catch (e) { } });
            }
            return;
        }

        if (f.sioType !== '3' || f.id === null) return;                // we want acks
        const res = Array.isArray(f.payload) ? f.payload[0] : f.payload;
        const req = bus.outgoing.get(f.id);
        bus.outgoing.delete(f.id);

        traceAdd({
            t: now(), dir: '<', src: 'server', kind: 'ack', id: f.id,
            event: (req && req.event) || '?', bytes: data.length, summary: redact(res)
        });

        // every response that moves the balance carries this
        if (res && res.btcUpdate) wallet.absorb(res.btcUpdate);
        if (res && res.player_progress && typeof res.player_progress.btc === 'number') {
            wallet.absorb({ btc: res.player_progress.btc, btcPerSecond: wallet.perSecond });
        }

        const wordEvents = ['attackPort', 'attackNpcPort', 'sendWord'];
        if (!req || wordEvents.indexOf(req.event) !== -1) noteImage(res);

        // Passive OCR training: the client (or the bot) typed `req.word` while
        // `req.image` was displayed, and the server accepted it.
        if (req && req.event === 'sendWord' && req.word && req.image && res &&
            (res.effect === 'success' || res.status === 'victory')) {
            ocr.learn(req.image, req.word).catch(() => { });
        }

        const p = bus.pending.get(f.id);
        if (p) {
            bus.pending.delete(f.id);
            clearTimeout(p.timer);
            p.resolve(res);
        }
    }

    function attachSocket(ws) {
        bus.ws = ws;
        bus.rawSend = ws.send.bind(ws);
        bus.connected = ws.readyState === 1;
        bus.ready = false;                    // new transport, not live until it upgrades

        ws.addEventListener('open', () => { bus.connected = true; ui.status(); });
        ws.addEventListener('message', ev => { try { onIncoming(ev.data); } catch (e) { } });
        ws.addEventListener('close', () => onDisconnect('socket closed'));
        ws.addEventListener('error', () => onDisconnect('socket error'));

        // Watch what the real client sends: it feeds passive OCR training and
        // keeps our ack ids in step with the client's own counter.
        ws.send = function (data) {
            try {
                // engine.io UPGRADE: from here on this socket is the transport
                if (data === '5' && !bus.ready) { bus.ready = true; ui.status(); }
                const f = decodeFrame(data);
                if (f && f.sioType === '2' && f.id !== null) {
                    if (f.id > bus.maxClientAck) bus.maxClientAck = f.id;
                    const clash = bus.pending.get(f.id);
                    if (clash) {                       // client reused a live id
                        bus.pending.delete(f.id);
                        clearTimeout(clash.timer);
                        clash.reissue();
                    }
                    if (Array.isArray(f.payload) && f.payload[0] === 'playerInput') {
                        registerOutgoing(f.id, f.payload[1]);
                        const p = f.payload[1] || {};
                        if (p.event === 'printItem' && p.id &&
                            bot.knownPrints.indexOf(p.id) === -1) {
                            bot.knownPrints.push(p.id);
                            LS.set('s0urce_bot_prints', bot.knownPrints);
                            ui.log(`learned printable item "${p.id}"`);
                        }
                        traceAdd({
                            t: now(), dir: '>', src: 'client', kind: 'emit', id: f.id,
                            event: (f.payload[1] || {}).event || '?',
                            bytes: data.length, summary: redact(f.payload[1])
                        });
                    }
                }
            } catch (e) { }
            return bus.rawSend(data);
        };

        ui.log('socket.io connection captured');
        ui.status();
    }

    // s0urce does not survive a dropped socket: its own handler tells you to
    // refresh, so reconnecting silently would just spin against a dead session.
    function onDisconnect(reason) {
        if (!bus.connected && !bus.ready) return;
        bus.connected = false;
        bus.ready = false;
        bus.generation++;
        dropPending(reason);
        if (bot.running) {
            bot.stop();
            ui.log(reason + ' — the game ends the session on disconnect, reload to continue');
        }
        if (cfg.autoReload) {
            ui.log('reloading in 5s (autoReload is on)');
            setTimeout(() => location.reload(), 5000);
        }
        ui.status();
    }

    const NativeWS = window.WebSocket;
    window.WebSocket = new Proxy(NativeWS, {
        construct(target, args) {
            const ws = new target(...args);
            try {
                if (/EIO=|socket\.io|engine\.io/i.test(String(args[0] || ''))) attachSocket(ws);
            } catch (e) { console.error('[autohack] hook failed', e); }
            return ws;
        }
    });

    // The server answers in milliseconds, and during housekeeping a missing
    // answer means it ignored the request (nothing to claim, nothing to sell).
    // Waiting 20 s for that on every pass stalled the whole loop.
    function defaultTimeout() {
        return (typeof bot !== 'undefined' && bot.chore) ? 8000 : 20000;
    }

    // Requests are spaced out. Four different events have timed out across
    // sessions, always at the tail of a burst, and getComputerInfo fails on
    // every startup — the shape of a server that drops bursts. This is a
    // hypothesis, and `minRequestGap: 0` turns it off.
    let sendChain = Promise.resolve();

    function paced() {
        const gap = Math.max(0, cfg.minRequestGap || 0);
        if (!gap) return Promise.resolve();
        sendChain = sendChain.then(async () => {
            const wait = gap - (now() - bus.lastSend);
            if (wait > 0) await sleep(wait);
            bus.lastSend = now();
        });
        return sendChain;
    }

    function emit(payload, timeoutMs = defaultTimeout()) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = fn => v => { if (!settled) { settled = true; fn(v); } };
            const ok = finish(resolve), ko = finish(reject);

            const attempt = tries => {
                if (!bus.ws || bus.ws.readyState !== 1 || !bus.ready) {
                    return ko(new Error('socket not connected'));
                }
                // The id is taken at send time so ids stay in send order, and
                // the deadline starts once the frame has actually left.
                const fire = () => {
                    if (settled) return;
                    if (!bus.ws || bus.ws.readyState !== 1 || !bus.ready) {
                        return ko(new Error('socket not connected'));
                    }
                    const gen = bus.generation;
                    const id = allocAck();
                    const timer = setTimeout(() => {
                        bus.pending.delete(id);
                        ko(new Error('timeout on ' + payload.event));
                    }, timeoutMs);

                    bus.pending.set(id, {
                        gen, timer,
                        resolve: v => { clearTimeout(timer); ok(v); },
                        reject: e => { clearTimeout(timer); ko(e); },
                        reissue: () => {
                            if (settled) return;
                            if (tries >= 3) return ko(new Error('ack id collision'));
                            attempt(tries + 1);
                        }
                    });
                    registerOutgoing(id, payload);
                    const frame = '42' + id + JSON.stringify(['playerInput', payload]);
                    traceAdd({
                        t: now(), dir: '>', src: 'bot', kind: 'emit', id,
                        event: payload.event, bytes: frame.length, summary: redact(payload)
                    });
                    bus.rawSend(frame);
                };
                // With pacing off the send stays synchronous: switching the
                // experiment off must not change when the frame leaves.
                if (!cfg.minRequestGap) fire(); else paced().then(fire);
            };
            attempt(0);
        });
    }

    // Fire-and-forget request whose answer we do not care about. Used to mirror
    // the incidental traffic the real client produces.
    function chatter(payload) {
        if (!cfg.chatter) return;
        emit(payload, 8000).catch(() => { });
    }

    /* ======================================================================
     * 3. Self-training OCR for the word images
     * ==================================================================== */

    const ocr = {
        glyphs: LS.get(K_GLYPHS, {}),   // glyphKey -> character
        words: LS.get(K_WORDS, {}),     // imageHash -> word

        seq: 0,

        // Derived, never persisted: `glyphs` stays the single source of truth
        // for storage, this is only what makes lookups cheap.
        //   byShape  shape          -> character
        //   byDim    "WxH"          -> [{bits, ink, char}] decoded once
        //   lexicon  word length    -> [words] seen before, for pattern rescue
        index: null,

        reindex() {
            const byShape = new Map(), byDim = new Map(), lexicon = new Map();
            for (const key in this.glyphs) {
                const at = key.lastIndexOf('@');
                if (at === -1) continue;
                const shape = key.slice(0, at);
                const colon = shape.indexOf(':');
                const dim = shape.slice(0, colon);
                const ch = this.glyphs[key];
                if (!byShape.has(shape)) byShape.set(shape, ch);

                const x = dim.indexOf('x');
                const gw = +dim.slice(0, x), gh = +dim.slice(x + 1);
                if (!gw || !gh) continue;
                const bits = this.hexToBits(shape.slice(colon + 1), gw * gh);
                let ink = 0;
                for (let i = 0; i < bits.length; i++) ink += bits[i];
                if (!byDim.has(dim)) byDim.set(dim, []);
                byDim.get(dim).push({ bits, ink, char: ch });
            }
            const seen = new Set();
            for (const h in this.words) {
                const w = this.words[h];
                if (typeof w !== 'string' || seen.has(w)) continue;
                seen.add(w);
                if (!lexicon.has(w.length)) lexicon.set(w.length, []);
                lexicon.get(w.length).push(w);
            }
            this.index = { byShape, byDim, lexicon };
            return this.index;
        },

        idx() { return this.index || this.reindex(); },

        // Keep the index in step without rebuilding it wholesale.
        indexAdd(key, ch) {
            if (!this.index) return;
            const at = key.lastIndexOf('@');
            if (at === -1) return;
            const shape = key.slice(0, at);
            const colon = shape.indexOf(':');
            const dim = shape.slice(0, colon);
            if (!this.index.byShape.has(shape)) this.index.byShape.set(shape, ch);
            const x = dim.indexOf('x');
            const gw = +dim.slice(0, x), gh = +dim.slice(x + 1);
            if (!gw || !gh) return;
            const bits = this.hexToBits(shape.slice(colon + 1), gw * gh);
            let ink = 0;
            for (let i = 0; i < bits.length; i++) ink += bits[i];
            if (!this.index.byDim.has(dim)) this.index.byDim.set(dim, []);
            this.index.byDim.get(dim).push({ bits, ink, char: ch });
        },

        indexWord(word) {
            if (!this.index || typeof word !== 'string' || !word) return;
            const bucket = this.index.lexicon.get(word.length);
            if (!bucket) this.index.lexicon.set(word.length, [word]);
            else if (bucket.indexOf(word) === -1) bucket.push(word);
        },

        // `save` used to re-serialise ~144 KB on every learned word. It now
        // marks the store dirty and coalesces the writes.
        dirty: false,
        flushTimer: null,

        save() {
            this.seq++;
            this.dirty = true;
            if (this.flushTimer) return;
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush();
            }, 2000);
        },

        flush() {
            if (!this.dirty) return;
            this.dirty = false;
            if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
            // The word cache is only a fallback; cap it so localStorage cannot
            // fill up over a long-running session (keys keep insertion order).
            const keys = Object.keys(this.words);
            if (keys.length > 4000) {
                for (const k of keys.slice(0, keys.length - 4000)) delete this.words[k];
            }
            LS.set(K_GLYPHS, this.glyphs);
            LS.set(K_WORDS, this.words);
        },

        reset() {
            this.glyphs = {}; this.words = {}; this.index = null;
            this.save(); this.flush();
        },

        // A decode that neither loads nor errors would hang the caller for
        // good — and this sits on the per-word path, so it has to be bounded.
        loadImage(src, timeoutMs = 5000) {
            return new Promise((res, rej) => {
                let done = false;
                const timer = setTimeout(() => {
                    if (done) return;
                    done = true;
                    rej(new Error('image decode timed out'));
                }, timeoutMs);
                const finish = fn => arg => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    fn(arg);
                };
                const img = new Image();
                img.onload = finish(() => res(img));
                img.onerror = finish(() => rej(new Error('bad image')));
                img.src = src;
            });
        },

        // Decode to a 1-bit ink mask. The background colour is whatever the
        // border pixels agree on (transparent, green, black — all handled).
        async toMask(dataUri) {
            const img = await this.loadImage(dataUri);
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) throw new Error('empty image');

            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(0, 0, w, h).data;

            const counts = new Map();
            const tally = (x, y) => {
                const o = (y * w + x) * 4;
                const k = px[o] + ',' + px[o + 1] + ',' + px[o + 2] + ',' + px[o + 3];
                counts.set(k, (counts.get(k) || 0) + 1);
            };
            for (let x = 0; x < w; x++) { tally(x, 0); tally(x, h - 1); }
            for (let y = 0; y < h; y++) { tally(0, y); tally(w - 1, y); }

            let bg = [0, 0, 0, 0], best = -1;
            for (const [k, c] of counts) if (c > best) { best = c; bg = k.split(',').map(Number); }

            const mask = new Uint8Array(w * h);
            for (let i = 0, p = 0; i < w * h; i++, p += 4) {
                const d = Math.abs(px[p] - bg[0]) + Math.abs(px[p + 1] - bg[1]) +
                          Math.abs(px[p + 2] - bg[2]) + Math.abs(px[p + 3] - bg[3]) * 2;
                mask[i] = d > 120 ? 1 : 0;
            }
            return { w, h, mask };
        },

        // The word images are ~12px tall, far below what OCR engines read
        // comfortably, and the glyphs are black on transparent. Flattening onto
        // white and scaling with smoothing off gives the oracle dark text on a
        // light ground. Doing it here keeps the server free of any image
        // library — the canvas is already at hand.
        async upscaledPng(dataUri, factor) {
            const img = await this.loadImage(dataUri);
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) throw new Error('empty image');
            const cv = document.createElement('canvas');
            cv.width = w * factor; cv.height = h * factor;
            const ctx = cv.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, cv.width, cv.height);
            ctx.drawImage(img, 0, 0, cv.width, cv.height);
            return cv.toDataURL('image/png');
        },

        bitsToHex(bits) {
            let out = '';
            for (let i = 0; i < bits.length; i += 4) {
                out += ((bits[i] << 3) | ((bits[i + 1] || 0) << 2) |
                        ((bits[i + 2] || 0) << 1) | (bits[i + 3] || 0)).toString(16);
            }
            return out;
        },

        hexToBits(hex, len) {
            const bits = new Uint8Array(len);
            for (let i = 0; i < hex.length; i++) {
                const v = parseInt(hex[i], 16);
                for (let b = 0; b < 4; b++) {
                    const idx = i * 4 + b;
                    if (idx < len) bits[idx] = (v >> (3 - b)) & 1;
                }
            }
            return bits;
        },

        hash(str) {
            let h = 0x811c9dc5;
            for (let i = 0; i < str.length; i++) {
                h ^= str.charCodeAt(i);
                h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
            }
            return h.toString(36);
        },

        // Cut the line into glyph boxes on empty pixel columns.
        segment(m) {
            const { w, h, mask } = m;
            const colInk = new Uint8Array(w);
            for (let x = 0; x < w; x++) {
                for (let y = 0; y < h; y++) if (mask[y * w + x]) { colInk[x] = 1; break; }
            }
            // vertical extent of the whole line, used as the baseline reference
            let top = h, bottom = -1;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (mask[y * w + x]) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
                }
            }
            if (bottom < 0) return { segments: [], lineHash: null };

            const segs = [];
            let x = 0;
            while (x < w) {
                while (x < w && !colInk[x]) x++;
                if (x >= w) break;
                let x0 = x;
                while (x < w && colInk[x]) x++;
                const x1 = x - 1;

                let gt = h, gb = -1;
                for (let yy = 0; yy < h; yy++) {
                    for (let xx = x0; xx <= x1; xx++) {
                        if (mask[yy * w + xx]) { if (yy < gt) gt = yy; if (yy > gb) gb = yy; break; }
                    }
                }
                const gw = x1 - x0 + 1, gh = gb - gt + 1;
                const bits = new Uint8Array(gw * gh);
                for (let yy = 0; yy < gh; yy++) {
                    for (let xx = 0; xx < gw; xx++) bits[yy * gw + xx] = mask[(gt + yy) * w + (x0 + xx)];
                }
                // The key is the glyph shape plus its absolute row in the image.
                // Anchoring to the image frame (not to this word's ink top) keeps
                // a letter's key identical whatever else the word contains.
                const shape = `${gw}x${gh}:${this.bitsToHex(bits)}`;
                segs.push({ gw, gh, absTop: gt, bits, shape, key: `${shape}@${gt}` });
            }

            // hash of the whole trimmed line, used as an exact word cache key
            let lineBits = '';
            for (let y = top; y <= bottom; y++) {
                for (let xx = 0; xx < w; xx++) lineBits += mask[y * w + xx] ? '1' : '0';
            }
            return { segments: segs, lineHash: `${w}x${bottom - top + 1}:` + this.hash(lineBits) };
        },

        budgetFor(seg) { return Math.max(2, Math.floor(seg.gw * seg.gh * 0.10)); },

        // Exact key, then the same shape at another row (the image height
        // changed), then the nearest bitmap within tolerance. Same three tiers
        // and the same 10% budget as before — only the scans are indexed now.
        // `dist` comes back so callers can tell a comfortable match from a
        // borderline one.
        lookupDetailed(seg) {
            const exact = this.glyphs[seg.key];
            if (exact) return { char: exact, dist: 0 };

            const idx = this.idx();
            const sameShape = idx.byShape.get(seg.shape);
            if (sameShape) return { char: sameShape, dist: 0 };

            const budget = this.budgetFor(seg);
            const bucket = idx.byDim.get(`${seg.gw}x${seg.gh}`);
            if (!bucket) return { char: null, dist: Infinity };

            let ink = 0;
            for (let i = 0; i < seg.bits.length; i++) ink += seg.bits[i];

            let bestChar = null, bestDist = Infinity;
            for (let c = 0; c < bucket.length; c++) {
                const cand = bucket[c];
                // hamming >= |ink difference|, so this skips most candidates
                // without touching their bitmaps at all
                if (Math.abs(cand.ink - ink) > budget) continue;
                const other = cand.bits;
                let dist = 0;
                for (let i = 0; i < other.length; i++) {
                    if (other[i] !== seg.bits[i]) { dist++; if (dist >= bestDist || dist > budget) break; }
                }
                if (dist <= budget && dist < bestDist) { bestDist = dist; bestChar = cand.char; }
                if (bestDist === 0) break;
            }
            return { char: bestChar, dist: bestDist };
        },

        lookupGlyph(seg) { return this.lookupDetailed(seg).char; },

        async recognize(dataUri) {
            const mask = await this.toMask(dataUri);
            const { segments, lineHash } = this.segment(mask);
            if (!segments.length) return { word: null, segments, lineHash, unknown: 0 };

            let word = '', unknown = 0;
            const holes = [];
            for (let i = 0; i < segments.length; i++) {
                const ch = this.lookupGlyph(segments[i]);
                if (ch) word += ch;
                else { unknown++; holes.push(i); word += '…'; }
            }
            if (!unknown) return { word, segments, lineHash, unknown };

            const cached = lineHash && this.words[lineHash];
            if (cached) return { word: cached, segments, lineHash, unknown: 0, fromCache: true };

            // The render varies enough that a familiar word often arrives as a
            // brand new image, missing the per-image cache. With only a letter
            // or two missing, the words already seen usually pin it down.
            //
            // Nothing is written here on purpose. A new word one letter away
            // from a known one ("port" vs "post") would resolve to the wrong
            // candidate, and learning from that guess would poison the
            // dictionary. If the guess is right the server accepts it and the
            // normal success path learns it properly; if it is wrong, only one
            // try is lost and nothing was stored.
            if (unknown <= 2 && segments.length - unknown >= 3) {
                const guess = this.fromVocabulary(word, holes);
                if (guess) return { word: guess, segments, lineHash, unknown: 0, fromVocabulary: true };
            }
            return { word: null, segments, lineHash, unknown, partial: word };
        },

        exportData() {
            this.flush();               // never export something not yet written
            return { v: 1, glyphs: this.glyphs, words: this.words, prints: bot.knownPrints };
        },

        // Accepts both this export and the hand-rolled localStorage backup, in
        // which every field is still a raw JSON string. Entries are merged into
        // what is already learned rather than replacing it.
        importData(text) {
            let data;
            try { data = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
            if (!data || typeof data !== 'object') throw new Error('not a backup');

            const parse = v => {
                if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
                return v && typeof v === 'object' ? v : null;
            };
            const glyphs = parse(data.glyphs), words = parse(data.words);
            const prints = parse(data.prints);
            if (!glyphs && !words && !prints) throw new Error('nothing importable in there');

            const out = { glyphs: 0, words: 0, prints: 0, skipped: 0 };
            if (glyphs && !Array.isArray(glyphs)) {
                Object.keys(glyphs).forEach(key => {
                    const ch = glyphs[key];
                    // Reject anything that is not a current-format key, so a
                    // stale backup cannot quietly fill the dictionary with
                    // entries the matcher will never look up.
                    if (typeof ch === 'string' && ch.length === 1 &&
                        /^\d+x\d+:[0-9a-f]*@-?\d+$/.test(key)) {
                        this.glyphs[key] = ch; out.glyphs++;
                    } else out.skipped++;
                });
            }
            if (words && !Array.isArray(words)) {
                Object.keys(words).forEach(key => {
                    if (typeof words[key] === 'string' && words[key]) {
                        this.words[key] = words[key]; out.words++;
                    } else out.skipped++;
                });
            }
            if (Array.isArray(prints)) {
                prints.forEach(id => {
                    if (typeof id === 'string' && id && bot.knownPrints.indexOf(id) === -1) {
                        bot.knownPrints.push(id); out.prints++;
                    }
                });
                if (out.prints) LS.set('s0urce_bot_prints', bot.knownPrints);
            }
            this.index = null;
            this.save(); this.flush();
            return out;
        },

        // Drop what we believed about an image after the server rejected it.
        async forget(dataUri) {
            try {
                const mask = await this.toMask(dataUri);
                const { segments, lineHash } = this.segment(mask);
                if (lineHash) delete this.words[lineHash];
                for (const seg of segments) {
                    const shapePrefix = seg.shape + '@';
                    for (const key in this.glyphs) {
                        if (key === seg.key || key.startsWith(shapePrefix)) delete this.glyphs[key];
                    }
                }
                this.index = null;          // rebuilt lazily on the next lookup
                this.save();
            } catch (e) { /* nothing to forget */ }
        },

        // `pattern` is the reading with '…' for each unreadable segment, and a
        // segment is not always one character: touching letters come out as one
        // blob, so each hole may hide 1..MAX_MERGE characters. Assuming one
        // character per hole missed every word in a real session. Returns the
        // single word that fits, or null when it is ambiguous.
        fromVocabulary(pattern, holes) {
            const re = patternRegex(pattern, '…', MAX_MERGE);
            const lex = this.idx().lexicon;
            const longest = pattern.length + holes.length * (MAX_MERGE - 1);
            let found = null;
            for (let len = pattern.length; len <= longest; len++) {
                const bucket = lex.get(len);
                if (!bucket) continue;
                for (let b = 0; b < bucket.length; b++) {
                    if (!re.test(bucket[b])) continue;
                    if (found && found !== bucket[b]) return null;   // ambiguous
                    found = bucket[b];
                }
            }
            return found;
        },

        async learn(dataUri, word) {
            if (!word) return;
            const mask = await this.toMask(dataUri);
            const { segments, lineHash } = this.segment(mask);
            if (lineHash) { this.words[lineHash] = word; this.indexWord(word); }
            if (segments.length === word.length) {
                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i], ch = word[i];
                    // The render varies from image to image, so storing every
                    // variant grows the dictionary without bound — it was 98%
                    // redundant. Keep only what is not already comfortably
                    // recognised; half the budget still lets genuinely new
                    // shapes in, which is what keeps generalisation alive.
                    const hit = this.lookupDetailed(seg);
                    if (hit.char === ch && hit.dist <= this.budgetFor(seg) / 2) continue;
                    this.glyphs[seg.key] = ch;
                    this.indexAdd(seg.key, ch);
                }
            }
            this.save();
            ui.status();
        },

        // Greedy set cover per (glyph box, character): keep the fewest entries
        // that still recognise every entry being dropped. Deliberately run at
        // half the budget, so the kept set stays dense enough for renders we
        // have not seen yet.
        compact() {
            const before = Object.keys(this.glyphs).length;
            const beforeBytes = JSON.stringify(this.glyphs).length;
            const groups = new Map();
            for (const key in this.glyphs) {
                const at = key.lastIndexOf('@');
                if (at === -1) continue;
                const shape = key.slice(0, at);
                const colon = shape.indexOf(':');
                const dim = shape.slice(0, colon);
                const x = dim.indexOf('x');
                const gw = +dim.slice(0, x), gh = +dim.slice(x + 1);
                if (!gw || !gh) continue;
                const ch = this.glyphs[key];
                const g = dim + '|' + ch;
                if (!groups.has(g)) groups.set(g, { gw, gh, items: [] });
                groups.get(g).items.push({ key, bits: this.hexToBits(shape.slice(colon + 1), gw * gh) });
            }

            const keep = new Set();
            for (const [, group] of groups) {
                const radius = Math.max(1, Math.floor(Math.max(2, group.gw * group.gh * 0.10) / 2));
                const items = group.items;
                const covered = new Array(items.length).fill(false);
                let left = items.length;
                while (left > 0) {
                    let bestI = -1, bestCover = null;
                    for (let i = 0; i < items.length; i++) {
                        const reach = [];
                        for (let j = 0; j < items.length; j++) {
                            if (covered[j]) continue;
                            let dist = 0;
                            const a = items[i].bits, b = items[j].bits;
                            for (let k = 0; k < a.length; k++) {
                                if (a[k] !== b[k]) { dist++; if (dist > radius) break; }
                            }
                            if (dist <= radius) reach.push(j);
                        }
                        if (!bestCover || reach.length > bestCover.length) { bestI = i; bestCover = reach; }
                    }
                    if (bestI === -1 || !bestCover.length) break;
                    keep.add(items[bestI].key);
                    bestCover.forEach(j => { if (!covered[j]) { covered[j] = true; left--; } });
                }
            }

            for (const key in this.glyphs) if (!keep.has(key)) delete this.glyphs[key];
            this.index = null;
            this.save(); this.flush();
            const after = Object.keys(this.glyphs).length;
            return { before, after, removed: before - after,
                     beforeKB: Math.round(beforeBytes / 1024),
                     afterKB: Math.round(JSON.stringify(this.glyphs).length / 1024) };
        }
    };

    /* ----------------------------------------------------------------------
     * Local OCR oracle. Consulted only when the dictionary and the lexicon have
     * both failed, and never trusted blindly: a reading has to agree with the
     * letters already known, and nothing it says is written to the dictionary.
     * -------------------------------------------------------------------- */

    const oracle = {
        offline: false,                 // set after a connection failure
        stats: { asked: 0, accepted: 0, rejected: 0, engines: {} },

        reset() { this.offline = false; this.diagnosed = false; },

        healthUrl() { return this.endpoint('health'); },
        endpoint(name) {
            try {
                const u = new URL(cfg.oracleUrl, 'http://127.0.0.1');
                u.pathname = u.pathname.replace(/[^/]*$/, name);
                return u.toString();
            } catch (e) {
                return String(cfg.oracleUrl).replace(/[^/]*$/, name);
            }
        },

        // A closed port refuses instantly; a request the browser is holding for
        // a local-network permission just hangs. Telling those two apart is the
        // difference between "start the server" and "grant the permission" —
        // and a 40 s hang against a port with nothing on it is what a real
        // session produced.
        async diagnose() {
            if (this.diagnosed) return;
            this.diagnosed = true;
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 2500);
            try {
                await fetch(this.healthUrl(), { signal: ctl.signal });
                ui.log('oracle: /health answers, so the server is reachable — the model is the slow part');
            } catch (e) {
                if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
                    ui.log('oracle: even /health hangs. A closed port would refuse instantly, so ' +
                           'the browser is holding local requests — look for a local-network ' +
                           'permission prompt in the address bar for s0urce.io');
                } else {
                    ui.log('oracle: /health refused immediately — the server is not running ' +
                           '(node ocr-server/server.js)');
                }
            } finally { clearTimeout(timer); }
        },

        fits(text, hint) {
            if (!text) return false;
            if (hint.holeWidth) {
                if (hint.minLength && text.length < hint.minLength) return false;
                if (hint.maxLength && text.length > hint.maxLength) return false;
                return !hint.pattern || patternRegex(hint.pattern, '?', hint.holeWidth).test(text);
            }
            if (hint.length && text.length !== hint.length) return false;
            const p = hint.pattern || '';
            for (let i = 0; i < p.length && i < text.length; i++) {
                if (p[i] !== '?' && p[i] !== text[i]) return false;
            }
            return true;
        },

        // Prefer a reading that is a word we have already seen.
        pick(readings, hint) {
            const usable = (readings || []).filter(r => r && this.fits(r.text, hint));
            if (!usable.length) return null;
            const lex = ocr.idx().lexicon;
            const known = r => (lex.get(r.text.length) || []).indexOf(r.text) !== -1;
            return usable.find(known) || usable[0];
        },

        async ask(dataUri, rec, force) {
            if (!cfg.oracleEnabled || this.offline) return null;

            const count = rec && rec.segments ? rec.segments.length : 0;
            // after a misread our own reading is known to be wrong, so do not
            // constrain the oracle with it
            const pattern = force ? '?'.repeat(count)
                                  : String((rec && rec.partial) || '').replace(/…/g, '?');
            const holes = (pattern.match(/\?/g) || []).length;
            // One '?' per unreadable segment, each hiding 1..MAX_MERGE letters.
            // The segment count is only a lower bound on the length: sending it
            // as the exact length told the model a wrong length and rejected
            // the right answer for every word with touching letters.
            const hint = {
                pattern,
                holeWidth: MAX_MERGE,
                minLength: count || null,
                maxLength: count ? count + holes * (MAX_MERGE - 1) : null
            };

            let payload;
            try {
                payload = JSON.stringify({
                    image: await ocr.upscaledPng(dataUri, 4),
                    hint
                });
            } catch (e) { return null; }

            this.stats.asked++;
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), cfg.oracleTimeoutMs);
            let res = null;
            try {
                const r = await fetch(cfg.oracleUrl, {
                    method: 'POST', signal: ctl.signal,
                    headers: { 'content-type': 'application/json' },
                    body: payload
                });
                if (!r.ok) {
                    this.stats.rejected++;
                    ui.log(`oracle: HTTP ${r.status}`);
                    return null;
                }
                res = await r.json();
            } catch (e) {
                // A timeout means the server is there but slow — a vision model
                // loading for the first time easily outlasts the deadline. Only
                // a genuine connection failure justifies standing down, or a
                // cold model would disable the oracle for the whole session.
                const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
                this.stats.rejected++;
                if (aborted) {
                    ui.log(`oracle timed out after ${cfg.oracleTimeoutMs} ms`);
                    this.diagnose();          // says which of the two it is, once
                } else {
                    this.offline = true;
                    ui.log('oracle unreachable — falling back to asking you ' +
                           '(re-enable it in Config once the server is up)');
                }
                return null;
            } finally { clearTimeout(timer); }

            const best = this.pick(res && res.readings, hint);
            if (!best) {
                this.stats.rejected++;
                if (res && res.readings && res.readings.length) {
                    ui.log('oracle read something that did not fit: ' +
                           res.readings.map(r => `${r.engine}="${r.text}"`).join(', '));
                }
                return null;
            }
            this.stats.accepted++;
            this.stats.engines[best.engine] = (this.stats.engines[best.engine] || 0) + 1;
            return best;
        },

        // Tell the server whether the game accepted the word, so each engine's
        // real accuracy can be measured rather than assumed.
        report(reading, accepted) {
            if (!cfg.oracleEnabled || this.offline || !reading) return;
            fetch(this.endpoint('feedback'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    engine: reading.engine, reading: reading.text,
                    word: reading.text, accepted: !!accepted
                })
            }).catch(() => { });
        }
    };

    /* ======================================================================
     * 4. Game actions
     * ==================================================================== */

    const game = {
        async targets() {
            const res = await emit({ event: 'getClosestPlayersAndNPC' });
            if (!res || res.status !== 'success') return [];
            const list = Array.isArray(res.data) ? res.data : [];
            return list.map(t => Object.assign({}, t, {
                readyAt: t.timer ? now() + t.timer : 0
            }));
        },

        attack(target, port) {
            const event = target.isNpc ? 'attackNpcPort' : 'attackPort';
            return emit({ event, id: target.id, isNpc: !!target.isNpc, port });
        },

        sendWord(word) {
            return emit({ event: 'sendWord', word, debug_free_premium: false });
        },

        takeLoot() { return emit({ event: 'takeAllLoot' }); },
        sellLoot() { return emit({ event: 'sellAllLoot' }); },
        filamentLoot() { return emit({ event: 'filamentAllLoot' }); },
        aiMarket() { return emit({ event: 'sellToAiMarket' }); },
        reroll() { return emit({ event: 'rerollNPC' }); },
        agents() { return emit({ event: 'checkAgentLoot' }); },
        claimFilament() { return emit({ event: 'claimFilamentLoot' }); },
        claimComponent() { return emit({ event: 'claimComponentLoot' }); },
        shredComponent() { return emit({ event: 'shredComponentLoot' }); },
        levelAgent(which) {
            return emit({ event: which === 'filament' ? 'levelUpFilamentAgent'
                                                      : 'levelUpComponentAgent' });
        },

        mails() { return emit({ event: 'getPlayerMails' }); },
        readMail(mailId) { return emit({ event: 'markMailAsRead', mailId }); },
        claimMail(mailId) { return emit({ event: 'claimMailRewards', mailId }); },

        seasonPass() { return emit({ event: 'getSeasonPassData' }); },
        claimSeason(id) { return emit({ event: 'claimSeasonPassReward', id }); },

        inventory() { return emit({ event: 'getInventory' }); },
        computer() { return emit({ event: 'getComputerInfo' }); },

        // goalSlot/goalID is the destination (goalID = whatever sits there, or
        // null); dragSlot/dragID is what is being moved. Dropping onto an
        // occupied equipment slot makes the server swap the two.
        move(goalSlot, goalID, dragSlot, dragID) {
            return emit({ event: 'moveItem', goalSlot, goalID: goalID || null, dragSlot, dragID });
        },

        upgradeItem() { return emit({ event: 'upgradeItem' }); },
        printItem(id) { return emit({ event: 'printItem', id }); },
        upgradePrinter() { return emit({ event: 'upgradePrinter' }); },

        // Neither of these is acked by the server, so they are fire-and-forget.
        autoShred(key, value) {
            if (!bus.ws || bus.ws.readyState !== 1 || !bus.ready) return;
            const id = allocAck();
            const frame = '42' + id + JSON.stringify(['playerInput',
                { event: 'changeAutoShredSetting', key, value }]);
            traceAdd({ t: now(), dir: '>', src: 'bot', kind: 'emit', id,
                       event: 'changeAutoShredSetting', bytes: frame.length,
                       summary: redact({ key, value }) });
            bus.rawSend(frame);
        },
        comment(description) {
            if (!bus.ws || bus.ws.readyState !== 1 || !bus.ready) return;
            const id = allocAck();
            const frame = '42' + id + JSON.stringify(['playerInput',
                { event: 'addCommentToTarget', description }]);
            traceAdd({ t: now(), dir: '>', src: 'bot', kind: 'emit', id,
                       event: 'addCommentToTarget', bytes: frame.length,
                       summary: redact({ description }) });
            bus.rawSend(frame);
        }
    };

    /* ----------------------------------------------------------------------
     * Wallet. Every response that touches the balance carries `btcUpdate`, and
     * BTC accrues continuously, so the balance is projected forward from the
     * last update exactly as the game client does.
     * -------------------------------------------------------------------- */
    const wallet = {
        btc: 0, perSecond: 0, at: 0, known: false,

        absorb(update) {
            if (!update || typeof update.btc !== 'number') return;
            this.btc = update.btc;
            this.perSecond = update.btcPerSecond || 0;
            this.at = now();
            this.known = true;
        },
        now() {
            if (!this.known) return 0;
            return this.btc + this.perSecond * ((now() - this.at) / 1000);
        },
        canAfford(price) {
            return typeof price === 'number' && (!this.known || this.now() >= price);
        },
        spent(price) {          // optimistic, corrected by the next btcUpdate
            if (this.known && typeof price === 'number') this.btc = Math.max(0, this.now() - price);
            this.at = now();
        }
    };

    /* ======================================================================
     * 5. The bot
     * ==================================================================== */

    const bot = {
        running: false,
        loopActive: false,
        counterHacked: false,
        current: null,        // live hack, for the Dashboard tab
        lastOracle: null,     // oracle reading awaiting the server's verdict
        chore: null,          // housekeeping step in progress
        choreBackoff: {},     // step -> {until, ms} after an unanswered request
        history: [],          // per-word and per-hack samples, for the charts
        premium: false,       // from the loginProfile push
        lootShred: null,      // real auto-shred state, from the initPlayer push
        shredAsked: {},       // what we have asked for but cannot yet confirm
        knownPrints: LS.get('s0urce_bot_prints', []),   // learned from your own prints
        blacklist: new Map(),          // target id -> retry-after timestamp
        stats: { hacks: 0, wins: 0, losses: 0, words: 0, misses: 0, btc: 0, started: 0 },

        record(entry) {
            entry.t = now();
            this.history.push(entry);
            if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
        },

        // Everything the charts plot, derived from `history` over a window.
        rollup(windowMs = 60000) {
            const cutoff = now() - windowMs;
            const words = this.history.filter(h => h.kind === 'word' && h.t >= cutoff);
            const hacks = this.history.filter(h => h.kind === 'hack' && h.t >= cutoff);
            const ok = words.filter(w => w.ok).length;
            let wpm = 0;
            if (words.length) {
                const sum = words.reduce((a, w) => a + (w.ms > 0 ? (w.len / 5) / (w.ms / 60000) : 0), 0);
                wpm = sum / words.length;
            }
            return {
                wordsPerMin: words.length / (windowMs / 60000),
                hacksPerHour: hacks.length / (windowMs / 3600000),
                hitRate: words.length ? ok / words.length : 1,
                wpm
            };
        },

        pickPort() {
            return cfg.port === 'random' ? Math.floor(Math.random() * 3) : Number(cfg.port);
        },

        async pickTarget() {
            // Deliberately not caught here: swallowing the error turned a failing
            // target list into "no target available" forever, and the loop's
            // backoff — and its stop after repeated failures — never engaged.
            const list = await game.targets();

            const t = now();
            const usable = list.filter(x =>
                x && x.id && !x.isYou && !x.fake && !x.disabledHack &&
                (!x.readyAt || x.readyAt <= t) &&
                !(this.blacklist.get(x.id) > t)
            );

            let pool = usable;
            if (cfg.targetMode === 'npc') pool = usable.filter(x => x.isNpc);
            else if (cfg.targetMode === 'players') pool = usable.filter(x => !x.isNpc);
            if (!pool.length) return null;
            return pool[Math.floor(Math.random() * pool.length)];
        },

        // Time to "type" a word: a reaction to it appearing, then one
        // lognormal interval per character, with the occasional hesitation.
        wordDelay(word) {
            const perChar = 60000 / (Math.max(10, cfg.wpm) * 5);
            if (!cfg.humanPauses) return clamp(perChar * word.length, 90, 15000);

            let total = rand(140, 380);
            for (let i = 0; i < word.length; i++) {
                total += clamp(lognormal(perChar, 0.32), perChar * 0.35, perChar * 4);
                if (Math.random() < 0.045) total += rand(280, 1100);   // hesitation
            }
            return clamp(total, 120, 15000);
        },

        // Sleep that reacts to STOP instead of blocking for the whole duration.
        async idle(ms) {
            const end = now() + ms;
            // clamp: `end - now()` can go slightly negative between the check
            // and the call, and setTimeout complains about that
            while (this.running && now() < end) {
                await sleep(Math.max(0, Math.min(400, end - now())));
            }
        },

        // Deliberate miss. Real players fumble; a run of thousands of perfect
        // words is itself a signature. Off by default: every miss costs a try.
        maybeTypo(word, tries) {
            if (!cfg.typoRate || tries <= 2 || word.length < 3) return null;
            if (Math.random() >= cfg.typoRate) return null;
            for (let attempt = 0; attempt < 6; attempt++) {
                const chars = [...word];
                const i = 1 + Math.floor(Math.random() * (chars.length - 2));
                if (Math.random() < 0.5) {
                    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];   // transpose
                } else {
                    chars.splice(i, 1);                                     // dropped key
                }
                const typo = chars.join('');
                // transposing a doubled letter changes nothing — try again
                if (typo !== word) return typo;
            }
            return null;
        },

        async resolveWord(image, force = false) {
            // Always segment, even after a misread: the oracle wants the length.
            const rec = await ocr.recognize(image);
            if (!force && rec.word) return rec.word;

            if (!force) this.stats.misses++;

            const read = await oracle.ask(image, rec, force);
            if (read) {
                ui.log(`oracle (${read.engine}) read "${read.text}"`);
                this.lastOracle = read;     // graded once the server answers
                return read.text;
            }

            if (cfg.stopOnUnknown) {
                ui.log('unknown glyph, stopping (see settings)');
                this.stop();
                return null;
            }
            ui.log(force ? 'misread — what does it actually say?'
                         : 'unknown glyph — asking you once' +
                           (rec.partial ? ' (read so far: ' + rec.partial + ')' : ''));
            const typed = await ui.askWord(image, rec.partial);
            if (!typed) { this.stop(); return null; }
            // A decode failure here must not throw away the word you just
            // typed, nor take the run down with it.
            try { await ocr.learn(image, typed); }
            catch (e) { ui.log('could not learn that word: ' + e.message); }
            return typed;
        },

        async runHack(target, port) {
            const startedAt = now();
            try {
                const result = await this.hackOnce(target, port);
                this.record({ kind: 'hack', result: result || 'abort',
                              btc: (this.current && this.current.btc) || 0,
                              ms: now() - startedAt });
            } finally {
                this.current = null;
            }
        },

        async hackOnce(target, port) {
            let res;
            try { res = await game.attack(target, port); }
            catch (e) { ui.log('attack failed: ' + e.message); return; }

            if (!res || res.status !== 'success') {
                const msg = (res && res.message) || 'refused';
                this.blacklist.set(target.id, now() + 60000);
                ui.log(`attack on ${target.username || target.id} rejected: ${msg}`);
                return 'refused';
            }

            this.stats.hacks++;
            this.counterHacked = false;
            const gen = bus.generation;
            let image = res.image ? 'data:image/png;base64,' + res.image : bus.lastImage;
            let tries = res.tries_left;
            let forceAsk = false;
            this.current = {
                name: target.username || target.id, port, tries,
                progress: 0, image, word: null, btc: 0, startedAt: now()
            };
            ui.log(`hacking ${target.username || target.id} on port ${port} (${tries} tries)`);
            ui.status();
            if (!image) { ui.log('no word image in the attack reply — aborting'); return 'abort'; }

            while (this.running && image) {
                if (bus.generation !== gen) { ui.log('connection changed, aborting hack'); return 'abort'; }
                if (this.counterHacked) { ui.log('counter-hacked, aborting'); return 'counterhacked'; }

                this.current.image = image;
                this.lastOracle = null;      // only the reading for *this* word
                const word = await this.resolveWord(image, forceAsk);
                if (!word || !this.running) return 'abort';

                const typo = this.maybeTypo(word, tries);
                const sent = typo || word;
                this.current.word = sent;

                const t0 = now();
                await this.idle(this.wordDelay(sent));
                if (!this.running || bus.generation !== gen) return 'abort';

                let out;
                try { out = (await game.sendWord(sent)) || {}; }
                catch (e) { ui.log('sendWord failed: ' + e.message); return 'abort'; }

                this.stats.words++;
                this.record({ kind: 'word', ms: now() - t0, len: sent.length,
                              ok: out.effect !== 'failed' });

                if (this.lastOracle && this.lastOracle.text === sent) {
                    oracle.report(this.lastOracle, out.effect !== 'failed');
                    this.lastOracle = null;
                }
                if (typeof out.tries_left === 'number') tries = out.tries_left;
                this.current.tries = tries;

                if (out.effect === 'failed' && typo) {
                    // Our own doing — the reading was fine, so keep the
                    // dictionary intact and simply type it properly next time.
                    ui.log(`fumbled "${typo}" (${tries} tries left)`);
                    forceAsk = false;
                } else if (out.effect === 'failed') {
                    // The server keeps the SAME word on screen after a miss, so
                    // re-sending our reading would just burn every try. Drop the
                    // bad entry and get the real word from the user instead.
                    ui.log(`"${word}" rejected (${tries} tries left)`);
                    this.stats.misses++;
                    await ocr.forget(image);
                    forceAsk = true;
                } else {
                    forceAsk = false;
                }

                if (out.status === 'victory') {
                    this.stats.wins++;
                    this.stats.btc += out.btcReward || 0;
                    ui.log(`hacked ${target.username || target.id} (+${(out.btcReward || 0).toFixed(8)} BTC)`);
                    ui.status();
                    this.current.btc = out.btcReward || 0;
                    this.current.progress = 100;
                    if (out.showLoot) await this.handleLoot();
                    if (cfg.autoComment) {
                        const pool = String(cfg.commentText || '').split('|')
                            .map(x => x.trim()).filter(Boolean);
                        if (pool.length) game.comment(pool[Math.floor(Math.random() * pool.length)]);
                    }
                    // the real client refreshes its target list right here
                    chatter({ event: 'getClosestPlayersAndNPC' });
                    return 'win';
                }
                if (out.status === 'defeat') {
                    this.stats.losses++;
                    ui.log('too many failures, connection closed');
                    ui.status();
                    chatter({ event: 'getClosestPlayersAndNPC' });
                    return 'loss';
                }
                if (out.status === 'error') {
                    ui.log('server: ' + (out.message || 'error'));
                    return 'error';
                }

                // No new image means the word did not change (a miss).
                if (out.image) image = 'data:image/png;base64,' + out.image;
                this.current.progress = out.progression || this.current.progress;
            }
        },

        async handleLoot() {
            try {
                if (cfg.lootAction === 'none') return;
                if (cfg.lootAction === 'sell') { await game.sellLoot(); ui.log('loot sold'); return; }
                if (cfg.lootAction === 'filament') { await game.filamentLoot(); ui.log('loot shredded'); return; }

                const r = (await game.takeLoot()) || {};
                if (r.status === 'error') {
                    ui.log('loot: ' + (r.message || 'error'));
                } else if (r.tookAll === false && cfg.sellOverflow) {
                    await game.sellLoot();
                    ui.log('inventory full — leftovers sold');
                } else {
                    ui.log('loot collected');
                }
                chatter({ event: 'getInventory' });   // as the loot window does
            } catch (e) { ui.log('loot failed: ' + e.message); }
        },

        /* ------------------------------------------------------------------
         * Housekeeping: everything a player does between hacks. Only ever
         * called from mainLoop between two hacks, never while one is running.
         * ---------------------------------------------------------------- */

        async housekeeping() {
            const steps = [
                ['mail', cfg.autoMail, () => this.doMail()],
                ['season pass', cfg.autoSeasonPass, () => this.doSeasonPass()],
                ['agents', cfg.autoAgents, () => this.doAgents()],
                ['auto-shred', cfg.autoShredSync, () => this.doAutoShred()],
                ['AI market', cfg.autoAiMarket, () => this.doAiMarket()],
                ['gear', cfg.autoEquip, () => this.doEquip()],
                ['upgrader', cfg.autoUpgrade, () => this.doUpgrade()],
                ['printer', cfg.autoPrint, () => this.doPrint()]
            ];
            for (const [name, enabled, run] of steps) {
                if (!this.running || !enabled) continue;
                const pause = this.choreBackoff[name];
                if (pause && now() < pause.until) continue;
                this.chore = name;
                try {
                    await run();
                    delete this.choreBackoff[name];
                } catch (e) {
                    if (/^timeout on /.test(e.message)) {
                        // An unanswered request is retried later, not on every
                        // pass: back off 5 min, doubling up to 30 min.
                        const ms = Math.min(30 * 60000, pause ? pause.ms * 2 : 5 * 60000);
                        this.choreBackoff[name] = { until: now() + ms, ms };
                        ui.log(`${name}: ${e.message} — paused ${Math.round(ms / 60000)} min`);
                    } else {
                        ui.log(`${name}: ${e.message}`);
                    }
                }
            }
            this.chore = null;
        },

        /* ---- free rewards ---------------------------------------------- */

        async doMail() {
            const res = await game.mails();
            const mails = (res && res.mails) || [];
            for (const mail of mails) {
                if (!this.running) return;
                if (!mail.read) await game.readMail(mail.id);
                // `rewards` arrives as a JSON string, not an object
                let rewards = mail.rewards;
                if (typeof rewards === 'string') {
                    try { rewards = JSON.parse(rewards); } catch (e) { rewards = null; }
                }
                const worth = rewards && (Array.isArray(rewards) ? rewards.length
                                                                 : Object.keys(rewards).length);
                if (worth && !mail.claimed_reward) {
                    const got = await game.claimMail(mail.id);
                    if (got && got.rewards) {
                        wallet.absorb(got.rewards.btcUpdate);
                        ui.log(`mail reward claimed (#${mail.id})`);
                    }
                }
            }
        },

        async doSeasonPass() {
            const res = await game.seasonPass();
            if (!res || res.status !== 'success' || !res.data) return;
            const level = res.data.seasonLevel || 0;
            const claims = res.data.seasonClaims || {};
            const rewards = res.season_rewards || {};
            for (let i = 0; i < level; i++) {
                if (!this.running) return;
                const id = i + 1;                       // the server ids are 1-based
                if (claims[id]) continue;
                const reward = rewards[id];
                // The client only offers tiers that carry a reward and are open
                // to this account. The server silently ignores the rest, which
                // used to time out on the same empty tier every single pass.
                if (!reward || (!reward.freePlayer && !this.premium)) continue;
                const got = await game.claimSeason(id);
                if (got && got.status === 'success') ui.log(`season pass level ${id} claimed`);
                else if (got && got.message) { ui.log(`season pass: ${got.message}`); return; }
            }
        },

        async doAgents() {
            const res = await game.agents();
            const a = (res && res.player_agents) || {};
            // NB: the server sends filamentAgent/componentAgent — reading
            // a.filament / a.component here silently claims nothing, ever.
            if ((res.currentFilament || a.currentFilament || 0) > 0) {
                const got = await game.claimFilament();
                if (got && got.filament) ui.log('filament agent loot claimed');
            }
            const loot = res.componentLoot || a.componentLoot || [];
            if (loot.length) {
                const got = await game.claimComponent();
                if (got && got.message) {           // inventory full -> shred instead
                    ui.log(`component loot: ${got.message}, shredding`);
                    await game.shredComponent();
                } else if (got) ui.log('component agent loot claimed');
            }
            if (!cfg.autoLevelAgents) return;
            for (const which of ['filament', 'component']) {
                const agent = a[which + 'Agent'];
                if (!agent || !wallet.canAfford(agent.nextUpdateCost)) continue;
                const got = await game.levelAgent(which);
                if (got && got.player_agents) {
                    wallet.absorb(got.btcUpdate);
                    ui.log(`${which} agent levelled up (${agent.nextUpdateCost} BTC)`);
                }
            }
        },

        // There is no server offer: the AI market sells whatever item sits in
        // the `ai_sell` slot. The client only asks when that slot is filled and
        // the server does not answer otherwise — so every pass used to time out.
        async doAiMarket() {
            const snap = await this.snapshot();
            if (!snap.data.ai_sell) return;
            const m = await game.aiMarket();
            if (m && m.status === 'success') ui.log('item in the AI market slot sold');
        },

        /* ---- auto-shred, via the game's own setting --------------------- */

        async doAutoShred() {
            // No ack on this event, so the only ground truth is the lootShred
            // block in the next initPlayer push. Send deltas only.
            const want = {
                common: cfg.shredCommon, uncommon: cfg.shredUncommon,
                rare: cfg.shredRare, epic: cfg.shredEpic
            };
            for (const key of Object.keys(want)) {
                const known = this.lootShred ? this.lootShred[key] : undefined;
                const asked = this.shredAsked[key];
                if (known === want[key] || asked === want[key]) continue;
                game.autoShred(key, want[key]);
                this.shredAsked[key] = want[key];
                ui.log(`auto-shred ${key} -> ${want[key]} (requested)`);
            }
        },

        /* ---- inventory snapshot ---------------------------------------- */

        async snapshot() {
            const inv = await game.inventory();
            const data = (inv && inv.data) || {};
            const map = data.inventory || {};
            const items = [], free = [];
            Object.keys(map).forEach(slot => {
                if (map[slot]) items.push({ slot, item: map[slot] });
                else free.push(slot);
            });
            // `data` also carries every equipment and machine slot (gpu, cpu,
            // psu, upgrader_*, shredder_*, ai_sell…): the client fills its
            // equipment store from this payload, never from player_profile.
            return { map, items, free, slots: data.inventorySlots || 0, data };
        },

        /* ---- gear: measure, do not guess -------------------------------- */

        score(stats) {
            if (!stats) return null;
            return [stats.hackDamage || 0, stats.hackTrueDamage || 0,
                    stats.hackArmorPenetration || 0, stats.hackCriticalDamageBonus || 0];
        },

        better(a, b) {                       // is a strictly better than b?
            if (!a || !b) return false;
            for (let i = 0; i < a.length; i++) {
                if (a[i] > b[i] + 1e-9) return true;
                if (a[i] < b[i] - 1e-9) return false;
            }
            return false;
        },

        async doEquip() {
            const info = await game.computer();
            if (!info || info.status !== 'success') return;
            let base = this.score(info.player_stats);
            const snap = await this.snapshot();
            // Worn gear comes from the inventory payload. player_profile only
            // holds avatar, name styling and shelves, so reading it there sent
            // every swap and every revert without the displaced item's id.
            const worn = { psu: snap.data.psu, cpu: snap.data.cpu, gpu: snap.data.gpu };

            const RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
            const slots = ['psu', 'cpu', 'gpu'];
            let tried = 0;

            for (const type of slots) {
                const candidates = snap.items
                    .filter(e => e.item && e.item.type === type)
                    .sort((x, y) => (RANK[y.item.rarity] || 0) - (RANK[x.item.rarity] || 0) ||
                                    (y.item.upgradeLevel || 0) - (x.item.upgradeLevel || 0));

                for (const cand of candidates) {
                    if (!this.running || tried >= cfg.equipTrials) return;
                    tried++;
                    const equipped = worn[type];
                    const res = await game.move(type, equipped ? equipped.id : null,
                                                cand.slot, cand.item.id);
                    if (!res || res.status === 'error') continue;

                    const after = await game.computer();
                    const now2 = this.score(after && after.player_stats);
                    if (this.better(now2, base)) {
                        ui.log(`equipped ${cand.item.name || cand.item.id} (${type})`);
                        base = now2;
                        worn[type] = cand.item;
                        break;                       // keep it, move to the next slot
                    }
                    // No gain: put it back. After the swap the inventory slot
                    // holds the item that *was* equipped, so that is the id at
                    // the destination — not the candidate's.
                    await game.move(cand.slot, equipped ? equipped.id : null,
                                    type, cand.item.id);
                    if (equipped) worn[type] = equipped;
                }
            }
        },

        /* ---- upgrader --------------------------------------------------- */

        // A crash between the moves would leave items locked in the machine.
        async freeStuckItems() {
            const stuck = ['upgrader_0', 'upgrader_1', 'upgrader_2', 'upgrader_3',
                           'shredder_0', 'shredder_1', 'shredder_2', 'shredder_3', 'shredder_4'];
            // Machine slots come back in the inventory payload; looking for them
            // in player_profile meant nothing stranded was ever recovered.
            const snap = await this.snapshot();
            let freed = 0;
            for (const slot of stuck) {
                const item = snap.data[slot];
                if (!item || !snap.free.length) continue;
                const dest = snap.free.shift();
                const res = await game.move(dest, null, slot, item.id);
                if (res && res.status !== 'error') freed++;
            }
            if (freed) ui.log(`recovered ${freed} item(s) left in a machine`);
        },

        async doUpgrade() {
            const snap = await this.snapshot();
            const groups = {};
            snap.items.forEach(e => {
                const it = e.item;
                if (!it || !it.type || !it.rarity) return;
                // the client groups on type + rarity only; upgradeLevel is not compared
                const key = it.type + '|' + it.rarity;
                (groups[key] = groups[key] || []).push(e);
            });

            for (const key of Object.keys(groups)) {
                if (!this.running) return;
                const group = groups[key];
                if (group.length < 4) continue;
                const price = group[0].item.upgradePrice;
                if (!wallet.canAfford(price)) continue;

                const four = group.slice(0, 4);
                for (let i = 0; i < 4; i++) {
                    const res = await game.move(`upgrader_${i}`, null, four[i].slot, four[i].item.id);
                    if (!res || res.status === 'error') {
                        ui.log('upgrader: ' + ((res && res.message) || 'move refused'));
                        await this.freeStuckItems();
                        return;
                    }
                }
                const done = await game.upgradeItem();
                if (!done || done.status !== 'success') {
                    ui.log('upgrader refused the merge');
                    await this.freeStuckItems();
                    return;
                }
                wallet.absorb(done.btcUpdate);
                ui.log(`upgraded 4x ${key.replace('|', ' ')} (${price} BTC)`);

                const result = done.upgrader_0;
                const fresh = await this.snapshot();
                if (result && fresh.free.length) {
                    await game.move(fresh.free[0], null, 'upgrader_0', result.id);
                } else if (result) {
                    ui.log('no inventory space for the upgraded item — left in the upgrader');
                }
                return;                       // one merge per pass keeps traffic sane
            }
        },

        /* ---- 3D printer -------------------------------------------------- */

        async doPrint() {
            if (cfg.printerUpgrade) {
                const up = await game.upgradePrinter();
                if (up && up.player_progress) ui.log('printer upgraded');
            }
            const id = (cfg.printItemId || '').trim() || this.knownPrints[0];
            if (!id) return;                  // nothing learned and nothing configured
            const res = await game.printItem(id);
            if (res && res.notification_success) ui.log(`printed ${id}`);
            else if (res && res.notification_error) ui.log(`printer: ${res.notification_error}`);
        },

        async loop() {
            this.loopActive = true;
            try {
                if (cfg.autoUpgrade) await this.freeStuckItems().catch(() => { });
                await this.mainLoop();
            } finally {
                this.loopActive = false;
                ui.status();
            }
        },

        async mainLoop() {
            let idleRounds = 0;
            let lastChores = 0;
            let lastGlance = now();
            let errors = 0;

            while (this.running) {
                if (cfg.maxSessionMinutes &&
                    now() - this.stats.started > cfg.maxSessionMinutes * 60000) {
                    ui.log(`session limit of ${cfg.maxSessionMinutes} min reached`);
                    this.stop();
                    break;
                }

                if (!bus.ws || bus.ws.readyState !== 1 || !bus.ready) {
                    ui.log('waiting for the socket…', true);
                    await this.idle(2000);
                    continue;
                }

                if (now() - lastChores > cfg.housekeepingSeconds * 1000) {
                    lastChores = now();
                    await this.housekeeping();
                    if (!this.running) break;
                }

                // A player leaves windows open; the client polls them too.
                if (cfg.chatter && now() - lastGlance > rand(180000, 420000)) {
                    lastGlance = now();
                    chatter({ event: 'getComputerInfo' });
                }

                let target;
                try {
                    target = await this.pickTarget();
                    errors = 0;
                } catch (e) {
                    errors++;
                    const wait = Math.min(30000, 1500 * Math.pow(2, errors));
                    ui.log(`target lookup failed (${e.message}) — retrying in ${Math.round(wait / 1000)}s`);
                    if (errors >= 8) { ui.log('too many consecutive failures'); this.stop(); break; }
                    await this.idle(wait);
                    continue;
                }

                if (!target) {
                    idleRounds++;
                    if (cfg.autoReroll && idleRounds % 6 === 0) {
                        try {
                            const r = await game.reroll();
                            if (r && r.npcList) ui.log('NPC list rerolled');
                        } catch (e) { }
                    }
                    ui.log('no target available, waiting…', true);
                    await this.idle(4000);
                    continue;
                }
                idleRounds = 0;

                await this.runHack(target, this.pickPort());
                if (!this.running) break;

                await this.idle(rand(cfg.betweenHacks[0], cfg.betweenHacks[1]));

                // Nobody grinds without ever stepping away.
                if (cfg.humanPauses && this.running && Math.random() < 0.07) {
                    const ms = rand(12000, 55000);
                    ui.log(`pausing for ${Math.round(ms / 1000)}s`);
                    await this.idle(ms);
                }
            }
        },

        start() {
            if (this.running) return;
            if (this.loopActive) { ui.log('previous run is still winding down…'); return; }
            if (!bus.ws) {
                ui.log('no websocket captured — reload the game tab with the script enabled');
                return;
            }
            if (!bus.ready) {
                ui.log('websocket captured but not upgraded yet — try again in a second');
                return;
            }
            this.running = true;
            this.stats.started = now();
            ui.log('bot started');
            ui.status();
            this.loop().catch(e => {
                ui.log('bot crashed: ' + e.message);
                this.running = false;
                ui.status();
            });
        },

        stop() {
            if (!this.running) return;
            this.running = false;
            ui.log('bot stopped');
            ui.status();
        },

        toggle() { this.running ? this.stop() : this.start(); }
    };

    bus.listeners.push((name, args) => {
        const a = (args && args[0]) || {};
        if (name === 'gotCounterHacked') bot.counterHacked = true;
        // Exactly what the real client does when the server pushes a level-up.
        if (name === 'seasonPassLeveldUp') chatter({ event: 'checkAnySeasonRewardsToClaim' });

        if (name === 'initPlayer') {
            // the only place the real auto-shred state is ever revealed
            if (a.player_settings && a.player_settings.lootShred) {
                bot.lootShred = a.player_settings.lootShred;
                bot.shredAsked = {};
            }
            wallet.absorb(a.btcUpdate);
        }
        if (name === 'loginProfile') bot.premium = !!a.premium;
        // The server reports refusals through these pushes rather than acks;
        // the game shows them as a transient hover, the bot used to drop them.
        if (name === 'newHoverNotification' && a.message) {
            ui.log(`server ${a.status || 'notice'}: ${a.message}`);
        }
        if (name === 'gotGlobalMessage' && a.message) ui.log(`server: ${a.message}`);
        if (name === 'updateBtc') wallet.absorb(a);
        if (name === 'updateBtcAndInv') wallet.absorb(a.btcUpdate);
    });

    /* ======================================================================
     * 6. Interface
     *
     * Nothing is rendered into the game page. The console lives in its own
     * window, opened with Ctrl+Alt+A — a popup needs a user gesture, and a key
     * listener draws nothing. Being an about:blank window we opened ourselves
     * it is same-origin, so it is built and updated straight from this
     * closure: no postMessage, and no global left on the game page.
     *
     * `ui` keeps only what has to stay page-side: the hotkeys, the log ring
     * buffer, and the fallback training prompt for when the console is shut.
     * ==================================================================== */

    // Rolling samples for the charts. Collected whether or not the console is
    // open, so it already has a history to draw when you open it.
    const SERIES_CAP = 240;                       // 20 min at one sample / 5 s
    const series = { wpm: [], words: [], hacks: [], hit: [] };

    function sampleSeries() {
        const r = bot.rollup(60000);
        const push = (arr, v) => {
            arr.push(Number.isFinite(v) ? v : 0);
            if (arr.length > SERIES_CAP) arr.shift();
        };
        push(series.wpm, r.wpm);
        push(series.words, r.wordsPerMin);
        push(series.hacks, r.hacksPerHour);
        push(series.hit, r.hitRate * 100);
    }

    const fmt = {
        dur(ms) {
            if (!ms || ms < 0) return '—';
            const s = Math.floor(ms / 1000);
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
            return h ? `${h}h ${m}m` : (m ? `${m}m ${s % 60}s` : `${s}s`);
        },
        clock(t) { return new Date(t).toTimeString().slice(0, 8); },
        num(v, d = 0) { return Number.isFinite(v) ? v.toFixed(d) : '—'; }
    };

    const ui = {
        lines: [],

        log(msg, quiet = false) {
            const line = `[${fmt.clock(now())}] ${msg}`;
            const last = this.lines[this.lines.length - 1];
            // a repeated "waiting" line just refreshes its timestamp
            if (quiet && last && last.slice(11) === msg) this.lines[this.lines.length - 1] = line;
            else this.lines.push(line);
            if (this.lines.length > 400) this.lines.shift();
            this.seq = (this.seq || 0) + 1;
        },

        // Run/socket state changes are worth showing without waiting for the
        // next tick; everything else is picked up by the render loop.
        status() { if (panel.live()) panel.renderHeader(); },

        askWord(dataUri, partial) {
            if (panel.live()) return panel.askWord(dataUri, partial);
            this.log('console is closed — asking in the game page instead');
            return this.fallbackAskWord(dataUri, partial);
        },

        // The only thing this script ever draws into the game page, and only
        // when the console is shut. Losing a session because a window was
        // closed would be worse than briefly covering the game.
        fallbackAskWord(dataUri, partial) {
            return new Promise(resolve => {
                const wrap = document.createElement('div');
                wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.85);' +
                    'display:flex;align-items:center;justify-content:center;font:13px ui-monospace,monospace';
                wrap.innerHTML =
                    '<div style="background:#0b0f0b;border:1px solid #5be22e;border-radius:6px;padding:22px;' +
                    'max-width:520px;color:#5be22e;text-align:center">' +
                    '<div style="margin-bottom:10px;font-size:15px">Teach the OCR this word</div>' +
                    '<div style="background:#5be22e;display:inline-block;padding:6px 10px;border-radius:3px;margin:12px 0">' +
                    '<img src="' + dataUri + '" style="display:block;height:66px;image-rendering:pixelated"></div>' +
                    (partial ? '<div style="font-size:11px;opacity:.7;margin-bottom:6px">partial read: ' + partial + '</div>' : '') +
                    '<div><input id="ah-word" autocomplete="off" spellcheck="false" style="background:#000;' +
                    'border:1px solid #5be22e;color:#5be22e;padding:8px 10px;width:100%;box-sizing:border-box;' +
                    'font:inherit;font-size:15px"></div>' +
                    '<div style="font-size:11px;opacity:.6;margin-top:8px">Enter = teach &amp; continue · Esc = stop</div></div>';
                document.body.appendChild(wrap);
                const input = wrap.querySelector('#ah-word');
                if (input.focus) input.focus();
                const done = v => { wrap.remove(); resolve(v); };
                input.addEventListener('keydown', e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) done(input.value.trim()); }
                    if (e.key === 'Escape') { e.preventDefault(); done(null); }
                });
            });
        },

        install() {
            // Capture phase: the game must not be able to swallow these first.
            window.addEventListener('keydown', e => {
                if (e.key === 'F9') { e.preventDefault(); panel.open(); return; }
                if (!e.ctrlKey || !e.altKey) return;
                const letter = hotkeyLetter(e);
                if (letter === 'a') { e.preventDefault(); panel.open(); }
                else if (letter === 's') { e.preventDefault(); bot.toggle(); }
            }, true);
            // a reload would otherwise leave an orphaned window holding
            // references into a dead javascript context
            window.addEventListener('beforeunload', () => { ocr.flush(); panel.close(); });
            setInterval(sampleSeries, 5000);
        }
    };

    const CONSOLE_CSS = `
:root{--bg:#0b0f0b;--fg:#5be22e;--dim:#24371c;--mut:#7fa06d;--red:#e2572e;--amber:#e2c22e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
     font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{display:flex;align-items:center;gap:16px;padding:10px 14px;border-bottom:1px solid var(--dim)}
header .sp{flex:1}
button{background:#111a10;border:1px solid var(--fg);color:var(--fg);font:inherit;
       padding:6px 12px;border-radius:3px;cursor:pointer}
button:hover{background:#182610}
nav{display:flex;padding:0 8px;border-bottom:1px solid var(--dim)}
nav button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:8px 14px}
nav button.on{border-bottom-color:var(--fg);background:#111a10}
section{display:none;padding:14px;overflow:auto;height:calc(100vh - 92px)}
section.on{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px}
.card{border:1px solid var(--dim);border-radius:4px;padding:10px 12px;margin-bottom:12px}
.k{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.09em}
.v{font-size:21px;margin-top:2px}
.bar{height:6px;background:#16220f;border-radius:3px;overflow:hidden;margin:10px 0}
.bar>div{height:100%;width:0;background:var(--fg);transition:width .25s}
pre{margin:0;white-space:pre-wrap;word-break:break-all;font:11px/1.5 inherit;
    background:#000;border:1px solid var(--dim);border-radius:3px;padding:8px;
    height:calc(100vh - 190px);overflow:auto;user-select:text}
input,select,textarea{background:#000;border:1px solid var(--dim);color:var(--fg);font:inherit;padding:4px 6px;border-radius:2px}
textarea{width:100%;height:120px;margin-top:8px;font:10px/1.4 inherit;resize:vertical;white-space:pre;overflow:auto}
input[type=checkbox]{accent-color:#5be22e}
label.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:5px 0}
label.row .lbl{display:flex;flex-direction:column}
label.row small{color:var(--mut);font-size:10px}
.glyphs{display:flex;flex-wrap:wrap;gap:8px}
.glyph{border:1px solid var(--dim);border-radius:3px;padding:6px;text-align:center;background:#000}
.glyph input{width:34px;text-align:center;margin-top:5px;font-size:14px}
.dim{color:var(--mut)}
.warn{color:var(--amber)}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center}
.modal>div{border:1px solid var(--fg);border-radius:6px;padding:24px;background:var(--bg);text-align:center;max-width:560px}
svg{width:100%;height:44px;display:block}
polyline{fill:none;stroke:var(--fg);stroke-width:1.5;vector-effect:non-scaling-stroke}
`;

    const TABS = [
        ['dash', 'Dashboard'], ['charts', 'Charts'], ['ocr', 'OCR'],
        ['socket', 'Socket'], ['config', 'Config'], ['log', 'Log']
    ];

    const panel = {
        win: null, doc: null, n: {}, tab: 'dash', timer: null,
        traceSeq: -1, logSeq: -1, glyphSeq: -1, tracePaused: false, traceFilter: '',

        live() { return !!(this.win && !this.win.closed && this.doc); },

        open() {
            if (this.live()) { this.win.focus(); return; }
            const g = cfg.consoleGeom;
            let w = null;
            try {
                w = window.open('', 'autohack_console',
                    `popup=yes,width=${g.w},height=${g.h},left=${g.x},top=${g.y}`);
            } catch (e) { w = null; }
            if (!w) {
                // nothing is drawn on the page, so this has to reach the
                // browser console or the user sees no feedback at all
                const msg = 'popup blocked — allow popups for s0urce.io, then press F9 again';
                ui.log(msg);
                console.warn('[autohack] ' + msg);
                return;
            }
            this.win = w;
            this.build();
        },

        close() {
            this.saveGeom();
            this.stop();
            try { if (this.win && !this.win.closed) this.win.close(); } catch (e) { }
            this.win = null;
        },

        stop() {
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
            this.doc = null;
        },

        // Remember where the console was put. Reading geometry off a window
        // that is already gone throws, hence the guard.
        saveGeom() {
            try {
                const w = this.win;
                if (!w || w.closed) return;
                const g = { w: w.outerWidth, h: w.outerHeight, x: w.screenX, y: w.screenY };
                if (!g.w || !g.h) return;
                const old = cfg.consoleGeom;
                if (old.w === g.w && old.h === g.h && old.x === g.x && old.y === g.y) return;
                cfg.consoleGeom = g;
                saveCfg();
            } catch (e) { /* window went away mid-read */ }
        },

        build() {
            const d = this.win.document;
            d.open();
            d.write('<!doctype html><html><head><meta charset="utf-8">' +
                '<title>autohack console</title><style>' + CONSOLE_CSS + '</style></head><body>' +
                '<header>' +
                '<b id="hd-state">STOPPED</b>' +
                '<span id="hd-sock" class="dim">socket —</span>' +
                '<span id="hd-up" class="dim">—</span>' +
                '<span class="sp"></span>' +
                '<button id="hd-run">START</button>' +
                '</header>' +
                '<nav>' + TABS.map(([id, label]) =>
                    `<button data-tab="${id}" class="${id === this.tab ? 'on' : ''}">${label}</button>`).join('') + '</nav>' +
                TABS.map(([id]) => `<section id="tab-${id}" class="${id === this.tab ? 'on' : ''}"></section>`).join('') +
                '</body></html>');
            d.close();
            this.doc = d;

            const $ = id => d.getElementById(id);
            this.n = {
                state: $('hd-state'), sock: $('hd-sock'), up: $('hd-up'), run: $('hd-run'),
                dash: $('tab-dash'), charts: $('tab-charts'), ocr: $('tab-ocr'),
                socket: $('tab-socket'), config: $('tab-config'), log: $('tab-log')
            };

            this.n.run.addEventListener('click', () => bot.toggle());
            Array.prototype.forEach.call(d.querySelectorAll('nav button'), b => {
                b.addEventListener('click', () => this.select(b.getAttribute('data-tab')));
            });

            this.buildDash(d);
            this.buildCharts(d);
            this.buildOcr(d);
            this.buildSocket(d);
            this.buildConfig(d);
            this.n.log.innerHTML = '<pre id="log-body"></pre>';
            this.n.logBody = $('log-body');

            this.win.addEventListener('beforeunload', () => { this.saveGeom(); this.stop(); });
            this.win.addEventListener('resize', () => this.saveGeom());
            this.traceSeq = this.logSeq = this.glyphSeq = -1;
            this.timer = setInterval(() => this.render(), 250);
            this.render();
        },

        select(tab) {
            this.tab = tab;
            const d = this.doc;
            Array.prototype.forEach.call(d.querySelectorAll('nav button'), b => {
                b.className = b.getAttribute('data-tab') === tab ? 'on' : '';
            });
            TABS.forEach(([id]) => {
                const el = d.getElementById('tab-' + id);
                if (el) el.className = id === tab ? 'on' : '';
            });
            this.render();
        },

        /* ---------------------------------------------------------- dash -- */

        buildDash(d) {
            this.n.dash.innerHTML =
                '<div class="card">' +
                '  <div class="k">current hack</div>' +
                '  <div id="lv-idle" class="dim" style="padding:8px 0">idle</div>' +
                '  <div id="lv-body" style="display:none">' +
                '    <div id="lv-target" style="font-size:15px;margin-top:4px"></div>' +
                '    <div class="bar"><div id="lv-bar"></div></div>' +
                '    <div style="display:flex;gap:18px;align-items:center">' +
                '      <div style="background:var(--fg);padding:5px 8px;border-radius:3px">' +
                '        <img id="lv-img" alt="word" style="display:block;height:52px;image-rendering:pixelated"></div>' +
                '      <div><div class="k">ocr reads</div><div id="lv-word" class="v"></div></div>' +
                '      <div><div class="k">tries left</div><div id="lv-tries" class="v"></div></div>' +
                '    </div>' +
                '  </div>' +
                '</div>' +
                '<div class="grid" id="dash-cards">' +
                ['wallet', 'wins', 'losses', 'btc', 'words', 'wpm', 'hit rate', 'glyphs',
                 'misses', 'oracle']
                    .map(k => `<div class="card"><div class="k">${k}</div>` +
                              `<div class="v" id="st-${k.replace(' ', '')}">—</div></div>`).join('') +
                '</div>';
            const $ = id => d.getElementById(id);
            Object.assign(this.n, {
                lvIdle: $('lv-idle'), lvBody: $('lv-body'), lvTarget: $('lv-target'),
                lvBar: $('lv-bar'), lvImg: $('lv-img'), lvWord: $('lv-word'), lvTries: $('lv-tries'),
                stWallet: $('st-wallet'),
                stWins: $('st-wins'), stLosses: $('st-losses'), stBtc: $('st-btc'),
                stWords: $('st-words'), stWpm: $('st-wpm'), stHit: $('st-hitrate'),
                stGlyphs: $('st-glyphs'), stMisses: $('st-misses'), stOracle: $('st-oracle')
            });
        },

        renderDash() {
            const c = bot.current, s = bot.stats, n = this.n;
            setText(n.stWallet, wallet.known ? wallet.now().toFixed(6) : '—');
            if (c) {
                n.lvIdle.style.display = 'none';
                n.lvBody.style.display = 'block';
                setText(n.lvTarget, `${c.name}  ·  port ${c.port}`);
                n.lvBar.style.width = clamp(c.progress || 0, 0, 100) + '%';
                if (c.image && n.lvImg.getAttribute('src') !== c.image) n.lvImg.setAttribute('src', c.image);
                setText(n.lvWord, c.word || '…');
                setText(n.lvTries, String(c.tries != null ? c.tries : '—'));
            } else {
                n.lvIdle.style.display = 'block';
                n.lvBody.style.display = 'none';
                setText(n.lvIdle, bot.chore ? `housekeeping: ${bot.chore}` : 'idle');
            }
            const r = bot.rollup(60000);
            setText(n.stWins, String(s.wins));
            setText(n.stLosses, String(s.losses));
            setText(n.stBtc, s.btc.toFixed(6));
            setText(n.stWords, String(s.words));
            setText(n.stWpm, fmt.num(r.wpm, 0));
            setText(n.stHit, fmt.num(r.hitRate * 100, 0) + '%');
            setText(n.stGlyphs, String(Object.keys(ocr.glyphs).length));
            setText(n.stMisses, String(s.misses));
            const o = oracle.stats;
            setText(n.stOracle, o.asked ? `${o.accepted}/${o.asked}` : '—');
        },

        /* -------------------------------------------------------- charts -- */

        buildCharts(d) {
            const specs = [['wpm', 'words per minute (typing)'], ['words', 'words / min'],
                           ['hacks', 'hacks / hour'], ['hit', 'ocr hit rate %']];
            this.n.charts.innerHTML = specs.map(([id, label]) =>
                `<div class="card"><div class="k">${label}</div>` +
                `<div class="v" id="ch-${id}-v">—</div>` +
                `<svg viewBox="0 0 200 44" preserveAspectRatio="none">` +
                `<polyline id="ch-${id}" points=""></polyline></svg></div>`).join('');
            specs.forEach(([id]) => {
                this.n['ch' + id] = d.getElementById('ch-' + id);
                this.n['ch' + id + 'v'] = d.getElementById('ch-' + id + '-v');
            });
        },

        renderCharts() {
            const draw = (id, data, digits) => {
                const line = this.n['ch' + id], label = this.n['ch' + id + 'v'];
                if (!data.length) return;
                const max = Math.max(1, ...data);
                const step = data.length > 1 ? 200 / (data.length - 1) : 0;
                line.setAttribute('points', data.map((v, i) =>
                    `${(i * step).toFixed(1)},${(43 - (v / max) * 41).toFixed(1)}`).join(' '));
                setText(label, fmt.num(data[data.length - 1], digits));
            };
            draw('wpm', series.wpm, 0);
            draw('words', series.words, 1);
            draw('hacks', series.hacks, 1);
            draw('hit', series.hit, 0);
        },

        /* ----------------------------------------------------------- ocr -- */

        buildOcr(d) {
            this.n.ocr.innerHTML =
                '<div class="card"><div class="k">learned glyphs</div>' +
                '<div class="dim" style="margin:4px 0 10px">Each bitmap is exactly what is stored. ' +
                'Correct a character in place, or ✕ to forget it — one bad mapping silently ' +
                'corrupts every word containing that letter.</div>' +
                '<div class="glyphs" id="glyph-box"></div></div>' +
                '<div class="card"><div class="k">word cache</div>' +
                '<div id="word-count" class="v">—</div>' +
                '<div style="margin-top:8px"><button id="purge-words">purge word cache</button> ' +
                '<button id="purge-all">forget everything</button></div>' +
                '<pre id="word-list" style="height:180px;margin-top:10px"></pre></div>' +
                '<div class="card"><div class="k">backup</div>' +
                '<div class="dim" style="margin:4px 0 8px">The dictionary lives in the ' +
                'site\'s localStorage, so it already survives editing or reinstalling the ' +
                'script. This is for moving it to another browser or profile.</div>' +
                '<button id="ocr-export">export</button> ' +
                '<button id="ocr-import">import</button> ' +
                '<button id="ocr-compact">compact</button> ' +
                '<span id="ocr-io-msg" class="dim"></span>' +
                '<textarea id="ocr-io" spellcheck="false" placeholder="paste a backup here, ' +
                'then press import"></textarea></div>';
            this.n.glyphBox = d.getElementById('glyph-box');
            this.n.wordCount = d.getElementById('word-count');
            this.n.wordList = d.getElementById('word-list');
            d.getElementById('purge-words').addEventListener('click', () => {
                ocr.words = {};
                ocr.index = null;          // the lexicon came from those words
                ocr.save(); ocr.flush();
                ui.log('word cache purged');
            });
            d.getElementById('purge-all').addEventListener('click', () => {
                ocr.reset(); ui.log('OCR dictionary cleared');
            });

            const io = d.getElementById('ocr-io');
            const msg = d.getElementById('ocr-io-msg');
            d.getElementById('ocr-export').addEventListener('click', () => {
                const dump = ocr.exportData();
                io.value = JSON.stringify(dump);
                if (io.select) io.select();
                // clipboard is best-effort; the textarea is selected either way
                try {
                    const nav = this.win && this.win.navigator;
                    if (nav && nav.clipboard) nav.clipboard.writeText(io.value).catch(() => { });
                } catch (e) { /* not available */ }
                setText(msg, `${Object.keys(dump.glyphs).length} glyphs, ` +
                             `${Object.keys(dump.words).length} words — selected and copied`);
            });
            d.getElementById('ocr-compact').addEventListener('click', () => {
                const r = ocr.compact();
                setText(msg, `${r.before} → ${r.after} entries ` +
                             `(${r.beforeKB} → ${r.afterKB} KB), ${r.removed} redundant dropped`);
                ui.log(`dictionary compacted: ${r.before} → ${r.after} glyphs`);
            });
            d.getElementById('ocr-import').addEventListener('click', () => {
                try {
                    const r = ocr.importData(io.value);
                    setText(msg, `merged ${r.glyphs} glyphs, ${r.words} words, ` +
                                 `${r.prints} printer ids` +
                                 (r.skipped ? ` (${r.skipped} skipped)` : ''));
                    ui.log(`imported ${r.glyphs} glyphs and ${r.words} words`);
                } catch (e) {
                    setText(msg, 'import failed: ' + e.message);
                }
            });
        },

        renderOcr() {
            if (ocr.seq === this.glyphSeq) return;         // dictionary unchanged
            this.glyphSeq = ocr.seq;
            const d = this.doc, box = this.n.glyphBox;
            box.innerHTML = '';
            const keys = Object.keys(ocr.glyphs).sort((a, b) =>
                (ocr.glyphs[a] || '').localeCompare(ocr.glyphs[b] || ''));
            keys.forEach(key => {
                const cell = d.createElement('div');
                cell.className = 'glyph';
                const cv = glyphCanvas(d, key);
                if (cv) cell.appendChild(cv);
                const input = d.createElement('input');
                input.maxLength = 1;
                input.value = ocr.glyphs[key];
                input.addEventListener('change', () => {
                    const v = input.value;
                    if (v) { ocr.glyphs[key] = v; ui.log(`glyph remapped to "${v}"`); }
                    else { delete ocr.glyphs[key]; ui.log('glyph forgotten'); }
                    ocr.save();
                });
                cell.appendChild(input);
                box.appendChild(cell);
            });
            if (!keys.length) box.innerHTML = '<span class="dim">nothing learned yet</span>';

            const words = Object.keys(ocr.words);
            setText(this.n.wordCount, String(words.length));
            setText(this.n.wordList, words.slice(-80).reverse()
                .map(h => `${h}  ${ocr.words[h]}`).join('\n'));
        },

        /* -------------------------------------------------------- socket -- */

        buildSocket(d) {
            this.n.socket.innerHTML =
                '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">' +
                '<button id="tr-pause">pause</button>' +
                '<input id="tr-filter" placeholder="filter by event or direction" style="flex:1">' +
                '<span class="dim" id="tr-count"></span></div><pre id="tr-body"></pre>';
            this.n.trBody = d.getElementById('tr-body');
            this.n.trCount = d.getElementById('tr-count');
            const pause = d.getElementById('tr-pause');
            pause.addEventListener('click', () => {
                this.tracePaused = !this.tracePaused;
                pause.textContent = this.tracePaused ? 'resume' : 'pause';
                this.traceSeq = -1;
            });
            d.getElementById('tr-filter').addEventListener('input', e => {
                this.traceFilter = (e.target.value || '').toLowerCase();
                this.traceSeq = -1;
            });
        },

        renderSocket() {
            if (this.tracePaused || bus.traceSeq === this.traceSeq) return;
            this.traceSeq = bus.traceSeq;
            const f = this.traceFilter;
            const rows = bus.trace.filter(e => !f ||
                (e.event + ' ' + e.src + ' ' + e.kind + ' ' + e.dir).toLowerCase().includes(f));
            setText(this.n.trCount, `${rows.length}/${bus.trace.length}`);
            setText(this.n.trBody, rows.slice(-200).reverse().map(e =>
                `${fmt.clock(e.t)} ${e.dir} ${(e.src + '        ').slice(0, 6)} ` +
                `#${String(e.id == null ? '-' : e.id).padEnd(6)} ` +
                `${(e.event + '                    ').slice(0, 22)} ${String(e.bytes).padStart(5)}B  ${e.summary}`
            ).join('\n'));
        },

        /* -------------------------------------------------------- config -- */

        buildConfig(d) {
            const groups = [];
            SCHEMA.forEach(f => {
                let g = groups.find(x => x.name === f.group);
                if (!g) groups.push(g = { name: f.group, fields: [] });
                g.fields.push(f);
            });

            this.n.config.innerHTML = '';
            groups.forEach(g => {
                const card = d.createElement('div');
                card.className = 'card';
                const head = d.createElement('div');
                head.className = 'k';
                head.textContent = g.name;
                card.appendChild(head);

                g.fields.forEach(f => {
                    const row = d.createElement('label');
                    row.className = 'row';
                    const lbl = d.createElement('span');
                    lbl.className = 'lbl';
                    const name = d.createElement('span');
                    name.textContent = f.label;
                    lbl.appendChild(name);
                    if (f.help) {
                        const help = d.createElement('small');
                        help.textContent = f.help;
                        lbl.appendChild(help);
                    }
                    row.appendChild(lbl);
                    row.appendChild(makeControl(d, f));
                    card.appendChild(row);
                });
                this.n.config.appendChild(card);
            });
        },

        /* ----------------------------------------------------------- log -- */

        renderLog() {
            if (ui.seq === this.logSeq) return;
            this.logSeq = ui.seq;
            setText(this.n.logBody, ui.lines.slice(-300).join('\n'));
            this.n.logBody.scrollTop = this.n.logBody.scrollHeight;
        },

        /* -------------------------------------------------------- render -- */

        renderHeader() {
            if (!this.live()) return;
            const n = this.n;
            setText(n.state, bot.running ? 'RUNNING' : 'STOPPED');
            n.state.style.color = bot.running ? 'var(--fg)' : 'var(--red)';
            setText(n.sock, 'socket ' + (bus.ready ? 'up' : (bus.connected ? 'handshaking' : 'down')));
            setText(n.run, bot.running ? 'STOP' : 'START');
            setText(n.up, bot.stats.started && bot.running
                ? 'up ' + fmt.dur(now() - bot.stats.started) : '—');
        },

        render() {
            if (!this.win || this.win.closed) { this.stop(); this.win = null; return; }
            if (!this.doc) return;
            this.renderHeader();
            if (this.tab === 'dash') this.renderDash();
            else if (this.tab === 'charts') this.renderCharts();
            else if (this.tab === 'ocr') this.renderOcr();
            else if (this.tab === 'socket') this.renderSocket();
            else if (this.tab === 'log') this.renderLog();
        },

        askWord(dataUri, partial) {
            return new Promise(resolve => {
                const d = this.doc;
                const wrap = d.createElement('div');
                wrap.className = 'modal';
                wrap.innerHTML =
                    '<div><div style="font-size:15px;margin-bottom:6px">Teach the OCR this word</div>' +
                    '<div class="dim" style="margin-bottom:12px">Only characters it has never seen are asked for. ' +
                    'Type exactly what you read.</div>' +
                    '<div style="background:var(--fg);display:inline-block;padding:8px 12px;border-radius:3px">' +
                    '<img src="' + dataUri + '" style="display:block;height:72px;image-rendering:pixelated"></div>' +
                    (partial ? '<div class="warn" style="margin-top:10px">partial read: ' + partial + '</div>' : '') +
                    '<div style="margin-top:14px"><input id="mw" autocomplete="off" spellcheck="false" ' +
                    'style="width:100%;font-size:16px;padding:8px"></div>' +
                    '<div class="dim" style="margin-top:8px">Enter = teach &amp; continue · Esc = stop the bot</div></div>';
                d.body.appendChild(wrap);
                const input = d.getElementById('mw');
                try { this.win.focus(); if (input.focus) input.focus(); } catch (e) { }
                const done = v => { wrap.remove(); resolve(v); };
                input.addEventListener('keydown', e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) done(input.value.trim()); }
                    if (e.key === 'Escape') { e.preventDefault(); done(null); }
                });
            });
        }
    };

    // Which letter the user actually typed. `e.code` is the *physical* key, so
    // on AZERTY the key marked A reports KeyQ — matching on it would make the
    // shortcut unreachable there. Prefer the produced character and fall back
    // to the physical key only when it is not a plain letter (AltGr, dead keys).
    function hotkeyLetter(e) {
        const typed = String(e.key || '').toLowerCase();
        if (/^[a-z]$/.test(typed)) return typed;
        const m = /^Key([A-Z])$/.exec(e.code || '');
        return m ? m[1].toLowerCase() : '';
    }

    function setText(node, value) {
        if (node && node.textContent !== value) node.textContent = value;
    }

    // Glyph keys are `${w}x${h}:${hex}@${top}`, and ocr.hexToBits already
    // reverses the payload, so a stored glyph can be drawn back exactly.
    function glyphCanvas(d, key) {
        const m = /^(\d+)x(\d+):([0-9a-f]*)@(-?\d+)$/.exec(key);
        if (!m) return null;
        const gw = Number(m[1]), gh = Number(m[2]);
        if (!gw || !gh || gw * gh > 4096) return null;
        const bits = ocr.hexToBits(m[3], gw * gh);
        const cv = d.createElement('canvas');
        cv.width = gw; cv.height = gh;
        const ctx = cv.getContext('2d');
        const img = ctx.createImageData(gw, gh);
        for (let i = 0; i < gw * gh; i++) {
            const on = bits[i];
            img.data[i * 4] = on ? 0x5b : 0x00;
            img.data[i * 4 + 1] = on ? 0xe2 : 0x00;
            img.data[i * 4 + 2] = on ? 0x2e : 0x00;
            img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        cv.style.cssText = `width:${gw * 4}px;height:${gh * 4}px;image-rendering:pixelated;display:block`;
        return cv;
    }

    function makeControl(d, f) {
        let ctl;
        if (f.type === 'bool') {
            ctl = d.createElement('input');
            ctl.type = 'checkbox';
            ctl.checked = !!cfg[f.key];
        } else if (f.type === 'text') {
            ctl = d.createElement('input');
            ctl.type = 'text';
            ctl.style.width = '210px';
            ctl.value = cfg[f.key] == null ? '' : cfg[f.key];
        } else if (f.type === 'number') {
            ctl = d.createElement('input');
            ctl.type = 'number';
            if (f.min != null) ctl.min = f.min;
            if (f.max != null) ctl.max = f.max;
            if (f.step != null) ctl.step = f.step;
            ctl.style.width = '80px';
            ctl.value = f.write ? f.write(cfg[f.key]) : cfg[f.key];
        } else {
            ctl = d.createElement('select');
            (f.options || []).forEach(([value, label]) => {
                const o = d.createElement('option');
                o.value = value;
                o.textContent = label;
                ctl.appendChild(o);
            });
            ctl.value = String(cfg[f.key]);
        }

        ctl.addEventListener('change', () => {
            const raw = f.type === 'bool' ? ctl.checked : ctl.value;
            let value;
            if (f.read) value = f.read(raw);
            else if (f.type === 'text') value = String(raw);
            else if (f.type === 'number') {
                value = clamp(Number(raw) || 0,
                    f.min != null ? f.min : -1e9, f.max != null ? f.max : 1e9);
            } else value = raw;
            cfg[f.key] = value;
            saveCfg();
            if (f.key.indexOf('oracle') === 0) oracle.reset();
            ui.log(`${f.key} = ${JSON.stringify(value)}`);
        });
        return ctl;
    }

    /* ======================================================================
     * 7. Boot
     * ==================================================================== */

    // Opt-in handle for the browser console (and for the test harness). Off by
    // default so the script leaves nothing at all on the game page.
    if (cfg.debug) {
        window.__autohack = { cfg, saveCfg, bus, ocr, bot, ui, panel, series, game, wallet,
                              oracle, emit, chatter, decodeFrame, allocAck, hotkeyLetter, SCHEMA };
    }

    function boot() {
        ui.install();
        ui.log('ready — play one hack manually to seed the OCR, or just press START');
        // nothing is drawn on the page, so say where the interface is
        console.info('%c[autohack]%c loaded — F9 (or Ctrl+Alt+A) opens the console, ' +
            'Ctrl+Alt+S starts/stops', 'color:#5be22e;font-weight:bold', 'color:inherit');
        if (!bus.ws) {
            setTimeout(() => {
                if (!bus.ws) ui.log('no WebSocket seen yet; if this persists, reload the page');
            }, 10000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
