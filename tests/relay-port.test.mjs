/**
 * Em qual PORTA o relay é discado.
 *
 * Medido na referência que funciona (zapo-caller, TS — `working` pela wacrg):
 *
 * > "Dial each relay on the port its `<te2>` endpoint advertises instead of on
 * > TRUE_WEB_CLIENT_RELAY_PORT. **Defaults to `false`**, which is what WhatsApp
 * > Web does. Against WhatsApp's own relays this is the **wrong choice** and the
 * > call goes **silently one way**: one reached on **3478** completes the
 * > handshake and carries the uplink **without ever forwarding the peer's stream
 * > back**."
 *
 * Era exatamente o nosso sintoma: o uplink vai, o bot fica "conectando...", e
 * nada volta. O padrão do lizzy-call estava em `original` (a porta anunciada,
 * normalmente 3478) — o modo que a referência diz ser o ERRADO.
 *
 * O teste usa o comportamento OBSERVÁVEL: `send` procura a conexão pelo
 * identificador `ip:porta`. Se o padrão disca 3480, um endpoint anunciado em
 * 3478 é encontrado por 3480 (e não por 3478).
 *
 * Run: node --test tests/relay-port.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulo = path.resolve(process.cwd(), 'dist/relay-transport.mjs');

/**
 * Importa o transporte num processo filho (a config de porta é lida no import,
 * então precisa de ambiente limpo por caso) e devolve os identificadores de
 * conexão que ele registrou para um endpoint anunciado em 3478.
 */
const identificadores = (env = {}) => {
    const script = `
        const mod = await import(${JSON.stringify(pathToFileURL(modulo).href)});
        const t = new mod.RelayRtcTransport({ onTransportMessage: () => {}, onIceRtt: () => {} });
        t.updateRelayList({
            relay_key: 'AAAA', relay_tokens: ['BBBB'], auth_tokens: ['CCCC'],
            relays: [{ relay_id: 0, token_id: 0, auth_token_id: 0, relay_name: 'zrh',
                addresses: [{ protocol: 0, ipv4: '1.2.3.4', port: 3478 }] }]
        });
        // Um pacote vazio: o retorno diz se ALGUMA conexão casou com o destino.
        const achou3478 = t.send(new Uint8Array(1), '1.2.3.4', 3478);
        const achou3480 = t.send(new Uint8Array(1), '1.2.3.4', 3480);
        console.log(JSON.stringify({ achou3478, achou3480 }));
        process.exit(0);
    `;
    const saida = execFileSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 60000
    });
    return JSON.parse(saida.trim().split('\n').pop());
};

describe('porta do relay', () => {
    it('por PADRÃO disca a porta do cliente Web (3480), como o WhatsApp Web', () => {
        const r = identificadores();
        // O endpoint foi anunciado em 3478; o padrão precisa procurá-lo em 3480.
        assert.equal(r.achou3480, 1, 'o padrão precisa discar 3480 (cliente Web)');
    });

    it('CALL_RELAY_PORT_MODE=original disca a porta anunciada (3478)', () => {
        const r = identificadores({ CALL_RELAY_PORT_MODE: 'original' });
        assert.equal(r.achou3478, 1, 'o modo original disca a porta anunciada');
    });
});
