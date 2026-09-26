/**
 * As etapas do relay são observáveis (Fase 3 da investigação)?
 *
 * ## Por que existe
 *
 * O log do dono mostra a call criada, o ack, o roster — e depois o processo morre
 * por sinal. Não havia NENHUMA linha sobre o relay: dava para saber que o roster
 * chegou, mas não se a relay list chegou, qual endpoint foi escolhido, se a
 * conexão abriu, se o STUN de alocação saiu ou se a mídia começou a fluir.
 *
 * Sem isso, "o relay não chegou" e "chegou e falhou no ICE" são indistinguíveis —
 * e são causas com correções diferentes. É exatamente o que a Fase 3 do pedido
 * exige: etapas explícitas, sem expor credencial.
 *
 * Run: node --test tests/relay-stages.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = path.resolve(process.cwd());
const { RelayRtcTransport } = await import(pathToFileURL(path.join(raiz, 'dist/relay-transport.mjs')).href);

/** Uma relay list válida, com as duas credenciais e endpoint em 3480. */
const relayList = () => ({
    relay_key: Buffer.alloc(16, 0x10).toString('base64'),
    relay_tokens: [Buffer.alloc(193, 0xaa).toString('base64')],
    auth_tokens: [Buffer.alloc(70, 0xbb).toString('base64')],
    relays: [{
        relay_id: 7,
        token_id: 0,
        auth_token_id: 0,
        relay_name: 'gru1c02',
        addresses: [{ protocol: 0, ipv4: '157.240.226.133', port: 3480 }]
    }]
});

describe('etapas observáveis do relay', () => {
    it('emite a etapa de endpoint escolhido, com id e TAMANHOS (sem credencial)', async () => {
        const eventos = [];
        const t = new RelayRtcTransport({
            onTransportMessage: () => {},
            onIceRtt: () => {},
            onStage: (stage, d) => eventos.push({ stage, d }),
        });

        t.updateRelayList(relayList());
        await new Promise((r) => setTimeout(r, 2500));
        try { await t.closeAll?.(); } catch { /* ignore */ }

        const selecionado = eventos.find((e) => e.stage === 'endpoint_selecionado');
        assert.ok(selecionado, 'a etapa endpoint_selecionado precisa ser emitida');

        // Identidade da escolha, para o log dizer QUAL relay foi usado.
        assert.equal(selecionado.d.relayName, 'gru1c02');
        assert.equal(selecionado.d.relayId, 7);
        assert.equal(selecionado.d.ip, '157.240.226.133');
        assert.equal(selecionado.d.port, 3480, 'a porta do cliente Web');

        // Só TAMANHOS — nunca o conteúdo das credenciais. Os valores são os do
        // nó: o token base64 de 193 bytes vira 260 chars; o auth_token de 70
        // bytes vira 96 chars (medido).
        assert.equal(selecionado.d.tokenLen, 260);
        assert.equal(selecionado.d.authTokenLen, 96);
        assert.ok(selecionado.d.keyLen > 0, 'a chave tem tamanho, não conteúdo');

        const serializado = JSON.stringify(eventos);
        assert.ok(!serializado.includes('qqqq'), 'não pode vazar o token');
        assert.ok(!serializado.includes('u7u7'), 'não pode vazar o auth_token');
    });

    it('a tentativa de conexão é observada imediatamente (não silenciosa)', async () => {
        const eventos = [];
        const t = new RelayRtcTransport({
            onTransportMessage: () => {},
            onIceRtt: () => {},
            onStage: (stage, d) => eventos.push({ stage, d }),
        });

        t.updateRelayList(relayList());
        // O relay real não existe neste ambiente. A conexão completa exige o
        // ICE, cujo desfecho é o timeout de 20s (CONNECTION_TIMEOUT_MS) — então
        // aqui se verifica o que precisa ser IMEDIATO: a tentativa é registrada.
        //
        // O desfecho (aberta/falhou) leva até 20s; forçar uma espera dessas num
        // teste unitário só o tornaria lento. O que a Fase 3 exige — não haver
        // SILÊNCIO depois da escolha do endpoint — está coberto aqui.
        await new Promise((r) => setTimeout(r, 3000));
        try { await t.closeAll?.(); } catch { /* ignore */ }

        const etapas = eventos.map((e) => e.stage);
        assert.ok(etapas.includes('transporte_iniciando'),
            `a tentativa precisa ser registrada. Eventos: ${JSON.stringify(etapas)}`);
        // E a sequência começa pelo endpoint escolhido, com identidade.
        assert.ok(etapas.includes('endpoint_selecionado'),
            `o endpoint precisa ser registrado. Eventos: ${JSON.stringify(etapas)}`);
    });
});
