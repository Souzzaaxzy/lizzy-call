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

const baileys = await import('@whiskeysockets/baileys');
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

/** The engine emits the ACTION node; the SDK wraps it in `<call>`. */
const action = node.tag === 'call' ? kids(node)[0] : node;

console.log(`[shape] engine payload tag = ${node.tag}`);
if (node.tag === 'call') console.log(`[shape] envelope attrs = ${JSON.stringify(node.attrs)}`);
console.log(`[shape] action = ${action?.tag}`);
console.log(`[shape] action.attrs = ${JSON.stringify(action?.attrs)}`);
console.log(`[shape] action children = ${kids(action).map((c) => c.tag).join(',')}`);

const gi = byTag(action, 'group_info');
if (gi) {
    console.log(`[shape] group_info attrs = ${JSON.stringify(gi.attrs)}`);
    console.log(`[shape] group_info users = ${kids(gi).length}`);
    for (const u of kids(gi)) {
        console.log(`[shape]   user jid=${u.attrs?.jid} state=${u.attrs?.state} devices=${kids(u).length}`);
        for (const d of kids(u)) console.log(`[shape]     device jid=${d.attrs?.jid}`);
    }
}

// Compare against the authoritative capture:
//   <call to="<call-id>@call"> <offer call-id call-creator group-jid>
//     audio(8000) audio(16000) net(medium=3) group_info
const problemas = [];
if (action?.tag !== 'offer') problemas.push('a ação não é <offer>');
const ordem = kids(action).map((c) => c.tag);
const esperado = ['audio', 'audio', 'net', 'group_info'];
if (JSON.stringify(ordem) !== JSON.stringify(esperado)) {
    problemas.push(`ordem dos filhos = ${ordem.join(',')} (esperado ${esperado.join(',')})`);
}
if (!action?.attrs?.['call-id']) problemas.push('sem call-id');
if (!action?.attrs?.['call-creator']) problemas.push('sem call-creator');
if (!action?.attrs?.['group-jid']) problemas.push('sem group-jid (a call precisa estar amarrada ao grupo)');
const primeiroAudio = kids(action)[0];
if (primeiroAudio?.attrs?.rate !== '8000') problemas.push('primeiro audio não é 8000');
const segundoAudio = kids(action)[1];
if (segundoAudio?.attrs?.rate !== '16000') problemas.push('segundo audio não é 16000');
const net = byTag(action, 'net');
if (net?.attrs?.medium !== '3') problemas.push('net medium não é 3');

console.log('\n[shape] comparacao com a captura autoritativa:');
if (problemas.length === 0) {
    console.log('   OK: a forma bate com a captura');
} else {
    for (const p of problemas) console.log(`   DIFERENCA: ${p}`);
}

try { engine.destroy?.(); } catch {}
process.exit(problemas.length === 0 ? 0 : 1);

