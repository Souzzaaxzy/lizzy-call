/**
 * Group media session tests.
 *
 * Drives `GroupCallMedia` with a fake Baileys socket and synthetic call stanzas,
 * so the whole media path is exercised without a WhatsApp account:
 *
 *   entrarNaCall -> engine boots -> roster -> relay -> epoch -> ready
 *   tocarAudio   -> ffmpeg decodes a real file -> PCM reaches the engine
 *
 * Booting the WASM engine costs ~15s, so the media-path assertions share ONE
 * session instead of paying that cost per test.
 *
 * The stanzas mirror the captured attribute paths, so a regression in parsing or
 * in the readiness gate fails here instead of during a live call.
 *
 * Run: node --test tests/group-media.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { GroupCallMedia } from '../dist/group-media.mjs';

/** ffmpeg may not be on PATH in every environment; resolve it explicitly. */
const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'].find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
}) ?? 'ffmpeg';

const SELF_LID = '156535032389744:14@lid';
const SELF_BARE = '156535032389744@lid';
const GROUP = '120363411251996986@g.us';
const CALL_ID = '00DD63A26643DC3496FCBD161E6E2AB1';

const device = (jid, pid) => ({
    tag: 'device',
    attrs: { jid, ...(pid !== undefined ? { pid: String(pid) } : {}) }
});
const user = (jid, state, devices) => ({ tag: 'user', attrs: { jid, state }, content: devices });

/** A `group_update` in the captured shape, with roster and relay. */
const groupUpdateNode = ({ transactionId = 21, users = [], withRelay = true } = {}) => ({
    tag: 'call',
    attrs: { from: GROUP, id: 'X' },
    content: [
        {
            tag: 'group_update',
            attrs: { 'call-id': CALL_ID, 'call-creator': SELF_LID },
            content: [
                {
                    tag: 'group_info',
                    attrs: {
                        'call-id': CALL_ID,
                        'call-creator': SELF_LID,
                        'transaction-id': String(transactionId),
                        media: 'audio',
                        'connected-limit': '32',
                        'group-jid': GROUP
                    },
                    content: users
                },
                ...(withRelay
                    ? [{
                        tag: 'relay',
                        attrs: {
                            'transaction-id': '1', self_pid: '0', uuid: 'u',
                            participant_uuid: 'pu', warp_mi_tag_len: '4'
                        },
                        content: [
                            { tag: 'key', attrs: {}, content: new Uint8Array(24).fill(7) },
                            { tag: 'hbh_key', attrs: {}, content: new Uint8Array(16).fill(3) },
                            { tag: 'token', attrs: { id: '0' }, content: new Uint8Array(193).fill(1) },
                            { tag: 'auth_token', attrs: { id: '0' }, content: new Uint8Array(70).fill(2) },
                            {
                                tag: 'te2',
                                attrs: { relay_id: '0', token_id: '0', auth_token_id: '0', relay_name: 'zrh' },
                                // 157.240.17.133:3478
                                content: new Uint8Array([157, 240, 17, 133, 0x0d, 0x96])
                            }
                        ]
                    }]
                    : [])
            ]
        }
    ]
});

/** An `enc_rekey` carrying the 32-byte shared epoch. */
const encRekeyNode = (key) => ({
    tag: 'call',
    attrs: { from: GROUP, id: 'R' },
    content: [
        {
            tag: 'enc_rekey',
            attrs: { 'call-id': CALL_ID, 'call-creator': SELF_LID, 'transaction-id': '14' },
            content: [
                { tag: 'encopt', attrs: { keygen: '2' } },
                { tag: 'key', attrs: {}, content: key }
            ]
        }
    ]
});

/** A socket that is just enough for the media stack. */
const fakeSock = () => {
    const handlers = {};
    return {
        authState: {
            creds: { me: { id: '5511900000001@s.whatsapp.net', lid: SELF_LID } },
            keys: { set: async () => {} }
        },
        ws: { on: (evt, fn) => { handlers[evt] = fn; } },
        getPrivacyTokens: async () => ({ attrs: {}, content: [] }),
        /** Test hook: deliver a stanza exactly as the socket would. */
        _deliver: (node) => handlers['CB:call']?.(node)
    };
};

/** Us plus one connected remote carrying a PID. */
const rosterUsers = [
    user(SELF_BARE, 'connected', [device(SELF_LID, 0)]),
    user('242653052539031@lid', 'connected', [device('242653052539031@lid', 1)])
];

const outroGrupo = new GroupCallMedia({ log: () => {} });

