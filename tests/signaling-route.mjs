/**
 * How does the bridge rewrite an outbound group offer's destination?
 *
 * A group offer MUST be addressed to the CALL OBJECT (`<call-id>@call`). The
 * bridge rewrites outbound JIDs with helpers that only understand `@lid` and
 * `@s.whatsapp.net`, so this exercises those helpers directly — no socket, no
 * WASM — to see what `X@call` turns into.
 *
 * Run: node tests/signaling-route.mjs
 */

import { SignalingBridge } from '../dist/signaling.mjs';

const bridge = new SignalingBridge({
    sock: {
        authState: { creds: { me: { id: '5511900000001@s.whatsapp.net', lid: '100000000000001:14@lid' } }, keys: { set: async () => {} } },
    },
});

// The private helpers are reachable for diagnosis: they are the exact functions
// the send path calls to decide where a stanza goes.
const probe = (name, fn, jid) => {
    try {
        const out = fn.call(bridge, jid);
        console.log(`   ${name}(${jid}) = ${out}`);
        return out;
    } catch (e) {
        console.log(`   ${name}(${jid}) FALHOU: ${e?.message}`);
        return null;
    }
};

const CALL_ID = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
const CALL_OBJECT = `${CALL_ID}@call`;

console.log('[route] helpers de roteamento, aplicados ao endereço da call de grupo:');
// `init()` would need a real socket, but the helpers only need `#baileys`.
const baileys = await import('@whiskeysockets/baileys');
bridge['#baileys'] = baileys;

const toBare = bridge['#toBareJid'];
const toDevice = bridge['#toCallDeviceJid'];

const bare = probe('#toBareJid', toBare, CALL_OBJECT);
const device = probe('#toCallDeviceJid', toDevice, CALL_OBJECT);

console.log('');
console.log('[route] endereço correto para um offer de grupo:', CALL_OBJECT);
console.log('[route] #toBareJid devolveu:      ', bare);
console.log('[route] #toCallDeviceJid devolveu: ', device);

const correto = bare === CALL_OBJECT && device === CALL_OBJECT;
if (correto) {
    console.log('\n[route] OK: os helpers preservam o objeto da call.');
} else {
    console.log('\n[route] PROBLEMA: os helpers destroem o endereço do objeto da call.');
    console.log('        O offer de grupo sai endereçado a um device, e o servidor');
    console.log('        recusa (is_group_call_created_on_server: false, call_result: 4).');
}

// Also check the device helper on a plain lid, to show the intended use.
probe('#toCallDeviceJid (lid normal)', toDevice, '200000000000002@lid');

process.exit(0);
