/**
 * O `enc_rekey` real chega cifrado e destrava a mídia.
 *
 * Medido contra a referência (`ParseGroupCallEncRekey`): o epoch vem como
 *
 *   <enc_rekey call-id call-creator transaction-id>
 *     <encopt keygen="2"/>
 *     <enc type="msg|pkmsg" v="2">CIPHERTEXT</enc>
 *   </enc_rekey>
 *
 * A versão anterior procurava um filho `<key>` CRU de 32 bytes, que não existe
 * nesse formato. Resultado: o epoch nunca era aceito, a mídia ficava presa em
 * `sem_epoch_de_chave` e o número do bot ficava "conectando..." para sempre.
 *
 * Run: node --test tests/enc-rekey-cifrado.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyKeyEpoch, parseGroupUpdate, applyGroupUpdate, mediaReady } from '../dist/group-bridge.mjs';

const CALL_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SELF_LID = '100000000000001:14@lid';
const SELF_BARE = '100000000000001@lid';
const GROUP = '120363411251996986@g.us';
const PEER = '200000000000002@lid';

/** Roster com relay + um remoto conectado com PID. */
const rosterComRelay = () => parseGroupUpdate({
    tag: 'group_update',
    attrs: {},
    content: [
        {
            tag: 'group_info',
            attrs: {
                'call-id': CALL_ID, 'call-creator': SELF_LID, 'transaction-id': '21',
                'group-jid': GROUP, media: 'audio', self_pid: '0'
            },
            content: [
                { tag: 'user', attrs: { jid: SELF_BARE, state: 'connected' }, content: [{ tag: 'device', attrs: { jid: SELF_LID, pid: '0' } }] },
                { tag: 'user', attrs: { jid: PEER, state: 'connected' }, content: [{ tag: 'device', attrs: { jid: '200000000000002:1@lid', pid: '1' } }] }
            ]
        },
        {
            tag: 'relay',
            attrs: { 'transaction-id': '1', self_pid: '0' },
            content: [
                { tag: 'key', attrs: {}, content: new Uint8Array(24).fill(7) },
                { tag: 'token', attrs: { id: '0' }, content: new Uint8Array(193).fill(1) },
                { tag: 'te2', attrs: { relay_id: '0', token_id: '0', relay_name: 'zrh' }, content: new Uint8Array([157, 240, 17, 133, 0x0d, 0x96]) }
            ]
        }
    ]
});

describe('epoch de chave (enc_rekey cifrado)', () => {
    it('aceita o ciphertext do <enc> como epoch', () => {
        const session = {};
        const ciphertext = new Uint8Array(48).fill(9);
        const r = applyKeyEpoch(session, { transactionId: 14, key: ciphertext });
        assert.equal(r.applied, true, 'o formato real precisa ser aceito');
        assert.equal(session.keyEpochTransactionId, 14);
    });

    it('roster + relay + epoch cifrado = mídia pronta', () => {
        // O caminho que destrava o "conectando...": o ack traz roster+relay, o
        // enc_rekey traz o epoch. Com os três, a mídia fica pronta.
        const session = { relay: null };
        const parsed = rosterComRelay();
        const applied = applyGroupUpdate(session, parsed, SELF_LID);
        assert.equal(applied.applied, true);

        // Sem epoch ainda: não está pronta (e diz exatamente o porquê).
        const semEpoch = mediaReady({
            relay: parsed.relay, groupInfo: parsed.groupInfo, hasKeyEpoch: false, selfJid: SELF_LID
        });
        assert.equal(semEpoch.ready, false);
        assert.equal(semEpoch.reason, 'sem_epoch_de_chave');

        // Com o epoch cifrado aceito: pronta.
        const epoch = applyKeyEpoch(session, { transactionId: 14, key: new Uint8Array(48).fill(9) });
        assert.equal(epoch.applied, true);

        const pronto = mediaReady({
            relay: parsed.relay, groupInfo: parsed.groupInfo, hasKeyEpoch: Boolean(session.keyEpoch), selfJid: SELF_LID
        });
        assert.equal(pronto.ready, true, 'com roster + relay + epoch a mídia fica pronta');
        assert.ok(pronto.endpoint, 'com endpoint de relay utilizável');
        assert.ok(pronto.peer, 'com o remoto que vai ouvir');
    });

    it('ignora epoch de transação mais antiga', () => {
        const session = {};
        applyKeyEpoch(session, { transactionId: 16, key: new Uint8Array(48).fill(1) });
        const velho = applyKeyEpoch(session, { transactionId: 14, key: new Uint8Array(48).fill(2) });
        assert.equal(velho.applied, false);
        assert.equal(velho.reason, 'epoch_antigo');
    });
});
