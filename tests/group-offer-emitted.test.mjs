/**
 * O motor precisa emitir o offer de grupo.
 *
 * Este é o teste que fecha a regressão que causou o "não liga mais": o roster
 * passou a incluir o PRÓPRIO bot, e com isso `startVoipGroupCall` emite ZERO
 * stanzas — nenhum offer sai, a chamada nunca sobe e nada é reportado como erro.
 * Sem um teste no nível do motor, isso é invisível: tudo "funciona", só não liga.
 *
 * Medido com o motor REAL (WASM). Custa ~15s para subir a pilha.
 *
 * Run: node --test tests/group-offer-emitted.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { WasmEngine } from '../dist/wasm-engine.mjs';

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const SELF_BARE = '100000000000001@lid';
const GROUP = '120363411251996986@g.us';
const PEER_A = '200000000000002@lid';
const PEER_B = '200000000000003@lid';

/** Sobe um motor e devolve as stanzas que ele emitir. */
const emitir = async (pn, lid, devices, opts = {}) => {
    const captured = [];
    const engine = new WasmEngine({ callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) => captured.push({ peerJid, callId, xmlPayload }),
        onCallEvent: () => {}, sendDataToRelay: () => 0,
        onAudioCaptureInit: () => {}, onAudioCaptureStart: () => {}, onAudioCaptureStop: () => {},
        onAudioPlaybackData: () => {}, cryptoHkdf: () => new Uint8Array(32), hmacSha256: () => new Uint8Array(32),
    } });
    await engine.initialize();
    // `initComoBot` replica o fluxo real: o selfJid é o LID, não o PN.
    if (opts.initComoBot) engine.initVoipStack(SELF_LID, SELF_BARE, SELF_LID);
    else engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
    await engine.waitForVoipStackReady();
    engine.startGroupCall({
        groupJid: GROUP, pnUserJids: pn, lidUserJids: lid, deviceJidsCsv: devices,
        callId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', isVideo: false,
    });
    await new Promise((r) => setTimeout(r, 1500));
    try { engine.destroy?.(); } catch { /* ignore */ }
    return captured;
};

describe('startGroupCall emite o offer', () => {
    it('emite UM offer de grupo endereçado ao objeto da call', async () => {
        const captured = await emitir(
            ['5511911111111@s.whatsapp.net', PEER_B],
            [PEER_A, PEER_B],
            [PEER_A, PEER_B]
        );

        assert.equal(captured.length, 1, 'precisa emitir exatamente um offer');
        assert.equal(captured[0].peerJid, `${captured[0].callId}@call`, 'vai para <call-id>@call');
    });

    it('NÃO emite nada quando o próprio bot entra na lista (a regressão)', async () => {
        // Documenta o comportamento do WASM: com o próprio JID na lista, o
        // motor fica mudo. É por isso que `#semSelf` e o `buildCallRoster`
        // removem o bot antes de chamar.
        const captured = await emitir(
            [SELF_BARE, PEER_A, PEER_B],
            [SELF_BARE, PEER_A, PEER_B],
            [SELF_LID, PEER_A, PEER_B],
            { selfEhLid: true }
        );
        assert.equal(
            captured.length,
            0,
            'com o bot na lista o motor fica em silêncio — por isso ele é filtrado'
        );
    });

    it('a guarda #semSelf devolve o offer mesmo com o bot na lista', async () => {
        // O MESMO caso acima, mas com a identidade do bot no initVoipStack (o
        // fluxo real: `selfJid` é o LID). A guarda remove e o offer sai.
        const captured = await emitir(
            [SELF_BARE, PEER_A, PEER_B],
            [SELF_BARE, PEER_A, PEER_B],
            [SELF_LID, PEER_A, PEER_B],
            { selfEhLid: true, initComoBot: true }
        );
        assert.equal(captured.length, 1, 'a guarda precisa liberar o offer');
        assert.equal(captured[0].peerJid, `${captured[0].callId}@call`);
    });
});

after(() => setTimeout(() => process.exit(0), 100));
