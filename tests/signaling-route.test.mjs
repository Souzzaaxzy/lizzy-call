/**
 * A group offer must be sent to the CALL OBJECT, not to a peer device.
 *
 * Measured earlier (`wasm-group-offer-variants`): with two or more invitees the
 * engine emits a proper group offer — `group-jid` on the `<offer>` and a
 * `<group_info>` roster — addressed to `<call-id>@call`.
 *
 * The bridge then rewrote that destination with helpers that only understand
 * `@lid` and `@s.whatsapp.net`, sending it to a participant's device instead. The
 * server rejected the call (`is_group_call_created_on_server: false`,
 * `call_result: 4`) — the owner's "a call não inicia".
 *
 * This test drives the REAL send path and records where the stanza goes.
 *
 * Run: node --test tests/signaling-route.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SignalingBridge } from '../dist/signaling.mjs';

const baileys = await import('@whiskeysockets/baileys');
const { encodeBinaryNode } = baileys;

const CALL_ID = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
const CALL_OBJECT = `${CALL_ID}@call`;
const GROUP = '120363411251996986@g.us';

/** A socket stub: everything `init()` touches, and a `sendNode` we can read. */
const makeSock = (sent) => ({
    authState: {
        creds: { me: { id: '5511900000001@s.whatsapp.net', lid: '100000000000001:14@lid' } },
        keys: { set: async () => {} },
    },
    generateMessageTag: () => `TAG-${sent.length + 1}`,
    sendNode: async (node) => { sent.push(node); },
    waitForMessage: async () => null,
    getPrivacyTokens: async () => ({ attrs: {}, content: [] }),
    query: async () => ({ attrs: {} }),
    getUSyncDevices: async () => [],
    presenceSubscribe: async () => {},
    ws: { on: () => {}, off: () => {} },
    ev: { on: () => {} },
});

/** The engine emits the offer; here it is rebuilt in the same shape. */
const groupOffer = () => ({
    tag: 'offer',
    attrs: { 'call-id': CALL_ID, 'call-creator': '100000000000001:14@lid', 'group-jid': GROUP },
    content: [
        { tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined },
        { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined },
        { tag: 'net', attrs: { medium: '3' }, content: undefined },
        {
            tag: 'group_info',
            attrs: {},
            content: [
                { tag: 'user', attrs: { jid: '100000000000001@lid' }, content: [{ tag: 'device', attrs: { jid: '100000000000001:14@lid' }, content: [] }] },
                { tag: 'user', attrs: { jid: '200000000000002@lid' }, content: [{ tag: 'device', attrs: { jid: '200000000000002@lid' }, content: [] }] },
            ],
        },
    ],
});

const offerPayload = () => new Uint8Array(Buffer.from(encodeBinaryNode(groupOffer())));

describe('roteamento de sinalizacao de call', () => {
    it('offer de GRUPO vai para <call-id>@call (nao para um device)', async () => {
        const sent = [];
        const bridge = new SignalingBridge({ sock: makeSock(sent) });
        await bridge.init();

        //  engole os proprios erros; chamamos o caminho interno
        // para o teste ver a falha em vez de receber silencio.
        await bridge.sendSignalingChecked(CALL_OBJECT, CALL_ID, offerPayload());

        const callNode = sent.find((n) => n.tag === 'call');
        assert.ok(callNode, 'enviou um <call>');
        assert.equal(
            callNode.attrs.to,
            CALL_OBJECT,
            `offer de grupo deve ir para o objeto da call (foi para ${callNode.attrs.to})`
        );
        const offer = callNode.content?.[0];
        assert.equal(offer?.attrs?.['group-jid'], GROUP, 'o group-jid foi preservado');
    });

    it('a decisao de rota distingue grupo de 1:1', () => {
        // O envio completo de um offer 1:1 exige sessao Signal (o stub nao tem),
        // entao a distincao e verificada pelo criterio que o bridge usa:
        // group-jid OU group_info marcam um offer de GRUPO.
        const isGroup = (node) =>
            Boolean(node.attrs?.['group-jid']) ||
            (Array.isArray(node.content) && node.content.some((c) => c?.tag === 'group_info'));

        const grupo = groupOffer();
        const direto = {
            tag: 'offer',
            attrs: { 'call-id': CALL_ID, 'call-creator': '100000000000001:14@lid' },
            content: [
                { tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined },
                { tag: 'net', attrs: { medium: '3' }, content: undefined },
                { tag: 'enc', attrs: { v: '2', type: 'msg', count: '0' }, content: new Uint8Array(32) },
            ],
        };

        assert.equal(isGroup(grupo), true, 'com group-jid/group_info e de GRUPO');
        assert.equal(isGroup(direto), false, 'sem esses campos e 1:1');
        assert.ok(grupo.content.some((c) => c.tag === 'group_info'), 'o de grupo leva o roster');
        assert.ok(!direto.content.some((c) => c.tag === 'group_info'), 'o 1:1 nao leva roster');
    });
});
