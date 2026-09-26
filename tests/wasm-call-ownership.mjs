/**
 * Decisive experiment: WHO owns the call?
 *
 * The current `!callp` does two separate things:
 *   1. the bot sends the `<call><offer>` itself (signaling), and
 *   2. the media stack joins with `joinVoipOngoingCall`.
 *
 * If the WASM engine never sees that offer, it has no call state and cannot
 * negotiate media — which is exactly what "conectando..." forever looks like.
 *
 * The engine has its own offer path: `onSignalingXmpp` is how it emits signaling
 * to the peer. So this test boots the engine, calls `startGroupCall`, and checks
 * whether the ENGINE produces the offer. If it does, the call must be created BY
 * the engine, not by separate signaling.
 *
 * Run: node tests/wasm-call-ownership.mjs
 */

import { WasmEngine } from '../dist/wasm-engine.mjs';

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';

const signalingFromEngine = [];
const callEvents = [];

const engine = new WasmEngine({
    callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) => {
            signalingFromEngine.push({ peerJid, callId, bytes: xmlPayload?.length ?? 0 });
        },
        onCallEvent: (type, data) => { callEvents.push({ type, data: String(data ?? '').slice(0, 100) }); },
        sendDataToRelay: () => 0,
        onAudioCaptureInit: () => {},
        onAudioCaptureStart: () => {},
        onAudioCaptureStop: () => {},
        onAudioPlaybackData: () => {},
        cryptoHkdf: () => new Uint8Array(32),
        hmacSha256: () => new Uint8Array(32),
    },
});

await engine.initialize();
engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
await engine.waitForVoipStackReady();

console.log('[own] engine ready');

// --- Case A: does startGroupCall make the ENGINE emit an offer? -------------
const callId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
try {
    engine.startGroupCall({
        groupJid: GROUP,
        pnUserJids: ['5511900000002@s.whatsapp.net'],
        lidUserJids: ['200000000000002@lid'],
        deviceJidsCsv: ['200000000000002@lid'],
        callId,
        isVideo: false,
    });
    await new Promise((r) => setTimeout(r, 1500));
} catch (e) {
    console.log('[own] startGroupCall threw:', e?.message || e);
}

console.log(`[own] A) startGroupCall -> engine emitted ${signalingFromEngine.length} signaling stanza(s)`);
for (const s of signalingFromEngine.slice(0, 3)) {
    console.log(`        peerJid=${s.peerJid} callId=${s.callId} bytes=${s.bytes}`);
}

// --- Case B: does joinVoipOngoingCall emit anything on its own? -------------
signalingFromEngine.length = 0;
const callId2 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
try {
    engine.joinOngoingGroupCall({
        callId: callId2,
        callCreatorJid: SELF_LID,
        initialPeerJid: '200000000000002@lid',
        groupJid: GROUP,
        pnUserJids: ['5511900000002@s.whatsapp.net'],
        lidUserJids: ['200000000000002@lid'],
        deviceJidsCsv: ['200000000000002@lid'],
        initialGroupTransactionId: 0,
        joinAndAccept: true,
    });
    await new Promise((r) => setTimeout(r, 1500));
} catch (e) {
    console.log('[own] joinOngoingGroupCall threw:', e?.message || e);
}

console.log(`[own] B) joinOngoingGroupCall -> engine emitted ${signalingFromEngine.length} signaling stanza(s)`);
for (const s of signalingFromEngine.slice(0, 3)) {
    console.log(`        peerJid=${s.peerJid} callId=${s.callId} bytes=${s.bytes}`);
}

console.log(`\n[own] call events seen: ${callEvents.length}`);
for (const e of callEvents.slice(0, 6)) console.log(`        type=${e.type} ${e.data}`);

console.log('\n[own] CONCLUSION:');
if (signalingFromEngine.length > 0) {
    console.log('  joinOngoingGroupCall emits signaling -> the engine drives the join.');
} else {
    console.log('  joinOngoingGroupCall is SILENT on its own. The engine only knows a');
    console.log('  call it created (startGroupCall) or one whose offer it processed.');
    console.log('  => creating the call via separate signaling leaves the engine with');
    console.log('  NO call state, so media can never connect ("conectando..." forever).');
}

try { engine.destroy?.(); } catch {}
process.exit(0);
