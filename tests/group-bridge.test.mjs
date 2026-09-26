/**
 * Group-bridge tests.
 *
 * The fixtures mirror the attribute paths published in the group-call captures
 * (`voip/group_update_ingest`), so a drift in the parser fails here rather than
 * during a live call.
 *
 * Run: node --test tests/group-bridge.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseGroupUpdate,
    parseGroupInfo,
    parseRelay,
    shouldApplyRoster,
    pickRelayEndpoint,
    mediaReady,
    buildParticipantLists,
    applyGroupUpdate,
    applyKeyEpoch,
    callObjectJid,
    bareJid,
    deviceOf
} from '../dist/group-bridge.mjs';

const SELF_LID = '156535032389744:14@lid';
const SELF_BARE = '156535032389744@lid';

/** One `<device>` child. */
const device = (jid, pid) => ({
    tag: 'device',
    attrs: { jid, ...(pid !== undefined ? { pid: String(pid), platform: 'web' } : {}) }
});

/** One `<user>` child. */
const user = (jid, state, devices, pn) => ({
    tag: 'user',
    attrs: { jid, state, ...(pn ? { user_pn: pn } : {}) },
    content: devices
});

/** A `group_update` node in the captured shape. */
const groupUpdate = ({
    transactionId = 21,
    groupJid = '120363411251996986@g.us',
    users = [],
    relay = null,
    media = 'audio',
    joinable = false,
    callId = '00DD63A26643DC3496FCBD161E6E2AB1',
    callCreator = SELF_LID
} = {}) => ({
    tag: 'group_update',
    attrs: { 'call-id': callId, 'call-creator': callCreator },
    content: [
        {
            tag: 'group_info',
            attrs: {
                'call-id': callId,
                'call-creator': callCreator,
                'transaction-id': String(transactionId),
                media,
                'connected-limit': '32',
                'group-jid': groupJid,
                ...(joinable ? { joinable: '1' } : {})
            },
            content: users
        },
        ...(relay ? [relay] : [])
    ]
});

/** A `<relay>` node with a 6-byte `te2` address (IPv4 + big-endian port). */
const relayNode = ({
    transactionId = 1,
    selfPid = 0,
    key = new Uint8Array(24).fill(7),
    tokenIds = [0],
    authTokenIds = [0],
    endpoints = [{ relayId: 0, tokenId: 0, authTokenId: 0, ip: [157, 240, 17, 133], port: 3478, isFna: false }]
} = {}) => ({
    tag: 'relay',
    attrs: { 'transaction-id': String(transactionId), self_pid: String(selfPid), uuid: 'u', participant_uuid: 'pu', warp_mi_tag_len: '4' },
    content: [
        { tag: 'key', attrs: {}, content: key },
        { tag: 'hbh_key', attrs: {}, content: new Uint8Array(16).fill(3) },
        ...tokenIds.map((id) => ({ tag: 'token', attrs: { id: String(id) }, content: new Uint8Array(193).fill(1) })),
        ...authTokenIds.map((id) => ({ tag: 'auth_token', attrs: { id: String(id) }, content: new Uint8Array(70).fill(2) })),
        ...endpoints.map((e) => ({
            tag: 'te2',
            attrs: {
                relay_id: String(e.relayId),
                token_id: String(e.tokenId),
                auth_token_id: String(e.authTokenId),
                relay_name: 'zrh',
                ...(e.isFna ? { is_fna: '1' } : {})
            },
            content: new Uint8Array([...e.ip, (e.port >> 8) & 0xff, e.port & 0xff])
        }))
    ]
});

describe('jid helpers', () => {
    it('addresses the call object', () => {
        assert.equal(callObjectJid('ABC'), 'ABC@call');
    });

    it('strips the device from a jid', () => {
        assert.equal(bareJid(SELF_LID), SELF_BARE);
        assert.equal(bareJid('x@s.whatsapp.net'), 'x@s.whatsapp.net');
        assert.equal(bareJid('nope'), null);
    });

    it('reads the device id', () => {
        assert.equal(deviceOf(SELF_LID), 14);
        assert.equal(deviceOf('x@s.whatsapp.net'), 0);
    });
});