describe('GroupCallMedia (sem sessão)', () => {
    it('reports "sem_call" when playing without a session', async () => {
        const r = await outroGrupo.tocarAudio('nao-existe@g.us', '/tmp/x.mp3');
        assert.equal(r.ok, false);
        assert.equal(r.motivo, 'sem_call');
    });

    it('pararAudio without a session says so instead of throwing', () => {
        const r = outroGrupo.pararAudio('nao-existe@g.us');
        assert.equal(r.ok, false);
        assert.equal(r.motivo, 'sem_call');
    });

    it('estagio is "parado" for an unknown group', () => {
        assert.equal(outroGrupo.estagio('nao-existe@g.us'), 'parado');
    });
});

describe('GroupCallMedia (caminho de mídia)', () => {
    let sock = null;
    let local = null;

    before(async () => {
        sock = fakeSock();
        local = new GroupCallMedia({ log: () => {} });
        await local.entrarNaCall({
            grupo: GROUP,
            callId: CALL_ID,
            callCreator: SELF_LID,
            sock,
            groupInfo: null
        });
    }, { timeout: 120_000 });

    after(async () => {
        if (local) await local.sairDaCall(GROUP);
    });

    it('entrarNaCall joins the call, with media waiting for the roster', () => {
        assert.equal(local.temSessao(GROUP), true);
        assert.equal(local.estagio(GROUP), 'aguardando_roster');
    });

    it('refuses to play before media is ready, and says why', async () => {
        const r = await local.tocarAudio(GROUP, '/tmp/x.mp3');
        assert.equal(r.ok, false);
        assert.ok(
            ['midia_nao_pronta', 'captura_ainda_nao_iniciada'].includes(r.motivo),
            `motivo=${r.motivo}`
        );
    });

    it('is NOT ready with the roster but no key epoch', async () => {
        sock._deliver(groupUpdateNode({ transactionId: 11, users: rosterUsers }));
        await new Promise((r) => setTimeout(r, 400));
        assert.notEqual(local.estagio(GROUP), 'pronta', 'sem epoch a mídia não pode fluir');
    });

    it('is NOT ready when only WE are connected', async () => {
        sock._deliver(encRekeyNode(new Uint8Array(32).fill(9)));
        sock._deliver(groupUpdateNode({
            transactionId: 12,
            users: [user(SELF_BARE, 'connected', [device(SELF_LID, 0)])]
        }));
        await new Promise((r) => setTimeout(r, 400));
        assert.notEqual(local.estagio(GROUP), 'pronta', 'ninguém para ouvir ainda');
    });

    it('becomes ready once roster + relay + epoch are all in', async () => {
        sock._deliver(groupUpdateNode({ transactionId: 21, users: rosterUsers }));
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(local.estagio(GROUP), 'pronta', 'roster + relay + epoch = pronta');
    });

    it('ignores a stale roster transaction', async () => {
        sock._deliver(groupUpdateNode({ transactionId: 5, users: [] }));
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(local.estagio(GROUP), 'pronta', 'snapshot antigo não derruba a mídia');
    });

    it('sairDaCall releases the session', async () => {
        await local.sairDaCall(GROUP);
        assert.equal(local.temSessao(GROUP), false);
        assert.equal(local.estagio(GROUP), 'parado');
    });
});

describe('decodificação de áudio', () => {
    let tmpAudio = null;

    before(() => {
        // A real 1-second tone, so ffmpeg genuinely decodes something.
        tmpAudio = path.join(os.tmpdir(), `callp-tone-${Date.now()}.mp3`);
        execFileSync(FFMPEG, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
            '-ac', '1', '-ar', '44100', tmpAudio
        ]);
    });

    after(() => {
        if (tmpAudio && fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio);
    });

    it('ffmpeg produced a real audio file to feed', () => {
        assert.ok(fs.statSync(tmpAudio).size > 0, 'arquivo de teste gerado');
    });

    it('decodes the file to 16 kHz mono PCM and meters it out', async () => {
        const { AudioFeeder } = await import('../dist/audio-feeder.mjs');
        const chunks = [];
        let ended = false;
        const feeder = new AudioFeeder(16000, 1, 320, (chunk) => chunks.push(chunk), tmpAudio, () => { ended = true; });
        feeder.start();
        await new Promise((r) => setTimeout(r, 4500));
        feeder.stop();
        // The source is 4s at 20ms/chunk: a feeder that stops when ffmpeg exits
        // would emit ~2 chunks. This asserts the whole file drains.
        assert.ok(chunks.length > 150, `drenou o audio inteiro (chunks=${chunks.length})`);
        assert.equal(chunks[0].length, 320, 'chunk de 320 amostras');
        assert.ok(feeder.bytesProduced > 200000, 'ffmpeg produziu os bytes do arquivo');
        assert.equal(ended, true, 'avisou o fim do audio');
    });
});
