/**
 * What does the engine's own group offer look like?
 *
 * `wasm-call-ownership` proved the engine drives the call: `startGroupCall`
 * makes it emit the offer. Before rewiring `!callp` to let the engine own the
 * call, this decodes that payload to confirm it is a proper group `<call><offer>`
 * (addressed to the call object, carrying group-jid and a group_info roster).
 *
 * Run: node tests/wasm-offer-shape.mjs
 */

import { WasmEngine } from '../dist/wasm-engine.mjs';

const baileys = await import('/workspace/project/lizzy/node_modules/@itsliaaa/baileys/lib/index.js');
const { decodeBinaryNode, encodeBinaryNode } = baileys;

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';

let captured = null;

const engine = new WasmEngine({
    callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) => {
            captured = { peerJid, callId, xmlPayload };
        },
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

await engine.initialize();
engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
await engine.waitForVoipStackReady();

engine.startGroupCall({
    groupJid: GROUP,
    pnUserJids: ['5511900000002@s.whatsapp.net'],
    lidUserJids: ['200000000000002@lid'],
    deviceJidsCsv: ['200000000000002@lid'],
    callId: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    isVideo: false,
});
await new Promise((r) => setTimeout(r, 1500));

if (!captured) {
    console.log('[shape] engine emitted NO signaling');
    process.exit(1);
}

console.log(`[shape] peerJid=${captured.peerJid} callId=${captured.callId} bytes=${captured.xmlPayload.length}`);

// The SDK decodes this payload two ways (with and without a leading byte).
const raw = Buffer.from(captured.xmlPayload);
let node = null;
for (const attempt of [Buffer.concat([Buffer.from([0]), raw]), raw]) {
    try {
        node = await decodeBinaryNode(attempt);
        if (node?.tag) break;
    } catch { /* try the next framing */ }
}

if (!node) {
    console.log('[shape] could not decode the payload');
    process.exit(1);
}

const kids = (n) => (Array.isArray(n?.content) ? n.content : []);
const byTag = (n, t) => kids(n).find((c) => c?.tag === t);

console.log(`[shape] node.tag = ${node.tag}`);
console.log(`[shape] attrs = ${JSON.stringify(node.attrs)}`);
const action = kids(node)[0];
if (action) {
    console.log(`[shape] action = ${action.tag}`);
    console.log(`[shape] action.attrs = ${JSON.stringify(action.attrs)}`);
    console.log(`[shape] action children = ${kids(action).map((c) => c.tag).join(',')}`);
    const gi = byTag(action, 'group_info');
    if (gi) {
        console.log(`[shape] group_info users = ${kids(gi).length}`);
        const first = kids(gi)[0];
        if (first) console.log(`[shape] first user = ${JSON.stringify(first.attrs)} devices=${kids(first).length}`);
    }
}

const isGroupOffer = node.tag === 'call' && action?.tag === 'offer';
console.log(`\n[shape] RESULT: ${isGroupOffer ? 'engine emits a real <call><offer>' : 'NOT a call offer'}`);
try { engine.destroy?.(); } catch {}
process.exit(isGroupOffer ? 0 : 1);
