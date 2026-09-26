/**
 * The roster handed to the engine for a group call.
 *
 * Two defects are locked down here, both about the identity data the engine
 * receives when `startVoipGroupCall` is called:
 *
 *   1. `entrarNaCall` fabricated the roster from the member JIDs alone — every
 *      participant got `pn: null` and a single device equal to its own account
 *      JID. On a modern group the members are LIDs, so the engine was handed
 *      LIDs in the phone-number slot and a device list that never came from
 *      device discovery.
 *   2. `buildParticipantLists` filled the PN slot with `user.pn || user.jid`,
 *      turning it into a copy of the LID list whenever the roster had no
 *      `user_pn` — the normal case.
 *
 * Run: node --test tests/roster.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCallRoster } from '../dist/group-media.mjs';
import { buildParticipantLists } from '../dist/group-bridge.mjs';

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const SELF_BARE_LID = '100000000000001@lid';

const PEER_A_LID = '242653052539031@lid';
const PEER_A_PN = '5511911111111@s.whatsapp.net';
const PEER_B_LID = '74170125783269@lid';

/** A socket that answers the LID->PN mapping and the device query. */
const fakeSock = () => ({
    authState: { creds: { me: { id: SELF_PN, lid: SELF_LID } }, keys: { set: async () => {} } },
    signalRepository: {
        lidMapping: {
            getPNsForLIDs: async (lids) => lids.map((lid) => ({
                lid,
                pn: lid === PEER_A_LID ? PEER_A_PN : null
            }))
        }
    },
    getUSyncDevices: async (jids) => jids.flatMap((jid) => {
        const bare = String(jid).split('@')[0].split(':')[0];
        if (bare === PEER_A_LID.split('@')[0]) {
            return [
                { jid: PEER_A_LID, device: 0, server: 'lid' },
                { jid: '242653052539031:1@lid', device: 1, server: 'lid' }
            ];
        }
        if (bare === SELF_BARE_LID.split('@')[0]) {
            return [{ jid: SELF_LID, device: 14, server: 'lid' }];
        }
        return [];
    })
});

describe('buildCallRoster', () => {
    it('resolves the phone number of a LID participant', async () => {
        const roster = await buildCallRoster([PEER_A_LID, PEER_B_LID], SELF_LID, fakeSock());
        const a = roster.find((u) => u.jid === PEER_A_LID);
        assert.equal(a?.pn, PEER_A_PN, 'o PN conhecido precisa ser resolvido');
        // A participant with no mapping keeps a null PN rather than a fake one.
        const b = roster.find((u) => u.jid === PEER_B_LID);
        assert.equal(b?.pn, null);
    });

    it('takes the device list from device discovery, not from the account JID', async () => {
        const roster = await buildCallRoster([PEER_A_LID], SELF_LID, fakeSock());
        const a = roster.find((u) => u.jid === PEER_A_LID);
        assert.deepEqual(a?.devices.map((d) => d.jid), [PEER_A_LID, '242653052539031:1@lid']);
    });

    it('nunca inclui o próprio bot na lista de convidados', async () => {
        // Regressão medida (`measure-self-in-roster.mjs`): com o JID do bot na
        // lista, `startVoipGroupCall` emite ZERO stanzas e a chamada nunca sobe.
        const roster = await buildCallRoster([SELF_BARE_LID, SELF_LID, PEER_A_LID], SELF_LID, fakeSock());
        const jids = roster.map((u) => u.jid);
        assert.ok(!jids.includes(SELF_BARE_LID), 'o bot não pode ser convidado de si mesmo');
        assert.deepEqual(jids, [PEER_A_LID], 'só os outros entram');
    });

    it('deduplica convidados repetidos', async () => {
        const roster = await buildCallRoster([PEER_A_LID, PEER_A_LID, PEER_B_LID], SELF_LID, fakeSock());
        assert.deepEqual(roster.map((u) => u.jid), [PEER_A_LID, PEER_B_LID]);
    });

    it('survives a socket that cannot answer the queries', async () => {
        const roster = await buildCallRoster([PEER_A_LID], SELF_LID, {});
        assert.equal(roster.length, 1, 'o convidado entra mesmo sem PN/devices');
        const a = roster.find((u) => u.jid === PEER_A_LID);
        assert.ok(a?.devices.length, 'nunca fica sem device (o engine rejeita)');
    });
});

describe('buildParticipantLists', () => {
    const roster = {
        transactionId: 21,
        users: [
            { jid: SELF_BARE_LID, bare: SELF_BARE_LID, pn: null, state: 'connected', devices: [{ jid: SELF_LID, pid: 0 }] },
            { jid: PEER_A_LID, bare: PEER_A_LID, pn: PEER_A_PN, state: 'connected', devices: [{ jid: '242653052539031:1@lid', pid: 1 }] },
            { jid: PEER_B_LID, bare: PEER_B_LID, pn: null, state: 'connected', devices: [{ jid: PEER_B_LID, pid: 2 }] }
        ]
    };

    it('uses the resolved phone number in the PN slot', () => {
        const lists = buildParticipantLists(roster, SELF_LID);
        assert.ok(lists.pnUserJids.includes(PEER_A_PN), 'o PN resolvido precisa estar em pnUserJids');
    });

    it('keeps the three lists aligned, because the engine zips by index', () => {
        const lists = buildParticipantLists(roster, SELF_LID);
        assert.equal(lists.pnUserJids.length, lists.lidUserJids.length);
        assert.equal(lists.pnUserJids.length, lists.deviceJidsCsv.length);
    });

    it('keeps every account LID in the LID slot', () => {
        const lists = buildParticipantLists(roster, SELF_LID);
        for (const u of roster.users) {
            assert.ok(lists.lidUserJids.includes(u.jid), `lid ${u.jid} ausente`);
        }
    });
});
