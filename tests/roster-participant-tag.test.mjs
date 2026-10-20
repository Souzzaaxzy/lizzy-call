/**
 * O roster pode vir como `<user>` OU `<participant>`.
 *
 * ## O defeito que este teste trava
 *
 * A especificação do `<group_info>` usa `<user>` no roster INICIAL e
 * `<participant>` nos `group_update` seguintes (e o servidor recusa os dois
 * juntos). O parser lia **só `<user>`** — então um `group_update` em
 * `<participant>` virava roster **VAZIO**: sem participante, sem device e sem
 * `pid`. A mídia nunca ficava pronta (`sem_remoto_conectado_com_pid`), mesmo com
 * o log já dizendo `conectados=3`.
 *
 * A referência (`@zapo-js/voip-media`, `parseGroupInfoNode`) aceita as duas.
 *
 * Run: node --test tests/roster-participant-tag.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.cwd(), 'dist/group-bridge.mjs')).href);
const { parseGroupInfo, mediaReady } = mod;

/** Monta um `<group_info>` com a TAG dada, um remoto conectado e com pid. */
const info = (tag) => ({
    tag: 'group_info',
    attrs: { 'call-id': 'C1', media: 'audio', 'transaction-id': '1' },
    content: [
        { tag, attrs: { jid: '111@lid', state: 'connected' },
          content: [{ tag: 'device', attrs: { jid: '111@lid', pid: '1' } }] },
        { tag, attrs: { jid: '222@lid', state: 'connected' },
          content: [{ tag: 'device', attrs: { jid: '222@lid', pid: '99' } }] }
    ]
});

const RELAY = {
    tokens: [{ id: 0 }],
    endpoints: [{ relayId: 0, tokenId: 0, authTokenId: 0, ipv4: '1.2.3.4', port: 3478, isFna: false }]
};

describe('roster: <user> ou <participant>', () => {
    it('`<user>` (roster inicial) e lido', () => {
        const r = parseGroupInfo(info('user'));
        assert.equal(r.users.length, 2, 'os dois participantes entraram');
    });

    it('`<participant>` (group_update) TAMBEM e lido', () => {
        const r = parseGroupInfo(info('participant'));
        assert.equal(r.users.length, 2,
            'ler so <user> deixava o group_update vazio (era o defeito)');
    });

    it('com `<participant>` o pid do remoto chega (a midia fica pronta)', () => {
        const r = parseGroupInfo(info('participant'));
        const remoto = r.users.find((u) => u.bare === '222@lid');
        assert.ok(remoto, 'o remoto existe');
        assert.ok(remoto.devices.some((d) => Number.isFinite(d.pid)),
            'o device do remoto tem pid');
        const pronto = mediaReady({ relay: RELAY, groupInfo: r, hasKeyEpoch: true, selfJid: '111@lid' });
        assert.equal(pronto.ready, true, `a midia fica pronta (veio ${pronto.reason})`);
    });

    it('CONTROLE: um roster vazio continua vazio (nao inventa)', () => {
        const r = parseGroupInfo({ tag: 'group_info', attrs: { media: 'audio' }, content: [] });
        assert.equal(r.users.length, 0, 'sem usuario nao ha o que ler');
    });
});
