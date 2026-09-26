/**
 * Probe: which group-call entry points does the WASM actually expose?
 *
 * The wrappers in `wasm-engine.mts` call `startVoipGroupCall`,
 * `joinVoipOngoingCall`, `checkOngoingCalls` and `inviteToCall`. This checks
 * they exist on the instantiated module before anything relies on them, and
 * reports the full method surface so a missing name is obvious.
 *
 * Run: node tests/wasm-group-probe.mjs
 */

import { fileURLToPath } from 'url';
import path from 'path';

const { WasmEngine } = await import(new URL('../dist/wasm-engine.mjs', import.meta.url).href);

const engine = new WasmEngine({
    callbacks: {
        onSignalingXmpp() {}, onCallEvent() {}, sendDataToRelay() {},
        onAudioCaptureInit() {}, onAudioCaptureStart() {}, onAudioCaptureStop() {},
        onAudioPlaybackData() {},
        cryptoHkdf() { return new Uint8Array(32); },
        hmacSha256() { return new Uint8Array(32); },
    },
});

await engine.initialize();
engine.initVoipStack('5511900000001@s.whatsapp.net', '5511900000001@s.whatsapp.net', '100000000000001@lid');
await engine.waitForVoipStackReady();

const surface = engine.describeInstance?.() ?? null;
if (!surface) {
    console.error('[probe] engine has no describeInstance(); cannot inspect');
    process.exit(1);
}

const wanted = [
    'startVoipGroupCall', 'joinVoipOngoingCall', 'checkOngoingCalls', 'inviteToCall',
    'startVoipCall', 'endCall', 'acceptCall', 'setCallMute',
    'handleIncomingSignalingMessage', 'handleIncomingSignalingOffer', 'handleIncomingSignalingAck',
    'StringList', 'Uint8List',
];

console.log('[probe] group entry points:');
let missing = 0;
for (const name of wanted) {
    const present = surface.methods.includes(name);
    if (!present) missing += 1;
    console.log(`   ${present ? 'OK  ' : 'MISS'} ${name}`);
}

console.log('\n[probe] every method matching call/group/voip:');
for (const name of surface.methods.filter((m) => /call|group|voip/i.test(m)).sort()) {
    console.log('   ', name);
}

console.log(`\n[probe] total methods: ${surface.methods.length}`);
console.log(`[probe] RESULT: ${missing === 0 ? 'all group entry points present' : `${missing} missing`}`);

try { engine.destroy?.(); } catch {}
process.exit(missing === 0 ? 0 : 1);
