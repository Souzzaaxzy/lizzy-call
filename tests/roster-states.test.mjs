/**
 * O ESTADO do participante no roster: presente ≠ `connected`.
 *
 * ## O defeito que este teste trava (`participantes=3 conectados=1`, `peer_state error=500`)
 *
 * O log do dono mostrou:
 *
 *   [CALLP] roster tx=11 participantes=3 conectados=1 midia=false
 *   [CALLP] mídia não ficou pronta em 30s (sem_remoto_conectado_com_pid)
 *   [CALLP] ack de peer_state (id=…) error=500
 *
 * A causa: o parser aceitava **só** `state === 'connected'`. O usuário que
 * ENTROU na call aparece no roster com outro estado de PRESENÇA (`visible`,
 * `outgoing`, `invited`, `receipt`…) antes de virar `connected` — e portanto não
 * contava. Sem remoto "conectado com pid", a mídia nunca ficava pronta, o motor
 * reportava o peer como **invisível** e o servidor respondia `error=500` e
 * **expulsava** quem estava na call.
 *
 * A referência (`@zapo-js/voip-media`) lista os estados de presença — este teste
 * trava a lista.
 *
 * Run: node --test tests/roster-states.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.cwd(), 'dist/group-bridge.mjs')).href);
const { parseGroupInfo, mediaReady, WA_CALL_PRESENT_STATES } = mod;

/** Monta um `<group_info>` com um usuário remoto no estado dado, com pid. */
const roster = (estado, { self = '111@lid', remoto = '222@lid' } = {}) => ({
    tag: 'group_info',
    attrs: { 'call-id': 'C1', media: 'audio', 'transaction-id': '1' },
    content: [
        { tag: 'user', attrs: { jid: self, state: 'connected' },
          content: [{ tag: 'device', attrs: { jid: self, pid: '1' } }] },
        { tag: 'user', attrs: { jid: remoto, state: estado },
          content: [{ tag: 'device', attrs: { jid: remoto, pid: '2' } }] }
    ]
});

const RELAY = {
    tokens: [{ id: 0 }],
    endpoints: [{ relayId: 0, tokenId: 0, authTokenId: 0, ipv4: '1.2.3.4', port: 3478, isFna: false }]
};

describe('estado do participante no roster', () => {
    it('a lista de PRESENÇA segue a referência', () => {
        for (const s of ['connected', 'outgoing', 'receipt', 'creating', 'invisible', 'visible', 'invited']) {
            assert.ok(WA_CALL_PRESENT_STATES.includes(s), `${s} e' presenca`);
        }
        for (const s of ['terminated', 'invalid', 'rejected', 'timedout', 'cancel_offer']) {
            assert.ok(!WA_CALL_PRESENT_STATES.includes(s), `${s} NAO e' presenca (e' saida)`);
        }
    });

    it('`visible` conta como presente (o caso do log: participantes=3 conectados=1)', () => {
        const info = parseGroupInfo(roster('visible'));
        const remoto = info.users.find((u) => u.bare === '222@lid');
        assert.equal(remoto.connected, true,
            'quem ENTROU pode aparecer como `visible` — tem de contar');
    });

    it('`outgoing` e `invited` também contam', () => {
        for (const s of ['outgoing', 'invited']) {
            const info = parseGroupInfo(roster(s));
            const remoto = info.users.find((u) => u.bare === '222@lid');
            assert.equal(remoto.connected, true, `${s} e' presenca`);
        }
    });

    it('`terminated` NÃO conta (é saída)', () => {
        const info = parseGroupInfo(roster('terminated'));
        const remoto = info.users.find((u) => u.bare === '222@lid');
        assert.equal(remoto.connected, false, 'quem saiu nao pode contar');
    });

    it('com um remoto `visible` a mídia FICA pronta (era o gate do bug)', () => {
        const info = parseGroupInfo(roster('visible'));
        const r = mediaReady({ relay: RELAY, groupInfo: info, hasKeyEpoch: true, selfJid: '111@lid' });
        assert.equal(r.ready, true,
            `com presenca a midia fica pronta (veio ${r.reason})`);
        assert.ok(r.peer, 'e elege o peer');
    });

    it('CONTROLE: sem ninguém presente a mídia NÃO fica pronta', () => {
        const info = parseGroupInfo(roster('terminated'));
        const r = mediaReady({ relay: RELAY, groupInfo: info, hasKeyEpoch: true, selfJid: '111@lid' });
        assert.equal(r.ready, false, 'sem remoto presente nao ha caminho de midia');
        assert.equal(r.reason, 'sem_remoto_conectado_com_pid', 'motivo exato');
    });
});
