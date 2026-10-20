/**
 * A recuperação da leg UDP cru: a PORTA DE FALLBACK (uma vez), não re-dial em loop.
 *
 * ## O defeito que este teste trava (o "bip bip" + a call caindo)
 *
 * Eu tinha implementado **re-dial infinito** da leg — ideia minha, não da
 * referência. Isso fechava e reabria o socket a cada ~5 s; o motor via o caminho
 * de mídia cair junto e o resultado era o bipe de reconexão e a call derrubada.
 *
 * A referência (`@zapo-js/voip-media`) **não re-diala** a leg UDP cru — o watchdog
 * de downlink pula `transport === 'raw-udp'` (*"raw legs police their own return
 * path"*). A única recuperação é o `registerOnFallbackPort`: se a leg nunca
 * recebeu pacote, re-diala **na outra porta**, uma vez.
 *
 * ## Como é medido
 *
 * O transporte é instanciado e o `console.log` é capturado. Com um relay que
 * NUNCA responde:
 *
 *  - o log tem de trazer **"tentando a outra porta"** (a migração aconteceu);
 *  - o log **não** pode trazer re-dial em loop (sem churn de socket).
 *
 * Run: node --test tests/raw-udp-fallback.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulo = path.resolve(process.cwd(), 'dist/relay-transport.mjs');

/**
 * Roda a leg contra um relay que nunca responde e devolve o log capturado.
 *
 * @param {{ env?: Record<string,string>, esperaMs?: number }} opts
 */
const cenario = (opts = {}) => {
    const script = `
        import dgram from 'node:dgram';
        const mod = await import(${JSON.stringify(pathToFileURL(modulo).href)});

        // Um "relay" que escuta e NUNCA responde (o pior caso).
        const relay = dgram.createSocket('udp4');
        await new Promise((r) => relay.bind(0, '127.0.0.1', r));
        const porta = relay.address().port;

        const logs = [];
        const orig = console.log;
        console.log = (...a) => { logs.push(String(a.join(' '))); };

        const t = new mod.RelayRtcTransport({ onTransportMessage: () => {} });
        t.updateRelayList({
            relay_key: 'K', relay_tokens: ['T'],
            relays: [{ relay_id: 0, token_id: 0, relay_name: 'mudo',
                addresses: [{ protocol: 0, ipv4: '127.0.0.1', port: porta }] }]
        });

        const midia = new Uint8Array([0x80, 0x60, 1, 2]);
        const tique = setInterval(() => t.send(midia, '127.0.0.1', porta), 250);
        await new Promise((r) => setTimeout(r, ${opts.esperaMs ?? 9000}));
        clearInterval(tique);
        const enviados = t.getStats().sentPackets;
        console.log = orig;
        try { relay.close(); } catch {}

        console.log('__RESULT__' + JSON.stringify({ logs, enviados }));
        process.exit(0);
    `;
    const saida = execFileSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: 90000
    });
    const linha = saida.split('\n').find((l) => l.startsWith('__RESULT__'));
    return JSON.parse(linha.slice('__RESULT__'.length));
};

describe('leg UDP cru: recuperação pela outra porta (sem churn)', () => {
    it('a leg tenta a OUTRA porta quando nunca recebeu pacote', () => {
        const r = cenario({ esperaMs: 9000 });
        assert.ok(r.logs.join('\n').includes('tentando a outra porta'),
            'a unica recuperacao da leg UDP cru e a tentativa na outra porta');
    });

    it('NAO re-diala em loop (sem churn de socket)', () => {
        const r = cenario({ esperaMs: 9000 });
        assert.ok(!r.logs.join('\n').includes('re-dial'),
            'nao pode re-dialar em loop: era isso que gerava o bipe de reconexao');
    });

    it('a leg segue VIVA e enviando depois da janela (nao fecha)', () => {
        const r = cenario({ esperaMs: 9000 });
        assert.ok(r.enviados > 20,
            `o envio continua (enviou ${r.enviados}) — fechar tiraria o caminho de midia`);
    });

    it('CALL_RAW_UDP_FALLBACK=0 desliga a migração', () => {
        const r = cenario({ esperaMs: 9000, env: { CALL_RAW_UDP_FALLBACK: '0' } });
        assert.ok(!r.logs.join('\n').includes('tentando a outra porta'),
            'com o fallback desligado nao migra');
    });
});
