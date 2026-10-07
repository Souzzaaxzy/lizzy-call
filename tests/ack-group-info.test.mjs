/**
 * O ACK de um offer de grupo traz o roster inicial?
 *
 * Este é o caminho que destrava o "conectando...". A referencia (meowcaller,
 * `ParseInitialGroupCallAck`) mostra que o servidor responde ao offer de grupo
 * com um `ack` contendo `<group_info>` (roster, `self_pid`, transaction-id) e
 * `<relay>` (chave, tokens, endpoints `te2`).
 *
 * Antes desta correcao o ack era repassado ao motor como base64 cru e o
 * `<group_info>` nunca era lido: o motor ficava SEM roster e SEM relay, entao a
 * chamada existia no servidor mas nao tinha caminho de midia — o numero do bot
 * ficava "conectando..." indefinidamente.
 *
 * Run: node --test tests/ack-group-info.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SignalingBridge } from '../dist/signaling.mjs';

const CALL_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';
const PEER = '200000000000002@lid';

/** Um ACK de offer de grupo: `group_info` + `relay`, como o servidor manda. */
const ackComGroupInfo = () => ({
    tag: 'ack',
    attrs: { id: 'X', class: 'call', type: 'offer' },
    content: [
        {
            tag: 'group_info',
            attrs: {
                'call-id': CALL_ID,
                'call-creator': SELF_LID,
                'transaction-id': '21',
                'group-jid': GROUP,
                media: 'audio',
                'connected-limit': '32',
                self_pid: '0'
            },
            content: [
                { tag: 'user', attrs: { jid: '100000000000001@lid', state: 'connected' }, content: [{ tag: 'device', attrs: { jid: SELF_LID, pid: '0' } }] },
                { tag: 'user', attrs: { jid: PEER, state: 'connected' }, content: [{ tag: 'device', attrs: { jid: '200000000000002:1@lid', pid: '1' } }] }
            ]
        },
        {
            tag: 'relay',
            attrs: { 'transaction-id': '1', self_pid: '0', uuid: 'u', participant_uuid: 'pu' },
            content: [
                { tag: 'key', attrs: {}, content: new Uint8Array(24).fill(7) },
                { tag: 'token', attrs: { id: '0' }, content: new Uint8Array(193).fill(1) },
                { tag: 'te2', attrs: { relay_id: '0', token_id: '0', relay_name: 'zrh' }, content: new Uint8Array([157, 240, 17, 133, 0x0d, 0x96]) }
            ]
        }
    ]
});

/** Socket minimo: ack sincrono + listeners de TAG. */
const makeSock = () => {
    const listeners = new Map();
    const sock = {
        authState: {
            creds: { me: { id: '5511900000001@s.whatsapp.net', lid: SELF_LID } },
            keys: { set: async () => {} }
        },
        signalRepository: { lidMapping: { getPNForLID: async () => null, getLIDForPN: async () => null } },
        generateMessageTag: () => 'TAG-1',
        sendNode: async (node) => {
            const l = listeners.get(`TAG:${node.attrs?.id}`);
            if (l) l(ackComGroupInfo());
        },
        waitForMessage: async (tag, timeoutMs) => new Promise((resolve) => {
            const t = setTimeout(() => resolve(undefined), Math.min(timeoutMs, 400));
            listeners.set(`TAG:${tag}`, (node) => { clearTimeout(t); resolve(node); });
        }),
        getUSyncDevices: async () => [],
        presenceSubscribe: async () => {},
        ws: { on: () => {}, off: () => {} },
        ev: { on: () => {} }
    };
    return sock;
};

const offerPayload = async () => {
    const baileys = await import('@itsliaaa/baileys');
    return baileys.encodeBinaryNode({
        tag: 'offer',
        attrs: { 'call-id': CALL_ID, 'call-creator': SELF_LID, 'group-jid': GROUP },
        content: [
            { tag: 'audio', attrs: { enc: 'opus', rate: '8000' } },
            { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
            { tag: 'net', attrs: { medium: '3' } },
            { tag: 'group_info', attrs: {}, content: [] }
        ]
    });
};

describe('ACK de offer de grupo', () => {
    it('entrega o group_info e o relay do ack', async () => {
        const sock = makeSock();
        const bridge = new SignalingBridge({ sock });
        await bridge.init();

        let recebido = null;
        bridge.onGroupInfoFromAck = (payload) => { recebido = payload; };

        await bridge.sendSignalingChecked(`${CALL_ID}@call`, CALL_ID, await offerPayload());
        await new Promise((r) => setTimeout(r, 500));

        assert.ok(recebido, 'o ack precisa entregar o group_info (antes era ignorado)');
        assert.ok(recebido.relay, 'o relay do ack precisa ser entregue junto');
        assert.equal(recebido.groupInfo.tag, 'group_update', 'entra no formato que o parser espera');
        assert.equal(recebido.groupInfo.attrs['call-id'], CALL_ID);
        assert.equal(recebido.groupInfo.attrs['transaction-id'], '21');
    });

    it('o formato entregue é parseável pelo group-bridge', async () => {
        const sock = makeSock();
        const bridge = new SignalingBridge({ sock });
        await bridge.init();

        let entregue = null;
        bridge.onGroupInfoFromAck = (p) => { entregue = p; };
        await bridge.sendSignalingChecked(`${CALL_ID}@call`, CALL_ID, await offerPayload());
        await new Promise((r) => setTimeout(r, 500));

        const { parseGroupUpdate } = await import('../dist/group-bridge.mjs');
        const parsed = parseGroupUpdate(entregue.groupInfo);

        assert.ok(parsed, 'o parser precisa reconhecer o nó');
        assert.equal(parsed.groupInfo.transactionId, 21, 'o roster traz o transaction-id');
        assert.equal(parsed.groupInfo.users.length, 2, 'traz os participantes');
        assert.ok(parsed.relay, 'traz a alocação de relay');
        assert.ok(parsed.relay.endpoints.length, 'com endpoint utilizável');
    });

    it('não entrega nada quando o ack não tem group_info', async () => {
        const sock = makeSock();
        sock.sendNode = async (node) => {
            const l = (sock._listeners ||= new Map()).get?.(`TAG:${node.attrs?.id}`);
            void l;
        };
        // Ack sem group_info: um ack simples de 1:1.
        sock.waitForMessage = async () => ({ tag: 'ack', attrs: { id: 'X', class: 'call' }, content: [] });
        const bridge = new SignalingBridge({ sock });
        await bridge.init();

        let chamado = false;
        bridge.onGroupInfoFromAck = () => { chamado = true; };
        await bridge.sendSignalingChecked(`${CALL_ID}@call`, CALL_ID, await offerPayload());
        await new Promise((r) => setTimeout(r, 400));

        assert.equal(chamado, false, 'sem group_info não há roster para aplicar');
    });
});
