/**
 * O que é "falha" no estado da call.
 *
 * Medido com o motor real (`probe-estados.mjs`):
 *
 *   [t= 1357ms] state=1 result=4 setup=1 noSrv=false ending=false  <- logo apos criar
 *   [t=16469ms] state=0 result=8 ending=true                       <- falha real
 *
 * O `result=4` aparece ~100 ms depois de `startGroupCall`, ANTES de qualquer
 * resposta do servidor: é o ESTADO INICIAL ("ainda não conectada"). Tratar
 * `result != 0` como falha gerava alarme falso em toda chamada — o log dizia
 * "A CALL FALHOU NO SETUP" mesmo com a call saudável, e a mídia era bloqueada
 * sem motivo.
 *
 * A falha REAL é o motor derrubar a call: `call_ending === true`, ou
 * `state === 0` com `result` de erro.
 *
 * Run: node --test tests/capture-gate.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { podeAlimentarCaptura, setupDaCallFalhou } from '../dist/group-media.mjs';

/** O estado INICIAL — presente em toda call, inclusive nas saudáveis. */
const ESTADO_INICIAL = JSON.stringify({
    call_info: {
        call_state: 1, call_result: 4, call_setup_error_type: 1,
        is_group_call_created_on_server: false,
        participant_count: 6, is_group_call: true,
        call_ending: false, call_ended_by_me: false
    }
});

/** A falha REAL, ~15s depois: o motor começa a derrubar a call. */
const ESTADO_CAINDO = JSON.stringify({
    call_info: {
        call_state: 0, call_result: 8, call_setup_error_type: 1,
        is_group_call_created_on_server: false,
        participant_count: 6, is_group_call: true,
        call_ending: true, call_ended_by_me: false
    }
});

/** Uma call saudável, conectada. */
const ESTADO_OK = JSON.stringify({
    call_info: {
        call_state: 3, call_result: 0, call_setup_error_type: 0,
        is_group_call_created_on_server: true,
        participant_count: 6, is_group_call: true,
        call_ending: false
    }
});

describe('setupDaCallFalhou', () => {
    it('NÃO trata o estado inicial (result=4) como falha', () => {
        // Este era o erro que gerava o alarme falso: result=4 existe em TODA call.
        const r = setupDaCallFalhou(ESTADO_INICIAL);
        assert.equal(r.falhou, false, 'result=4 é o estado inicial, não uma falha');
        assert.equal(r.encerrando, false);
    });

    it('detecta a falha REAL (encerrando, result=8)', () => {
        const r = setupDaCallFalhou(ESTADO_CAINDO);
        assert.equal(r.falhou, true);
        assert.equal(r.encerrando, true);
        assert.match(String(r.motivo), /encerrando|result=8/);
    });

    it('não considera falha uma call conectada', () => {
        assert.equal(setupDaCallFalhou(ESTADO_OK).falhou, false);
    });

    it('não lança com dado inválido', () => {
        assert.equal(setupDaCallFalhou('nao e json').falhou, false);
        assert.equal(setupDaCallFalhou(undefined).falhou, false);
    });
});

describe('podeAlimentarCaptura', () => {
    it('BLOQUEIA quando a call está caindo', () => {
        const r = podeAlimentarCaptura({ callFalhou: true, feeder: null });
        assert.equal(r.pode, false);
        assert.equal(r.motivo, 'setup_falhou');
    });

    it('libera quando a call está de pé', () => {
        assert.equal(podeAlimentarCaptura({ callFalhou: false, feeder: null }).pode, true);
    });

    it('não reinicia se já está tocando', () => {
        assert.equal(podeAlimentarCaptura({ callFalhou: false, feeder: {} }).motivo, 'ja_tocando');
    });

    it('não alimenta sem sessão', () => {
        assert.equal(podeAlimentarCaptura(null).motivo, 'sem_sessao');
    });
});
