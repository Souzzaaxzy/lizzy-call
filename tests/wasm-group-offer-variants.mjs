/**
 * What exactly does the engine emit for a group call, and does it depend on the
 * participant lists?
 *
 * `wasm-offer-shape` found the emitted offer has the 1:1 shape
 * (`audio,audio,net,capability,enc,encopt`) with no `group_info` and no
 * `group-jid`. Before deciding where to fix that, this dumps the full tree for
 * several participant shapes, so the difference is visible instead of guessed.
 *
 * Run: node tests/wasm-group-offer-variants.mjs
 */

import { WasmEngine } from '../dist/wasm-engine.mjs';

const baileys = await import('@whiskeysockets/baileys');
const { decodeBinaryNode } = baileys;

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';

const kids = (n) => (Array.isArray(n?.content) ? n.content : []);

/** Render a node tree compactly, so the whole offer is visible. */
const render = (node, depth = 0) => {
    const pad = '  '.repeat(depth);
    const attrs = Object.entries(node?.attrs || {})
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
    const bytes = node?.content instanceof Uint8Array ? ` [${node.content.length} bytes]` : '';
    const lines = [`${pad}<${node?.tag}${attrs ? ' ' + attrs : ''}>${bytes}`];
    if (Array.isArray(node?.content)) {
        for (const c of node.content) lines.push(render(c, depth + 1));
    }
    return lines.join('\n');
};

const runVariant = async (label, { pn, lid, devices }) => {
    const captured = [];
    const engine = new WasmEngine({
        callbacks: {
            onSignalingXmpp: (peerJid, callId, xmlPayload) => captured.push({ peerJid, callId, xmlPayload }),
            onCallEvent: () => {},
            sendDataToRelay: () => 0,
            onAudioCaptureInit: () => {},
            onAudioCaptureStart: () => {},
            onAudioCaptureStop: () => {},
            onAudioPlaybackData: () => {},
            cryptoHkdf: () => new Uint8Array(32),
            hmacSha256: () => new Uint8Array(32),
        },
    });

    await engine.initialize();
    engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
    await engine.waitForVoipStackReady();

    engine.startGroupCall({
        groupJid: GROUP,
        pnUserJids: pn,
        lidUserJids: lid,
        deviceJidsCsv: devices,
        callId: 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
        isVideo: false,
    });
    await new Promise((r) => setTimeout(r, 1200));

    console.log(`\n=== ${label} ===`);
    console.log(`    pn=${pn.length} lid=${lid.length} devices=${devices.length}`);
    if (!captured.length) {
        console.log('    (nada emitido)');
    } else {
        for (const c of captured) {
            const raw = Buffer.from(c.xmlPayload);
            let node = null;
            for (const attempt of [Buffer.concat([Buffer.from([0]), raw]), raw]) {
                try { node = await decodeBinaryNode(attempt); if (node?.tag) break; } catch {}
            }
            console.log(`    peerJid=${c.peerJid} callId=${c.callId} bytes=${raw.length}`);
            if (node) console.log(render(node, 2));
        }
    }
    try { engine.destroy?.(); } catch {}
};

await runVariant('1 convidado, 1 device', {
    pn: ['5511900000002@s.whatsapp.net'],
    lid: ['200000000000002@lid'],
    devices: ['200000000000002@lid'],
});

await runVariant('2 convidados, 1 device cada', {
    pn: ['5511900000002@s.whatsapp.net', '5511900000003@s.whatsapp.net'],
    lid: ['200000000000002@lid', '200000000000003@lid'],
    devices: ['200000000000002@lid', '200000000000003@lid'],
});

await runVariant('2 convidados, varios devices (csv)', {
    pn: ['5511900000002@s.whatsapp.net', '5511900000003@s.whatsapp.net'],
    lid: ['200000000000002@lid', '200000000000003@lid'],
    devices: ['200000000000002@lid,200000000000002:1@lid', '200000000000003@lid'],
});

console.log('\n[var] fim');
process.exit(0);
