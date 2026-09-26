/**
 * A sequência EXATA do log: áudio tocando + o motor destruindo a call.
 *
 * ## Por que este teste
 *
 * O log do dono, em ordem:
 *
 *   1. ack -> roster tx=15 ... midia=false
 *   2. `tocando audio: silence`       <- feeder ALIMENTANDO (ffmpeg decodifica)
 *   3. roster tx=17 ... midia=false
 *   4. `bot terminou com erro (código: null)`  <- morto por SINAL
 *
 * A hipótese: o motor **desiste** da call (~15s sem convergir), emite
 * `call_ending`/`EVENT_CALL_ENDED`, o `#destroy` termina os 20 workers — e fazer
 * isso **enquanto o feeder escreve no heap compartilhado** faz o WASM abortar
 * nativamente. Exceção JS não é (o `código: null` prova: morto por sinal).
 *
 * Este teste reproduz a MESMA ordem: alimenta PCM e destrói no meio.
 *
 * Run: node --test tests/audio-e-destroy.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = path.resolve(process.cwd());
const { WasmEngine } = await import(pathToFileURL(path.join(raiz, 'dist/wasm-engine.mjs')).href);
const { AudioFeeder } = await import(pathToFileURL(path.join(raiz, 'dist/audio-feeder.mjs')).href);

const temFfmpeg = (() => {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
    catch { return false; }
})();

const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001:14@lid';
const GROUP = '120363432070074647@g.us';

describe('áudio + teardown da call', () => {
    it('destruir o motor com o feeder ativo NÃO pode derrubar o processo', async (t) => {
        if (!temFfmpeg) {
            t.skip('sem ffmpeg o PCM não chega ao motor (ambiente)');
            return;
        }

        let estourou = null;
        const onUncaught = (e) => { estourou = e; };
        process.once('uncaughtException', onUncaught);

        const engine = new WasmEngine({ callbacks: {
            onSignalingXmpp: () => {}, onCallEvent: () => {}, sendDataToRelay: () => 0,
            onAudioCaptureInit: () => {}, onAudioCaptureStart: () => {}, onAudioCaptureStop: () => {},
            onAudioPlaybackData: () => {},
            cryptoHkdf: () => new Uint8Array(32), hmacSha256: () => new Uint8Array(32),
        } });

        await engine.initialize();
        engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
        await engine.waitForVoipStackReady();

        engine.startGroupCall({
            groupJid: GROUP,
            pnUserJids: ['5511911111111@s.whatsapp.net', '5511922222222@s.whatsapp.net'],
            lidUserJids: ['200000000000002@lid', '200000000000003@lid'],
            deviceJidsCsv: ['200000000000002@lid', '200000000000003@lid'],
            callId: 'B'.repeat(32),
            isVideo: false,
        });
        await new Promise((r) => setTimeout(r, 800));

        // 1. O feeder começa a escrever PCM no uplink (como "tocando audio").
        const ptr = engine.malloc(320 * 4);
        const feeder = new AudioFeeder(16000, 1, 320, (chunk) => {
            engine.sendAudioData(chunk, ptr);
        }, 'silence');
        feeder.start();
        await new Promise((r) => setTimeout(r, 1000));

        // 2. A call morre e o motor é destruído — COM o feeder ainda ativo.
        //    É a ordem do log: `tocando audio` e, segundos depois, o teardown.
        try { engine.destroy(); } catch { /* ignore */ }

        // 3. O feeder continua disparando por um tempo: ele tem um timer próprio
        //    que ainda escreve num motor já destruído (`#instance = null`).
        await new Promise((r) => setTimeout(r, 3000));

        try { feeder.stop(); } catch { /* ignore */ }
        process.off('uncaughtException', onUncaught);

        assert.equal(estourou, null, `não pode lançar (o bot reiniciaria): ${estourou?.message}`);
    });
});

after(() => setTimeout(() => process.exit(0), 100));
