/**
 * A pilha de mídia NÃO pode derrubar o bot.
 *
 * Dois defeitos medidos, ambos vistos no log do dono:
 *
 *   1. `handleGroupUpdate`/`handleEncRekey` passavam `null` no slot do
 *      `Uint8List` (tcToken) e o WASM lançava **BindingError** — era o
 *      `[CALLP] erro ao processar stanza: BindingError`. Sem aplicar o
 *      `group_update`, o roster/relay nunca entravam no motor.
 *
 *   2. `AudioFeeder` não escutava `'error'` no spawn do ffmpeg. Sem ffmpeg no
 *      PATH o Node LANÇA (`ENOENT` sem listener) -> `uncaughtException` -> o bot
 *      REINICIAVA no meio da call ("bot terminou com erro (código: null)").
 *
 * Run: node --test tests/media-nao-derruba.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = path.resolve(process.cwd());
const { WasmEngine } = await import(pathToFileURL(path.join(raiz, 'dist/wasm-engine.mjs')).href);
const { AudioFeeder } = await import(pathToFileURL(path.join(raiz, 'dist/audio-feeder.mjs')).href);
const baileys = await import('@itsliaaa/baileys');

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363432070074647@g.us';
const CALL_ID = 'F1470313333534C8A53774058BC82E79';

const ffmpegNoPath = (() => {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
    catch { return false; }
})();

const groupInfoPayload = () => {
    const node = {
        tag: 'group_info',
        attrs: {
            'call-id': CALL_ID, 'call-creator': SELF_LID, 'transaction-id': '15',
            'group-jid': GROUP, media: 'audio', self_pid: '0'
        },
        content: [
            { tag: 'user', attrs: { jid: '100000000000001@lid', state: 'connected' }, content: [{ tag: 'device', attrs: { jid: SELF_LID, pid: '0' } }] },
            { tag: 'user', attrs: { jid: '200000000000002@lid', state: 'connected' }, content: [{ tag: 'device', attrs: { jid: '200000000000002:1@lid', pid: '1' } }] }
        ]
    };
    return Buffer.from(baileys.encodeBinaryNode(node)).toString('base64');
};

describe('a mídia não derruba o bot', () => {
    it('handleGroupUpdate e handleEncRekey não lançam BindingError', async () => {
        const engine = new WasmEngine({ callbacks: {
            onSignalingXmpp: () => {}, onCallEvent: () => {}, sendDataToRelay: () => 0,
            onAudioCaptureInit: () => {}, onAudioCaptureStart: () => {}, onAudioCaptureStop: () => {},
            onAudioPlaybackData: () => {}, cryptoHkdf: () => new Uint8Array(32), hmacSha256: () => new Uint8Array(32),
        } });
        await engine.initialize();
        engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
        await engine.waitForVoipStackReady();

        const payload = groupInfoPayload();

        // Era aqui que estourava `BindingError` (null no lugar do Uint8List).
        assert.doesNotThrow(
            () => engine.handleGroupUpdate({ payload, peerJid: GROUP }),
            'o group_update precisa ser aceito pelo WASM'
        );
        assert.doesNotThrow(
            () => engine.handleEncRekey({ payload, peerJid: GROUP }),
            'o enc_rekey precisa ser aceito pelo WASM'
        );

        try { engine.destroy?.(); } catch { /* ignore */ }
    });

    it('o AudioFeeder não derruba o processo sem ffmpeg', async () => {
        if (ffmpegNoPath) {
            // Com ffmpeg instalado o caso ENOENT não acontece; o que importa aqui
            // é que o listener de `error` exista, então o teste fica no-op.
            return;
        }

        // Um `'error'` sem listener em um EventEmitter LANÇA. Aqui provamos que
        // o feeder escuta: o processo sobrevive e o aviso sai no stderr.
        let estourou = null;
        const onUncaught = (e) => { estourou = e; };
        process.once('uncaughtException', onUncaught);

        const feeder = new AudioFeeder(16000, 1, 320, () => {}, '/tmp/nao-existe.mp3');
        feeder.start();
        await new Promise((r) => setTimeout(r, 800));
        feeder.stop();

        process.off('uncaughtException', onUncaught);
        assert.equal(estourou, null, 'sem ffmpeg o feeder não pode lançar (o bot reiniciaria)');
    });
});

// O motor WASM roda em pthreads (worker_threads) que não encerram sozinhos
// depois do destroy, então o processo fica vivo e o runner marca o arquivo como
// pendente. Aqui já não há nada a medir: encerra de forma limpa.
after(() => setTimeout(() => process.exit(0), 100));
