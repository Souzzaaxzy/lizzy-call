/**
 * Com o setup da call FALHO, a mídia não alimenta áudio.
 *
 * Log do dono:
 *
 *   [CALLP] A CALL FALHOU NO SETUP (result=4, setupError=1)
 *   [CALLP] estado da call: ... noServidor=false
 *   [CALLP] tocando audio: silence
 *   AO bot terminou com erro (código: null). Reiniciando...
 *
 * `código: null` = o processo morreu por SINAL (não houve `process.exit`). O
 * motor, cuja call NÃO existe no servidor, recebeu PCM no uplink — estado
 * inconsistente que derruba o processo.
 *
 * Run: node --test tests/capture-gate.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { podeAlimentarCaptura, setupDaCallFalhou } from '../dist/group-media.mjs';

/** O estado exato do log do dono. */
const ESTADO_FALHO = JSON.stringify({
    call_info: {
        call_state: 1,
        call_result: 4,
        call_setup_error_type: 1,
        is_group_call_created_on_server: false,
        participant_count: 6,
        is_group_call: true
    }
});

/** Uma call saudável: resultado 0 e criada no servidor. */
const ESTADO_OK = JSON.stringify({
    call_info: {
        call_state: 3,
        call_result: 0,
        call_setup_error_type: 0,
        is_group_call_created_on_server: true,
        participant_count: 6,
        is_group_call: true
    }
});

describe('setupDaCallFalhou', () => {
    it('detecta o setup falho (result=4, noServidor=false)', () => {
        const r = setupDaCallFalhou(ESTADO_FALHO);
        assert.equal(r.falhou, true);
        assert.equal(r.result, 4);
        assert.equal(r.setupError, 1);
        assert.match(r.resumo, /noServidor=false/);
    });

    it('não considera falha um result=0', () => {
        const r = setupDaCallFalhou(ESTADO_OK);
        assert.equal(r.falhou, false);
        assert.match(r.resumo, /noServidor=true/);
    });

    it('não lança com dado inválido', () => {
        assert.equal(setupDaCallFalhou('nao e json').falhou, false);
        assert.equal(setupDaCallFalhou(undefined).falhou, false);
    });
});

describe('podeAlimentarCaptura', () => {
    it('BLOQUEIA quando o setup falhou (o que derrubava o bot)', () => {
        const r = podeAlimentarCaptura({ callFalhou: true, feeder: null });
        assert.equal(r.pode, false);
        assert.equal(r.motivo, 'setup_falhou');
    });

    it('libera quando a call está de pé', () => {
        assert.equal(podeAlimentarCaptura({ callFalhou: false, feeder: null }).pode, true);
    });

    it('não reinicia se já está tocando', () => {
        const r = podeAlimentarCaptura({ callFalhou: false, feeder: {} });
        assert.equal(r.pode, false);
        assert.equal(r.motivo, 'ja_tocando');
    });

    it('não alimenta sem sessão', () => {
        assert.equal(podeAlimentarCaptura(null).motivo, 'sem_sessao');
    });
});
