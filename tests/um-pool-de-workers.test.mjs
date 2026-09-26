/**
 * UM pool de workers, não dois.
 *
 * ## O defeito medido
 *
 * O motor subia **dois pools**: o nosso (`PTHREAD_POOL_SIZE`) e o do WASM
 * (`ThreadPoolManager`, default **20**), porque nunca passávamos
 * `pthreadPoolSizeOverride`. Contando as threads reais do processo
 * (`/proc/self/task`):
 *
 *   ANTES  threads= 7   rss= 51 MB
 *   DEPOIS threads=33   rss=644 MB      -> 26 workers = 6 (nosso) + 20 (do WASM)
 *
 * E o pool do WASM é o que **falha**: ele tenta preaquecer por 15s e desiste,
 * com o log do próprio motor:
 *
 *   voip: ThreadPoolManager: pthread worker prewarm timed out after 15000ms;
 *   continuing with 0 ready workers
 *
 * Ou seja: além do dobro de memória (~300 MB a mais, medidos), o motor ficava
 * com **0 workers prontos** para a mídia — um estado degradado.
 *
 * ## O que este teste trava
 *
 * Conta as threads do processo depois de subir o motor. Se os dois pools
 * voltarem, o número sobe para ~33 e o teste falha.
 *
 * Run: node --test tests/um-pool-de-workers.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = path.resolve(process.cwd());
const { WasmEngine } = await import(pathToFileURL(path.join(raiz, 'dist/wasm-engine.mjs')).href);

const contarThreads = () => {
    try { return readdirSync('/proc/self/task').length; } catch { return -1; }
};
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

describe('pool de workers do motor', () => {
    it('sobe UM pool, não dois (medido pelas threads do processo)', async () => {
        const antes = contarThreads();
        const rssAntes = rssMb();

        const engine = new WasmEngine({ callbacks: {
            onSignalingXmpp: () => {}, onCallEvent: () => {}, sendDataToRelay: () => 0,
            onAudioCaptureInit: () => {}, onAudioCaptureStart: () => {}, onAudioCaptureStop: () => {},
            onAudioPlaybackData: () => {},
            cryptoHkdf: () => new Uint8Array(32), hmacSha256: () => new Uint8Array(32),
        } });
        await engine.initialize();
        await new Promise((r) => setTimeout(r, 800));

        const depois = contarThreads();
        const rssDepois = rssMb();
        const workers = depois - antes;

        try { engine.destroy?.(); } catch { /* ignore */ }

        // Com DOIS pools eram 26 workers (6 + 20). Com um só, é o nosso tamanho
        // (6) mais as threads auxiliares do runtime — bem abaixo de 20.
        assert.ok(
            workers < 20,
            `não pode subir dois pools: ${workers} workers criados (antes ${antes} threads, rss ${rssAntes}MB; depois ${depois}, rss ${rssDepois}MB)`
        );
        // E a memória não pode voltar aos ~900 MB do pool duplicado.
        assert.ok(
            rssDepois - rssAntes < 500,
            `memória alta demais para um pool só: +${rssDepois - rssAntes}MB`
        );
    });
});

after(() => setTimeout(() => process.exit(0), 100));
