/**
 * What does the engine report about the call AFTER the offer is sent?
 *
 * The owner's log showed `call_result: 4` and
 * `is_group_call_created_on_server: false`, and the call closed a few seconds
 * later. Those two fields are the whole answer: the engine considers the call
 * failed. This dumps every call-state event with the fields that matter, so the
 * state progression is visible instead of inferred from a wall of JSON.
 *
 * Run: node tests/call-state-dump.mjs
 */

import { WasmEngine } from '../dist/wasm-engine.mjs';

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';

/** Fields worth watching, out of the very large call-state object. */
const CAMPOS = [
    'call_state', 'old_call_state', 'call_result', 'call_setup_error_type',
    'is_group_call', 'is_caller', 'is_group_call_created_on_server',
    'participant_count', 'connected_limit', 'call_ended_by_me', 'call_ending',
    'enable_group_call', 'can_invite_new_participant', 'call_active_duration',
];

const eventos = [];

const engine = new WasmEngine({
    callbacks: {
        onSignalingXmpp: (peerJid, callId) => {
            console.log(`[dump] sinalização emitida -> ${peerJid} (callId=${callId})`);
        },
        onCallEvent: (type, data) => {
            eventos.push({ type, data });
            if (type !== 16 || !data) return;
            try {
                const parsed = JSON.parse(data);
                const info = parsed.call_info ?? parsed.callInfo ?? {};
                const resumo = {};
                for (const c of CAMPOS) if (c in info) resumo[c] = info[c];
                console.log(`[dump] evento 16 (estado): ${JSON.stringify(resumo)}`);
            } catch (e) {
                console.log(`[dump] evento 16 não parseável: ${e?.message}`);
            }
        },
        sendDataToRelay: () => 0,
        onAudioCaptureInit: (c) => console.log(`[dump] capture init: ${JSON.stringify(c)}`),
        onAudioCaptureStart: () => console.log('[dump] capture START'),
        onAudioCaptureStop: () => console.log('[dump] capture STOP'),
        onAudioPlaybackData: () => {},
        cryptoHkdf: () => new Uint8Array(32),
        hmacSha256: () => new Uint8Array(32),
    },
});

await engine.initialize();
engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
await engine.waitForVoipStackReady();

console.log('[dump] iniciando group call...');
engine.startGroupCall({
    groupJid: GROUP,
    pnUserJids: ['5511900000002@s.whatsapp.net', '5511900000003@s.whatsapp.net'],
    lidUserJids: ['200000000000002@lid', '200000000000003@lid'],
    deviceJidsCsv: ['200000000000002@lid', '200000000000003@lid'],
    callId: 'ABCDABCDABCDABCDABCDABCDABCDABCD',
    isVideo: false,
});

// Watch long enough to catch the state that ends the call.
await new Promise((r) => setTimeout(r, 12000));

console.log(`\n[dump] total de eventos: ${eventos.length}`);
const estados = eventos.filter((e) => e.type === 16);
console.log(`[dump] eventos de estado (16): ${estados.length}`);
if (!estados.length) {
    console.log('[dump] OBS: sem evento de estado neste ciclo.');
    console.log('       (numa sessão real o servidor manda o ack e o estado muda)');
}

try { engine.destroy?.(); } catch {}
setTimeout(() => process.exit(0), 200);
