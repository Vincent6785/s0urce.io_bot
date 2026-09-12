// Minimal browser-ish environment: a permissive proxy stands in for the DOM,
// plus a real localStorage and a scriptable mock WebSocket.
function anyProxy() {
  const t = function () {};
  return new Proxy(t, {
    get(o, k) {
      if (k === 'then' || k === Symbol.iterator || k === 'inspect' ||
          k === 'constructor' || typeof k === 'symbol') return undefined;
      if (k === 'length') return 0;
      if (k === 'valueOf') return () => 0;
      if (k === 'toString') return () => '';
      if (!(k in o)) o[k] = anyProxy();
      return o[k];
    },
    set(o, k, v) { o[k] = v; return true; },
    apply() { return anyProxy(); },
    construct() { return anyProxy(); },
    has() { return true; }
  });
}

const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};

// Mock socket.io transport. `sent` records every raw frame the script emits.
class MockWS {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.listeners = {};
    MockWS.last = this;
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  send(data) { this.sent.push(data); }
  fire(type, ev) { (this.listeners[type] || []).forEach(fn => fn(ev)); }
  deliver(frame) { this.fire('message', { data: frame }); }
  close() { this.readyState = 3; this.fire('close', {}); }
}

// Stand-in for a popup window. `closed` must be a real boolean: a proxy would
// be truthy and the console would tear itself down on the first render.
function mockWindow() {
  return {
    closed: false,
    document: anyProxy(),
    focus() {},
    addEventListener() {},
    close() { this.closed = true; }
  };
}

const win = global;
win.window = win;
win.self = win;
win.top = win;
win.localStorage = localStorage;
win.WebSocket = MockWS;
win.Image = function () {};
win.document = new Proxy({
  readyState: 'complete',
  addEventListener() {},
  createElement: () => anyProxy(),
  body: anyProxy(),
  querySelector: () => anyProxy()
}, { get(o, k) { if (!(k in o)) o[k] = anyProxy(); return o[k]; } });
win.location = { reload() {} };
win.addEventListener = () => {};
win.navigator = { userAgent: 'node' };

// A suite that hangs would otherwise run until the CI job's own limit. Fail
// fast and say which suite it was instead. Every suite ends with an explicit
// process.exit, so a ref'd timer costs nothing.
const WATCHDOG_MS = Number(process.env.TEST_WATCHDOG_MS || 180000);
setTimeout(() => {
  console.log(`\nWATCHDOG: still running after ${WATCHDOG_MS / 1000}s — giving up`);
  process.exit(1);
}, WATCHDOG_MS);

// The debug handle is opt-in; the suites need it, so seed the stored config.
store.set('s0urce_bot_cfg', JSON.stringify({ debug: true, oracleEnabled: false, minRequestGap: 0 }));

module.exports = { MockWS, mockWindow, store };
