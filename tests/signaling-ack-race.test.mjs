/**
 * Does the outbound call stanza lose its server ack?
 *
 * The ack is a WebSocket frame. Sending first and only then registering
 * `waitForMessage` leaves a window in which a fast ack arrives with no listener
 * and is dropped. The engine then never learns the server accepted the offer,
 * the setup stalls, and the call dies a few seconds later with `call_result: 4`
 * / `call_setup_error_type: 1` — the "conectando..." that never finishes.
 *
 * The socket's own `query()` registers the wait BEFORE sending, for this exact
 * reason. This test drives the bridge with a fake socket that acks DURING
 * `sendNode` (the worst case) and asserts the ack still reaches the engine.
 *
 * Run: node --test tests/signaling-ack-race.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SignalingBridge } from '../dist/signaling.mjs';

const CALL_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GROUP = '120363411251996986@g.us';
const SELF_LID = '156535032389744:14@lid';

/**
 * A socket that acks synchronously inside `sendNode`, i.e. before the caller
 * could possibly have awaited anything after the send.
 */
const makeSock = () => {
    const listeners = new Map();
    const stats = { acksSent: 0 };
    return {
        stats,
        authState: {
            creds: { me: { id: '5511900000001@s.whatsapp.net', lid: SELF_LID } },
            keys: { set: async () => {} }
        },
        signalRepository: {
            lidMapping: { getPNForLID: async () => null, getLIDForPN: async () => null }
        },
        generateMessageTag: () => `TAG-${Math.random().toString(36).slice(2)}`,
        sendNode: async (node) => {
            const id = node.attrs?.id;
            const listener = listeners.get(`TAG:${id}`);
            if (listener) {
                stats.acksSent += 1;
                listener({ tag: 'ack', attrs: { id, class: 'call' } });
            }
        },
        waitForMessage: async (tag, timeoutMs) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve(undefined), Math.min(timeoutMs, 400));
            listeners.set(`TAG:${tag}`, (node) => {
                clearTimeout(timer);
                resolve(node);
            });
        }),
        getUSyncDevices: async () => [],
        presenceSubscribe: async () => {},
        ws: { on: () => {}, off: () => {} },
        ev: { on: () => {} }
    };
};

/** The group offer the engine emits, wrapped the way the bridge receives it. */
const groupOfferPayload = async () => {
    const baileys = await import('@whiskeysockets/baileys');
    const { encodeBinaryNode } = baileys;
    return encodeBinaryNode({
        tag: 'offer',
        attrs: { 'call-id': CALL_ID, 'call-creator': SELF_LID, 'group-jid': GROUP },
        content: [
            { tag: 'audio', attrs: { enc: 'opus', rate: '8000' } },
            { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
            { tag: 'net', attrs: { medium: '3' } },
            {
                tag: 'group_info',
                attrs: {},
                content: [
                    {
                        tag: 'user',
                        attrs: { jid: '156535032389744@lid' },
                        content: [{
                            tag: 'device',
                            attrs: { jid: SELF_LID },
                            content: [{ tag: 'capability', attrs: { ver: '1' }, content: new Uint8Array([1, 5, 247, 9, 224, 187, 19]) }]
                        }]
                    },
                    { tag: 'user', attrs: { jid: '242653052539031@lid' }, content: [{ tag: 'device', attrs: { jid: '242653052539031:1@lid' } }] },
                    { tag: 'user', attrs: { jid: '74170125783269@lid' }, content: [{ tag: 'device', attrs: { jid: '74170125783269@lid' } }] }
                ]
            }
        ]
    });
};

describe('outbound call stanza ack', () => {
    it('delivers an ack that arrives while the stanza is still being sent', async () => {
        const sock = makeSock();
        const bridge = new SignalingBridge({ sock });
        await bridge.init();

        let received = 0;
        let missing = 0;
        bridge.onAckReceived = () => { received += 1; };
        bridge.onAckMissing = () => { missing += 1; };

        await bridge.sendSignalingChecked(`${CALL_ID}@call`, CALL_ID, await groupOfferPayload());
        // Let the detached ack task settle.
        await new Promise((r) => setTimeout(r, 700));

        assert.equal(sock.stats.acksSent, 1, 'o servidor falso precisa ter mandado o ack');
        assert.equal(received, 1, 'o ack precisa chegar ao motor (era perdido antes)');
        assert.equal(missing, 0, 'não pode ser reportado como ack ausente');
    });

    it('still reports a missing ack when the server never answers', async () => {
        const sock = makeSock();
        // A socket whose server never acks.
        sock.sendNode = async () => {};
        const bridge = new SignalingBridge({ sock });
        await bridge.init();

        let missing = 0;
        bridge.onAckMissing = () => { missing += 1; };
        bridge.onAckReceived = () => {};

        await bridge.sendSignalingChecked(`${CALL_ID}@call`, CALL_ID, await groupOfferPayload());
        await new Promise((r) => setTimeout(r, 700));

        assert.equal(missing, 1, 'sem ack, o motor precisa ser avisado');
    });
});
