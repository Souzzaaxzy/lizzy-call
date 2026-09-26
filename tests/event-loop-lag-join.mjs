/**
 * Does the FULL join flow block the event loop?
 *
 * `event-loop-lag` measured the engine's own steps. This measures what the bot
 * actually does: `entrarNaCall` — boot, create the call, then wait up to 30s for
 * media readiness. If the freeze the owner reported happens here, this shows it.
 *
 * Run: node tests/event-loop-lag-join.mjs
 */

import { GroupCallMedia } from '../dist/group-media.mjs';

const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363411251996986@g.us';

const lag = { max: 0, count: 0 };
const TICK = 20;
let last = Date.now();
const ticker = setInterval(() => {
    const now = Date.now();
    const delta = now - last - TICK;
    last = now;
    if (delta > 0) {
        lag.count += 1;
        if (delta > lag.max) lag.max = delta;
    }
}, TICK);

const report = (label) => {
    console.log(`[join-lag] ${label}: pior atraso = ${lag.max}ms (${lag.count} amostras)`);
    const worst = lag.max;
    lag.max = 0;
    lag.count = 0;
    return worst;
};

// A socket stub: the engine boots for real, only the network is absent.
const sock = {
    authState: {
        creds: { me: { id: '5511900000001@s.whatsapp.net', lid: SELF_LID } },
        keys: { set: async () => {} },
    },
    ws: { on: () => {} },
    getPrivacyTokens: async () => ({ attrs: {}, content: [] }),
};

const media = new GroupCallMedia({ log: (m) => console.log(`   ${m}`) });

const t0 = Date.now();
const result = await media.entrarNaCall({
    grupo: GROUP,
    participantes: ['200000000000002@lid', '200000000000003@lid'],
    sock,
});
const totalMs = Date.now() - t0;

const worst = report(`entrarNaCall (${totalMs}ms no total)`);

console.log(`\n[join-lag] resultado: ok=${result.ok} stage=${result.stage}`);
console.log(`[join-lag] aviso: ${result.aviso ?? '-'}`);
console.log(`[join-lag] pior atraso do event loop: ${worst}ms`);
console.log(`[join-lag] duracao total do comando: ${totalMs}ms`);

if (worst > 250) {
    console.log('\n[join-lag] => BLOQUEIA o event loop: no bot isso congela tudo.');
} else {
    console.log('\n[join-lag] => nao bloqueia de forma significativa.');
}
if (totalMs > 5000) {
    console.log(`[join-lag] => o comando SEGURA por ${Math.round(totalMs / 1000)}s antes de responder.`);
}

try { await media.sairDaCall(GROUP); } catch {}
clearInterval(ticker);
process.exit(0);
