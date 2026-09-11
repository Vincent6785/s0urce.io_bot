const dec = require('./extract.js').decodeFrame();
let pass=0, fail=0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok?pass++:fail++;
  console.log((ok?'ok  ':'FAIL')+'  '+name + (ok?'':`\n      got ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`));
};

// engine.io handshake / ping / pong must be ignored
eq('open packet ignored',  dec('0{"sid":"x"}'), null);
eq('ping ignored',         dec('2'), null);
eq('pong ignored',         dec('3'), null);
eq('binary ignored',       dec(new Uint8Array([1,2,3])), null);

// socket.io CONNECT
eq('connect packet', dec('40{"sid":"abc"}'), {sioType:'0', id:null, payload:{sid:'abc'}});

// server push: 42["event",{...}]  (no ack id)
eq('server push', dec('42["event",{"event":"gotCounterHacked","arguments":[{"port":1}]}]'),
   {sioType:'2', id:null, payload:['event',{event:'gotCounterHacked',arguments:[{port:1}]}]});

// ack to our request: 43<id>[{...}]
eq('ack id 0',      dec('430[{"status":"success"}]'),      {sioType:'3', id:0, payload:[{status:'success'}]});
eq('ack big id',    dec('43912345[{"effect":"success"}]'), {sioType:'3', id:912345, payload:[{effect:'success'}]});

// outgoing shape we generate must round-trip
eq('our own emit frame', dec('42912345["playerInput",{"event":"sendWord","word":"root"}]'),
   {sioType:'2', id:912345, payload:['playerInput',{event:'sendWord',word:'root'}]});

// explicit namespace
eq('namespaced ack', dec('43/game,7[{"ok":1}]'), {sioType:'3', id:7, payload:[{ok:1}]});

// binary event with attachment count
eq('binary event', dec('451-["ev",{"_placeholder":true}]'),
   {sioType:'5', id:null, payload:['ev',{_placeholder:true}]});

// malformed JSON must not throw
eq('malformed json', dec('42["oops"'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