describe('parseGroupInfo', () => {
    const node = groupUpdate({
        users: [
            user(SELF_BARE, 'connected', [device(SELF_LID, 0)]),
            user('242653052539031@lid', 'connected', [device('242653052539031@lid', 1), device('242653052539031:1@lid')]),
            user('74170125783269@lid', 'outgoing', [device('74170125783269@lid')])
        ]
    }).content[0];

    const info = parseGroupInfo(node);

    it('reads the roster transaction and group binding', () => {
        assert.equal(info.transactionId, 21);
        assert.equal(info.groupJid, '120363411251996986@g.us');
        assert.equal(info.media, 'audio');
        assert.equal(info.connectedLimit, 32);
    });

    it('reads users with their devices and pids', () => {
        assert.equal(info.users.length, 3);
        assert.equal(info.users[1].jid, '242653052539031@lid');
        assert.equal(info.users[1].devices.length, 2);
        assert.equal(info.users[1].devices[0].pid, 1);
        assert.equal(info.users[1].devices[0].platform, 'web');
        assert.equal(info.users[1].devices[1].pid, undefined, 'device without pid stays undefined');
    });

    it('marks only connected users as able to carry media', () => {
        assert.deepEqual(info.users.map((u) => u.connected), [true, true, false]);
    });
});

describe('parseRelay', () => {
    it('decodes the key, tokens and endpoints', () => {
        const relay = parseRelay(relayNode());
        assert.equal(relay.transactionId, 1);
        assert.equal(relay.selfPid, 0);
        assert.equal(relay.key.length, 24);
        assert.equal(relay.hbhKey.length, 16);
        assert.equal(relay.tokens.length, 1);
        assert.equal(relay.tokens[0].id, 0);
        assert.equal(relay.authTokens.length, 1);
        assert.equal(relay.endpoints.length, 1);
    });

    it('turns the 6-byte address into ipv4 + port', () => {
        const relay = parseRelay(relayNode());
        assert.equal(relay.endpoints[0].ipv4, '157.240.17.133');
        assert.equal(relay.endpoints[0].port, 3478);
    });

    it('returns null when there is no relay node', () => {
        assert.equal(parseRelay(null), null);
    });
});

describe('pickRelayEndpoint', () => {
    it('skips FNA endpoints and picks the first usable one', () => {
        const relay = parseRelay(relayNode({
            endpoints: [
                { relayId: 9, tokenId: 0, authTokenId: 0, ip: [10, 0, 0, 1], port: 1, isFna: true },
                { relayId: 0, tokenId: 0, authTokenId: 0, ip: [157, 240, 17, 133], port: 3478, isFna: false }
            ]
        }));
        assert.equal(pickRelayEndpoint(relay).relayId, 0);
    });

    it('rejects an endpoint whose token is not in the allocation', () => {
        const relay = parseRelay(relayNode({
            tokenIds: [0],
            endpoints: [{ relayId: 0, tokenId: 5, authTokenId: 0, ip: [1, 2, 3, 4], port: 99, isFna: false }]
        }));
        assert.equal(pickRelayEndpoint(relay), null);
    });
});

describe('shouldApplyRoster', () => {
    it('accepts the first snapshot', () => {
        assert.equal(shouldApplyRoster(undefined, 11), true);
    });

    it('accepts only increasing transactions', () => {
        assert.equal(shouldApplyRoster(11, 21), true);
        assert.equal(shouldApplyRoster(21, 21), false, 'same transaction is not newer');
        assert.equal(shouldApplyRoster(21, 11), false, 'stale snapshot must not tear down media');
    });

    it('rejects a missing transaction', () => {
        assert.equal(shouldApplyRoster(11, undefined), false);
    });
});

describe('mediaReady', () => {
    const withRemote = [
        user(SELF_BARE, 'connected', [device(SELF_LID, 0)]),
        user('242653052539031@lid', 'connected', [device('242653052539031@lid', 1)])
    ];

    it('is ready when epoch, relay and a connected remote with pid exist', () => {
        const info = parseGroupInfo(groupUpdate({ users: withRemote }).content[0]);
        const relay = parseRelay(relayNode());
        const r = mediaReady({ relay, groupInfo: info, hasKeyEpoch: true, selfJid: SELF_LID });
        assert.equal(r.ready, true);
        assert.equal(r.peer.jid, '242653052539031@lid');
    });

    it('is not ready without the key epoch', () => {
        const info = parseGroupInfo(groupUpdate({ users: withRemote }).content[0]);
        const relay = parseRelay(relayNode());
        const r = mediaReady({ relay, groupInfo: info, hasKeyEpoch: false, selfJid: SELF_LID });
        assert.equal(r.ready, false);
        assert.equal(r.reason, 'sem_epoch_de_chave');
    });

    it('is not ready without a relay allocation', () => {
        const info = parseGroupInfo(groupUpdate({ users: withRemote }).content[0]);
        const r = mediaReady({ relay: null, groupInfo: info, hasKeyEpoch: true, selfJid: SELF_LID });
        assert.equal(r.ready, false);
        assert.equal(r.reason, 'sem_alocacao_de_relay');
    });

    it('is not ready when only WE are connected', () => {
        const info = parseGroupInfo(groupUpdate({
            users: [user(SELF_BARE, 'connected', [device(SELF_LID, 0)])]
        }).content[0]);
        const relay = parseRelay(relayNode());
        const r = mediaReady({ relay, groupInfo: info, hasKeyEpoch: true, selfJid: SELF_LID });
        assert.equal(r.ready, false);
        assert.equal(r.reason, 'sem_remoto_conectado_com_pid');
    });
});

