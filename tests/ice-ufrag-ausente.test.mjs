/**
 * O `a=ice-ufrag` com `auth_token_id` AUSENTE — o erro do log do dono.
 *
 * ## O erro reproduzido
 *
 *   Invalid ICE parameters: ICE ufrag must be between 4 and 256 characters long
 *
 * ## A cadeia de evidências
 *
 * 1. O erro diz que o ufrag está fora de 4..256.
 * 2. Medido (`endpoint_selecionado`): `tokenLen=260`, `authTokenLen=96`.
 *    260 > 256 — o TOKEN estoura o teto do ICE; o AUTH_TOKEN cabe.
 * 3. O código fazia `authToken ?? token`: sem `auth_token_id`, o `authToken`
 *    ficava `undefined` e o ufrag caía no token de 260 chars.
 * 4. A referência (`whatsapp-rust`, `voip/engine.rs`) é explícita:
 *
 *    "`auth_token_id` is an ordinary index, exactly as `token_id` is: both
 *     **default to 0** when the attribute is absent, and slot 0 is a real slot.
 *     It is *not* a sentinel -- treating it as one would **blank the ufrag for
 *     every offer that omits the attribute, which is the common shape**."
 *
 * Ausente = 0 (slot real), não `undefined`.
 *
 * ## Como este teste mede
 *
 * Pelo comportamento observável: intercepta o `setRemoteDescription` do wrtc e
 * lê o `a=ice-ufrag` que o transporte realmente entrega ao relay.
 *
 * Run: node --test tests/ice-ufrag-ausente.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = path.resolve(process.cwd());
const { RelayRtcTransport } = await import(pathToFileURL(path.join(raiz, 'dist/relay-transport.mjs')).href);

/** Tamanhos reais do WhatsApp: token ~193 bytes, auth_token ~70 bytes. */
const TOKEN_B64 = Buffer.alloc(193, 0xaa).toString('base64');   // 260 chars
const AUTH_B64 = Buffer.alloc(70, 0xbb).toString('base64');     // 96 chars

/** Captura o SDP sintético e as rejeições sem tratamento. */
const medir = async (relay) => {
    const modulo = await import('@roamhq/wrtc');
    const wrtc = modulo.default ?? modulo;
    const PC = wrtc.RTCPeerConnection;

    let sdp = null;
    const rejeicoes = [];
    const onRej = (r) => rejeicoes.push(String(r?.message || r));
    process.on('unhandledRejection', onRej);

    const orig = PC.prototype.setRemoteDescription;
    PC.prototype.setRemoteDescription = function (d) {
        if (d?.type === 'answer' && d?.sdp && !sdp) sdp = d.sdp;
        return orig.call(this, d);
    };

    const eventos = [];
    const t = new RelayRtcTransport({
        onTransportMessage: () => {},
        onIceRtt: () => {},
        onStage: (stage, d) => eventos.push({ stage, ...d }),
    });

    try {
        t.updateRelayList(relay);
        await new Promise((r) => setTimeout(r, 3500));
        try { await t.closeAll?.(); } catch { /* ignore */ }
    } finally {
        PC.prototype.setRemoteDescription = orig;
        process.off('unhandledRejection', onRej);
    }

    const ufrag = sdp ? (/a=ice-ufrag:([^\r\n]*)/.exec(sdp)?.[1] ?? '') : null;
    return { sdp, ufrag, rejeicoes, eventos };
};

/** Relay list SEM `auth_token_id` — "the common shape", segundo a referência. */
const semIndice = () => ({
    relay_key: Buffer.alloc(16, 0x10).toString('base64'),
    relay_tokens: [TOKEN_B64],
    auth_tokens: [AUTH_B64],
    relays: [{
        relay_id: 0, token_id: 0, relay_name: 'dus1c01',
        addresses: [{ protocol: 0, ipv4: '157.240.27.52', port: 3480 }]
    }]
});

describe('ice-ufrag com auth_token_id ausente', () => {
    it('usa o auth_token (slot 0), não o token de alocação', async () => {
        const { ufrag, eventos } = await medir(semIndice());

        const sel = eventos.find((e) => e.stage === 'endpoint_selecionado');
        assert.equal(sel?.authTokenLen, AUTH_B64.length,
            'auth_token_id ausente precisa valer 0 (slot real), não undefined');
        assert.ok(ufrag, 'o SDP precisa ter sido aceito');
        assert.equal(ufrag, AUTH_B64, 'o ufrag é o auth_token');
    });

    it('o ufrag respeita o limite do ICE (4..256 chars)', async () => {
        const { ufrag, sdp, rejeicoes } = await medir(semIndice());

        // O wrtc recusa com "ICE ufrag must be between 4 and 256 characters long".
        assert.ok(sdp, 'o SDP precisa ter sido ACEITO (sem o erro do log do dono)');
        assert.ok(ufrag.length >= 4 && ufrag.length <= 256,
            `ufrag fora do limite do ICE: ${ufrag.length} chars`);
        assert.equal(rejeicoes.length, 0, `não pode haver rejeição sem tratamento: ${rejeicoes[0]}`);
    });
});
