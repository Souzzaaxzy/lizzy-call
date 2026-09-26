/**
 * Does the media stack throw anything that would kill the bot's process?
 *
 * The bot installs `process.on('uncaughtException', () => process.exit(1))`. Any
 * uncaught throw from the media stack therefore RESTARTS the bot, which:
 *   - drops the in-memory call registry, so `!musicap` says "no active call";
 *   - drops the WhatsApp session, so the call the engine created dies.
 *
 * That chain matches exactly what the owner reported: the call goes up, the bot
 * sits "connecting", and a few seconds later the call closes.
 *
 * This drives a group call and records every uncaught error and rejection.
 *
 * Run: node tests/uncaught-safety.mjs
 */

import { GroupCallMedia } from '../dist/group-media.mjs';

const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';

const capturados = [];
process.on('uncaughtException', (e) => {
    capturados.push({ tipo: 'uncaughtException', msg: e?.message || String(e) });
});
process.on('unhandledRejection', (r) => {
    capturados.push({ tipo: 'unhandledRejection', msg: r?.message || String(r) });
});

const sock = {
    authState: {
        creds: { me: { id: '5511900000001@s.whatsapp.net', lid: SELF_LID } },
        keys: { set: async () => {} },
    },
    ws: { on: () => {} },
    getPrivacyTokens: async () => ({ attrs: {}, content: [] }),
};

const media = new GroupCallMedia({ log: (m) => console.log(`   ${m}`) });

console.log('[safe] entrando na call...');
const r = await media.entrarNaCall({
    grupo: GROUP,
    participantes: ['200000000000002@lid', '200000000000003@lid'],
    sock,
});
console.log(`[safe] entrarNaCall -> ok=${r.ok} stage=${r.stage}`);

// Give the engine time to do everything it does after the offer: relay list,
// roster, capture init, playback. That window is where a throw would happen.
await new Promise((res) => setTimeout(res, 6000));

console.log(`\n[safe] erros nao capturados durante o ciclo: ${capturados.length}`);
for (const c of capturados) console.log(`   ${c.tipo}: ${c.msg}`);

if (capturados.length > 0) {
    console.log('\n[safe] RESULTADO: a pilha de midia LANCou. No bot, o handler de');
    console.log('       uncaughtException reinicia o processo -> a call morre e o');
    console.log('       registro em memoria se perde.');
} else {
    console.log('\n[safe] RESULTADO: nenhum throw nao capturado neste ciclo.');
}

try { await media.sairDaCall(GROUP); } catch {}
setTimeout(() => process.exit(capturados.length > 0 ? 1 : 0), 300);
