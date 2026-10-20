/**
 * UDP CRU: a leg sem ICE — o que destrava a call de GRUPO.
 *
 * ## O defeito que este teste trava
 *
 * O transporte discava TODO relay por `RTCPeerConnection`. Quando o relay de um
 * call de GRUPO **não traz credencial ICE**, não há ICE a negociar: o WebRTC fica
 * tentando e a call **nunca sai de "conectando"**. Era o sintoma do dono.
 *
 * A classificação vem do zapo (`group-media-plan.js`), a referência que funciona:
 *
 *   `endpoint.authToken ? undefined : 'raw-udp'`
 *
 * ou seja, **sem `authToken` o relay SÓ funciona por UDP cru**.
 *
 * ## Como é medido (sem servidor real)
 *
 * O teste sobe um socket UDP local e passa o `ip:porta` dele como relay. Se o
 * transporte abrir a leg por UDP cru, o pacote CHEGA nesse socket; se ele tentar
 * WebRTC, nada chega (o `RTCPeerConnection` não fala UDP cru).
 *
 * Run: node --test tests/raw-udp.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulo = path.resolve(process.cwd(), 'dist/relay-transport.mjs');

/**
 * Roda um cenário num processo filho: o teste abre um socket UDP, entrega o
 * `ip:porta` dele ao transporte como relay e tenta enviar mídia.
 *
 * @param {{ authToken?: boolean, env?: Record<string,string> }} opts
 * @returns {{ recebeu: boolean, bytes: number, portaAnunciada: number }}
 */
const cenario = (opts = {}) => {
    const script = `
        import dgram from 'node:dgram';
        const mod = await import(${JSON.stringify(pathToFileURL(modulo).href)});

        // Socket UDP local: e o "relay". A porta anunciada e a que ele escuta.
        const relay = dgram.createSocket('udp4');
        const recebidos = [];
        relay.on('message', (m) => recebidos.push(m.length));
        await new Promise((r) => relay.bind(0, '127.0.0.1', r));
        const portaAnunciada = relay.address().port;

        const t = new mod.RelayRtcTransport({ onTransportMessage: () => {} });

        // O endpoint anunciado tem uma porta "original" (a do socket) e, se
        // pedido, tambem um authToken (o que decide a leg).
        const auth = ${opts.authToken ? "['AAAA']" : 'undefined'};
        t.updateRelayList({
            relay_key: 'KKKK',
            relay_tokens: ['TTTT'],
            ...(auth ? { auth_tokens: auth } : {}),
            relays: [{
                relay_id: 0, token_id: 0, relay_name: 'local',
                addresses: [{ protocol: 0, ipv4: '127.0.0.1', port: portaAnunciada }]
            }]
        });

        // Manda "midia" (nao-STUN: o primeiro byte com bits altos) para o relay.
        const midia = new Uint8Array([0x80, 0x60, 0x01, 0x02]);
        t.send(midia, '127.0.0.1', portaAnunciada);
        // Uma segunda vez, caso a primeira tenha so armado a conexao.
        await new Promise((r) => setTimeout(r, 400));
        t.send(midia, '127.0.0.1', portaAnunciada);

        await new Promise((r) => setTimeout(r, 600));
        try { relay.close(); } catch {}
        console.log(JSON.stringify({
            recebeu: recebidos.length > 0,
            bytes: recebidos.reduce((a, b) => a + b, 0),
            portaAnunciada
        }));
        process.exit(0);
    `;
    const saida = execFileSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: 60000
    });
    return JSON.parse(saida.trim().split('\n').pop());
};

describe('leg por UDP cru (sem ICE)', () => {
    it('relay SEM authToken: o pacote chega por UDP cru (nao trava no WebRTC)', () => {
        // Sem authToken nao ha credencial ICE: e exatamente o relay de call de
        // GRUPO que deixava a call em "conectando".
        const r = cenario({ authToken: false });
        assert.equal(r.recebeu, true,
            'o relay recebeu a midia por UDP cru (antes: nada chegava, so WebRTC)');
        assert.ok(r.bytes >= 4, `chegaram bytes (veio ${r.bytes})`);
    });

    it('CALL_RAW_UDP=all: qualquer relay vai por UDP cru', () => {
        const r = cenario({ authToken: true, env: { CALL_RAW_UDP: 'all' } });
        assert.equal(r.recebeu, true, 'o modo all disca todo relay por UDP cru');
    });

    it('CALL_RAW_UDP=0: desliga (so WebRTC) — o relay NAO recebe por UDP', () => {
        const r = cenario({ authToken: false, env: { CALL_RAW_UDP: '0' } });
        assert.equal(r.recebeu, false, 'com a leg desligada nada sai por UDP cru');
    });

    it('relay COM authToken e modo required: NAO usa UDP cru (vai por WebRTC)', () => {
        // Com authToken existe ICE: o caminho normal (WebRTC) e o certo. Como o
        // "relay" aqui e um socket UDP, nada chega — e isso prova que ele NAO
        // caiu no UDP cru.
        const r = cenario({ authToken: true });
        assert.equal(r.recebeu, false, 'relay com ICE nao vira leg UDP cru');
    });

    it('a leg UDP cru usa a porta ANUNCIADA (nao a 3480 do cliente web)', () => {
        // O socket local so escuta na porta dele; se a leg usasse 3480, nada
        // chegaria. Receber prova que a porta anunciada foi respeitada.
        const r = cenario({ authToken: false });
        assert.ok(r.portaAnunciada > 0, 'o teste tem uma porta anunciada real');
        assert.equal(r.recebeu, true, 'a midia foi para a porta anunciada do relay');
    });
});
