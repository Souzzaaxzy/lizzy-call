/**
 * Does the media engine block the Node event loop?
 *
 * The bot froze completely when `!callp` ran: no other command worked, and after
 * a while it came back and reported a call that was never really placed. That is
 * the signature of a blocked event loop, not of a slow network call.
 *
 * The engine runs WhatsApp Web's WASM with pthreads. Emscripten pthreads
 * synchronise with `Atomics.wait`, and this SDK's wrapper returns `timed-out`
 * immediately instead of blocking — so a caller that loops on it spins at full
 * speed and starves every other task in the process.
 *
 * This test measures event-loop lag while the engine boots and while a group call
 * is started, which is the only way to know whether the freeze is ours.
 *
 * Run: node tests/event-loop-lag.mjs
 */

import { WasmEngine } from '../dist/wasm-engine.mjs';

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';

/** Measures the worst event-loop stall in a window. */
const lag = { samples: [], max: 0, stopped: false };
const TICK = 20;
let last = Date.now();
const ticker = setInterval(() => {
    const now = Date.now();
    const delta = now - last - TICK;
    last = now;
    if (delta > 0) {
        lag.samples.push(delta);
        if (delta > lag.max) lag.max = delta;
    }
}, TICK);

const report = (label) => {
    const worst = lag.max;
    console.log(`[lag] ${label}: pior atraso do event loop = ${worst}ms (${lag.samples.length} amostras)`);
    lag.max = 0;
    lag.samples = [];
    return worst;
};

const engine = new WasmEngine({
    callbacks: {
        onSignalingXmpp: () => {},
        onCallEvent: () => {},
        sendDataToRelay: () => 0,
        onAudioCaptureInit: () => {},
        onAudioCaptureStart: () => {},
        onAudioCaptureStop: () => {},
        onAudioPlaybackData: () => {},
        cryptoHkdf: () => new Uint8Array(32),
        hmacSha256: () => new Uint8Array(32),
    },
});

const results = [];

const t0 = Date.now();
await engine.initialize();
const bootMs = Date.now() - t0;
results.push({ step: 'initialize', ms: bootMs, lag: report(`initialize (${bootMs}ms)`) });

engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
await engine.waitForVoipStackReady();
results.push({ step: 'voipStackReady', ms: 0, lag: report('voipStackReady') });

const t1 = Date.now();
engine.startGroupCall({
    groupJid: GROUP,
    pnUserJids: ['5511900000002@s.whatsapp.net'],
    lidUserJids: ['200000000000002@lid'],
    deviceJidsCsv: ['200000000000002@lid'],
    callId: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    isVideo: false,
});
results.push({ step: 'startGroupCall', ms: Date.now() - t1, lag: report('startGroupCall') });

// Give the engine a moment to settle, then measure an idle window: if it keeps
// spinning, the lag stays high even when we are doing nothing.
await new Promise((r) => setTimeout(r, 2000));
results.push({ step: 'idle 2s', ms: 2000, lag: report('idle 2s') });

clearInterval(ticker);

console.log('\n[lag] resumo:');
for (const r of results) {
    const verdict = r.lag > 250 ? 'TRAVA' : r.lag > 80 ? 'atencao' : 'ok';
    console.log(`   ${r.step.padEnd(16)} lag=${String(r.lag).padStart(5)}ms  ${verdict}`);
}

const pior = Math.max(...results.map((r) => r.lag));
console.log(`\n[lag] RESULTADO: pior atraso = ${pior}ms`);
if (pior > 250) {
    console.log('   => O motor BLOQUEIA o event loop. No bot isso congela tudo.');
} else {
    console.log('   => O motor nao bloqueia de forma significativa.');
}

try { engine.destroy?.(); } catch {}
process.exit(0);
