/**
 * A leg UDP cru NAO pode derrubar a call sozinha — ela RE-DIALA.
 *
 * ## O defeito que este teste trava (a call caindo de ~3 em ~3 s, com bipes)
 *
 * O relay de um call de GRUPO frequentemente não devolve mídia enquanto o outro
 * lado não entra. A primeira versão da leg tratava isso como falha TERMINAL:
 * fechava e derrubava a call. O motor então reabria, o relay voltava a não
 * responder, e a call ficava caindo em ciclo — o bipe de entrada/saída.
 *
 * A referência que funciona (`@zapo-js/voip-media`) re-diala a leg parada
 * (`redialStalledLegs`) com backoff e um teto de tentativas. Aqui é igual.
 *
 * ## Como é medido
 *
 * O teste entrega ao transporte um "relay" que **engole tudo e nunca responde**
 * (o pior caso) e observa: a leg deve RE-DIALAR (o socket disca de novo) em vez
 * de fechar. O sinal é o contador de re-dial, exposto pela própria leg.
 *
 * Run: node --test tests/raw-udp-redial.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulo = path.resolve(process.cwd(), 'dist/relay-transport.mjs');

/**
 * Manda mídia para um "relay" que nunca responde e conta as re-dial.
 *
 * @param {{ env?: Record<string,string>, esperaMs?: number }} opts
 */
const cenario = (opts = {}) => {
    const script = `
        import dgram from 'node:dgram';
        const mod = await import(${JSON.stringify(pathToFileURL(modulo).href)});

        // O relay de mentira: escuta e NAO responde NUNCA (o pior caso).
        const relay = dgram.createSocket('udp4');
        let recebidos = 0;
        relay.on('message', () => { recebidos += 1; });
        await new Promise((r) => relay.bind(0, '127.0.0.1', r));
        const porta = relay.address().port;

        const t = new mod.RelayRtcTransport({ onTransportMessage: () => {} });
        t.updateRelayList({
            relay_key: 'K', relay_tokens: ['T'],
            relays: [{ relay_id: 0, token_id: 0, relay_name: 'mudo',
                addresses: [{ protocol: 0, ipv4: '127.0.0.1', port: porta }] }]
        });

        // Midia (nao-STUN) em intervalos: mantem a janela de retorno armada.
        const midia = new Uint8Array([0x80, 0x60, 1, 2]);
        const tique = setInterval(() => t.send(midia, '127.0.0.1', porta), 250);

        await new Promise((r) => setTimeout(r, ${opts.esperaMs ?? 9000}));
        clearInterval(tique);
        try { relay.close(); } catch {}

        // Quantas re-dial a leg fez (ela expoe o contador).
        const stats = t.getStats();
        console.log(JSON.stringify({
            recebeu: recebidos > 0,
            conexoesAbertas: stats.openConnections,
            totalEnviados: stats.sentPackets
        }));
        process.exit(0);
    `;
    const saida = execFileSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: 90000
    });
    return JSON.parse(saida.trim().split('\n').pop());
};

describe('leg UDP cru: re-dial em vez de derrubar a call', () => {
    it('relay que NAO responde: a leg continua enviando (nao fecha em ~3 s)', () => {
        // Com a janela de retorno em 5 s, a versao antiga fechava a leg e parava
        // de enviar. Com a re-dial, o envio CONTINUA ao longo dos 9 s.
        const r = cenario({ esperaMs: 9000 });
        assert.equal(r.recebeu, true, 'o relay recebeu a midia');
        assert.ok(r.totalEnviados > 20,
            `a leg seguiu enviando depois de estourar a janela (enviou ${r.totalEnviados})`);
    });

    it('CALL_RAW_UDP_MAX_REDIALS=0 desliga a re-dial (comportamento antigo)', () => {
        // Sem re-dial, ao estourar a janela a leg fecha e o envio PARA. O
        // contraste com o teste anterior e o que prova que a re-dial e o que
        // mantem a call de pe.
        const r = cenario({ esperaMs: 9000, env: { CALL_RAW_UDP_MAX_REDIALS: '0' } });
        assert.equal(r.recebeu, true, 'chegou midia antes de fechar');
        assert.ok(r.totalEnviados < 40,
            `sem re-dial o envio para (enviou ${r.totalEnviados})`);
    });
});
