/**
 * Alimentar ÁUDIO num motor cuja call NÃO está pronta derruba o processo?
 *
 * ## Por que este teste
 *
 * O log do dono mostra, nesta ordem:
 *
 *   [CALLP] roster tx=15 ... conectados=1 midia=false
 *   [CALLP] tocando audio: silence          <- a captura INICIOU
 *   [CALLP] roster tx=17 ... conectados=1
 *   bot terminou com erro (código: null)     <- morto por SINAL
 *
 * E `midia=false` significa que o portão de prontidão está FECHADO: falta relay
 * e/ou um remoto conectado com PID. Mesmo assim o `startCaptureJS` chegou e o
 * feeder começou a escrever PCM no uplink.
 *
 * A hipótese: **escrever áudio num motor sem caminho de mídia o leva a um estado
 * inconsistente e ele aborta nativamente** (o `código: null` = morto por sinal,
 * sem exceção JS — nenhum handler pega).
 *
 * ## Por que só agora dá para testar
 *
 * O caminho de áudio real precisa de ffmpeg. Antes ele não estava no ambiente e o
 * feeder só reportava ENOENT. Agora há um ffmpeg estático, então o PCM chega
 * mesmo ao motor — que é a condição do log do dono.
 *
 * Run: node --test tests/audio-sem-midia.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = path.resolve(process.cwd());
const { WasmEngine } = await import(pathToFileURL(path.join(raiz, 'dist/wasm-engine.mjs')).href);
const { AudioFeeder } = await import(pathToFileURL(path.join(raiz, 'dist/audio-feeder.mjs')).href);

/** ffmpeg precisa existir para o PCM chegar ao motor. */
const temFfmpeg = (() => {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
    catch { return false; }
})();

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363432070074647@g.us';

describe('áudio num motor sem caminho de mídia', () => {
    it('o processo NÃO pode morrer por alimentar PCM sem mídia pronta', async (t) => {
        if (!temFfmpeg) {
            t.skip('sem ffmpeg o PCM não chega ao motor (ambiente)');
            return;
        }

        // Um `uncaughtException` derruba o processo no bot (o handler chama
        // process.exit(1) para erros não-mídia). Aqui ele é a falha do teste.
        let estourou = null;
        const onUncaught = (e) => { estourou = e; };
        process.once('uncaughtException', onUncaught);

        const engine = new WasmEngine({ callbacks: {
            onSignalingXmpp: () => {}, onCallEvent: () => {}, sendDataToRelay: () => 0,
            onAudioCaptureInit: () => {},
            onAudioCaptureStart: () => {},
            onAudioCaptureStop: () => {},
            onAudioPlaybackData: () => {},
            cryptoHkdf: () => new Uint8Array(32), hmacSha256: () => new Uint8Array(32),
        } });

        await engine.initialize();
        engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
        await engine.waitForVoipStackReady();

        // Cria a call, mas SEM relay e SEM remoto conectado — `midia=false`,
        // exatamente como no log. A captura do motor é acionada mesmo assim.
        engine.startGroupCall({
            groupJid: GROUP,
            pnUserJids: ['5511911111111@s.whatsapp.net', '5511922222222@s.whatsapp.net'],
            lidUserJids: ['200000000000002@lid', '200000000000003@lid'],
            deviceJidsCsv: ['200000000000002@lid', '200000000000003@lid'],
            callId: 'A'.repeat(32),
            isVideo: false,
        });
        await new Promise((r) => setTimeout(r, 800));

        // O feeder alimenta o uplink com PCM real (ffmpeg decodifica "silence").
        const ptr = engine.malloc(320 * 4);
        const feeder = new AudioFeeder(16000, 1, 320, (chunk) => {
            engine.sendAudioData(chunk, ptr);
        }, 'silence');
        feeder.start();

        // Janela em que o crash do dono acontecia (~alguns segundos).
        await new Promise((r) => setTimeout(r, 6000));

        try { feeder.stop(); } catch { /* ignore */ }
        try { engine.destroy?.(); } catch { /* ignore */ }
        process.off('uncaughtException', onUncaught);

        assert.equal(estourou, null, `não pode lançar (o bot reiniciaria): ${estourou?.message}`);
    });
});

// O motor WASM roda em pthreads que não encerram sozinhos: encerra limpo.
after(() => setTimeout(() => process.exit(0), 100));