describe('buildParticipantLists', () => {
    it('keeps the three parallel lists aligned', () => {
        const info = parseGroupInfo(groupUpdate({
            users: [
                user('242653052539031@lid', 'connected', [device('242653052539031@lid', 1), device('242653052539031:1@lid')]),
                user('74170125783269@s.whatsapp.net', 'outgoing', [device('74170125783269@s.whatsapp.net')], '74170125783269@lid')
            ]
        }).content[0]);

        const lists = buildParticipantLists(info, SELF_LID);
        assert.equal(lists.pnUserJids.length, 2);
        assert.equal(lists.lidUserJids.length, 2);
        assert.equal(lists.deviceJidsCsv.length, 2);
        assert.equal(lists.lidUserJids[0], '242653052539031@lid');
        assert.equal(lists.deviceJidsCsv[0], '242653052539031@lid,242653052539031:1@lid');
    });
});

describe('applyGroupUpdate', () => {
    const update = parseGroupUpdate(groupUpdate({
        users: [
            user(SELF_BARE, 'connected', [device(SELF_LID, 0)]),
            user('242653052539031@lid', 'connected', [device('242653052539031@lid', 1)])
        ],
        relay: relayNode()
    }));

    it('applies the first snapshot and stores the relay', () => {
        const session = {};
        const result = applyGroupUpdate(session, update, SELF_LID);
        assert.equal(result.applied, true);
        assert.equal(result.transactionId, 21);
        assert.equal(result.participants, 2);
        assert.equal(result.connected, 2);
        assert.ok(session.relay, 'relay stored');
        assert.equal(session.groupJid, '120363411251996986@g.us');
    });

    it('reports readiness honestly (not ready until the epoch arrives)', () => {
        const session = {};
        const first = applyGroupUpdate(session, update, SELF_LID);
        assert.equal(first.readiness.ready, false);
        assert.equal(first.readiness.reason, 'sem_epoch_de_chave');

        applyKeyEpoch(session, { transactionId: 1, key: new Uint8Array(32).fill(9) });
        const again = applyGroupUpdate(session, update, SELF_LID);
        assert.equal(again.applied, false, 'same transaction is not re-applied');
    });

    it('ignores a stale transaction', () => {
        const session = { transactionId: 21 };
        const stale = parseGroupUpdate(groupUpdate({ transactionId: 11, users: [] }));
        const result = applyGroupUpdate(session, stale, SELF_LID);
        assert.equal(result.applied, false);
        assert.equal(result.reason, 'transacao_antiga');
    });
});

describe('applyKeyEpoch', () => {
    it('accepts a 32-byte epoch', () => {
        const session = {};
        const r = applyKeyEpoch(session, { transactionId: 14, key: new Uint8Array(32).fill(5), callId: 'C' });
        assert.equal(r.applied, true);
        assert.equal(session.keyEpoch.length, 32);
        assert.equal(session.keyEpochCallId, 'C');
    });

    it('rejects a short epoch', () => {
        const session = {};
        const r = applyKeyEpoch(session, { transactionId: 1, key: new Uint8Array(16) });
        assert.equal(r.applied, false);
        assert.equal(r.reason, 'epoch_curto');
    });

    it('rejects an older epoch', () => {
        const session = { keyEpoch: new Uint8Array(32), keyEpochTransactionId: 16 };
        const r = applyKeyEpoch(session, { transactionId: 14, key: new Uint8Array(32) });
        assert.equal(r.applied, false);
        assert.equal(r.reason, 'epoch_antigo');
    });
});
