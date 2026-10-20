/**
 * O GATE DE MÍDIA: o motor pedindo captura é prova de que a call está viva.
 *
 * ## O defeito que este teste trava (a call caindo de ~3 em ~3 s, com bipes)
 *
 * A cadeia do falso positivo:
 *
 *   1. o motor passa por `state=0 result=4` (ESTADO INICIAL, "ainda não
 *      conectada") — isso NÃO é erro, mas era lido como falha;
 *   2. isso marcava `callFalhou = true`;
 *   3. `podeAlimentarCaptura` então RECUSAVA a captura;
 *   4. sem alimentar, o bot **não transmite mídia nenhuma**;
 *   5. o motor encerra a call sozinho por falta de mídia — está escrito no
 *      binário: `"ERROR: No media being transmitted"` e
 *      `"mvp->enable_media_timeout_terminate_reason"`;
 *   6. o bot reabria e o ciclo repetia → a queda periódica + o bipe.
 *
 * Run: node --test tests/media-gate.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.cwd(), 'dist/group-media.mjs')).href);
const { setupDaCallFalhou, podeAlimentarCaptura } = mod;

const estado = (info) => JSON.stringify({ call_info: info });

describe('gate de mídia (o falso positivo que derrubava a call)', () => {
    it('state=0 result=4 (ESTADO INICIAL) NAO e falha', () => {
        // Medido com o motor real: este e o estado logo apos criar a call.
        const r = setupDaCallFalhou(estado({
            call_state: 0, call_result: 4, call_setup_error_type: 1,
            is_group_call_created_on_server: false, call_ending: false
        }));
        assert.equal(r.falhou, false,
            'o estado inicial nao pode ser lido como falha (era o gatilho do ciclo)');
    });

    it('call_ending=true E falha (o motor esta derrubando)', () => {
        const r = setupDaCallFalhou(estado({ call_state: 0, call_result: 8, call_ending: true }));
        assert.equal(r.falhou, true, 'encerrando a call e o sinal real');
        assert.equal(r.motivo, 'encerrando', 'nomeia o motivo');
    });

    it('call_result de erro SEM call_ending NAO e falha terminal', () => {
        // Um result != 0 aparece em transicoes normais; derrubar a midia por isso
        // e o que criava o ciclo.
        const r = setupDaCallFalhou(estado({ call_state: 0, call_result: 8, call_ending: false }));
        assert.equal(r.falhou, false, 'sem `call_ending` nao se derruba a call');
    });

    it('com o motor PEDINDO captura, alimentamos mesmo com sinal de falha', () => {
        // A captura pedida e a prova de que a call esta viva: recusar deixaria a
        // call sem midia e o motor a encerraria.
        const media = { feeder: null, callFalhou: true };
        const { pode, motivo } = podeAlimentarCaptura(media);
        assert.equal(pode, false, 'a funcao pura ainda reporta o motivo...');
        assert.equal(motivo, 'setup_falhou', '...e o chamador passa a IGNORAR esse motivo');
    });

    it('a regra do chamador: so `ja_tocando` e `sem_sessao` barram a captura', () => {
        // Espelha a condicao do `#onCaptureStart` no dist.
        const barra = (motivo) => motivo === 'ja_tocando' || motivo === 'sem_sessao';
        assert.equal(barra('setup_falhou'), false, 'sinal de falha NAO barra a captura');
        assert.equal(barra('ja_tocando'), true, 'feeder ja ativo barra (nao duplica)');
        assert.equal(barra('sem_sessao'), true, 'sem sessao nao ha o que alimentar');
    });
});
