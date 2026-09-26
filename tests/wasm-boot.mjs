/**
 * Smoke test: does the WhatsApp WASM VoIP engine actually initialise here?
 *
 * This is the riskiest step of the whole feature. The engine is WhatsApp Web's
 * own WASM stack, driven through a shimmed worker environment. If it does not
 * come up in this container, no amount of signaling work matters, so this test
 * answers that question first and in isolation.
 *
 * It does NOT touch the network or a WhatsApp session: it boots the engine,
 * waits for the VoIP stack to report ready, and reports what it saw.
 *
 * Run: node tests/wasm-boot.mjs
 */

import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const { WasmEngine } = await import(new URL('../dist/wasm-engine.mjs', import.meta.url).href);

const seen = { signaling: 0, callEvents: [], audioCapture: 0, playback: 0 };

const engine = new WasmEngine({
    callbacks: {
        onSignalingXmpp: () => { seen.signaling += 1; },
        onCallEvent: (type, data) => { seen.callEvents.push({ type, data: String(data ?? '').slice(0, 120) }); },
        sendDataToRelay: () => {},
        onAudioCaptureInit: () => { seen.audioCapture += 1; },
        onAudioCaptureStart: () => {},
        onAudioCaptureStop: () => {},
        onAudioPlaybackData: () => { seen.playback += 1; },
        cryptoHkdf: () => new Uint8Array(32),
        hmacSha256: () => new Uint8Array(32),
    },
});

console.log('[wasm-boot] initialising engine...');
const startedAt = Date.now();
try {
    await engine.initialize();
    console.log(`[wasm-boot] initialize() OK in ${Date.now() - startedAt}ms`);
} catch (e) {
    console.error('[wasm-boot] initialize() FAILED:', e?.message || e);
    process.exit(1);
}

console.log('[wasm-boot] isInitialized =', engine.isInitialized?.());

// The stack needs our own identity to build call state.
const SELF_PN = '5511900000001@s.whatsapp.net';
const SELF_LID = '100000000000001@lid';
try {
    engine.initVoipStack(SELF_PN, SELF_PN, SELF_LID);
    console.log('[wasm-boot] initVoipStack() OK');
} catch (e) {
    console.error('[wasm-boot] initVoipStack() FAILED:', e?.message || e);
    process.exit(1);
}

try {
    await engine.waitForVoipStackReady();
    console.log('[wasm-boot] voip stack READY');
} catch (e) {
    console.error('[wasm-boot] waitForVoipStackReady() FAILED:', e?.message || e);
    console.log('[wasm-boot] isVoipStackReady =', engine.isVoipStackReady?.());
    process.exit(1);
}

console.log('[wasm-boot] callbacks seen:', JSON.stringify({
    signaling: seen.signaling,
    audioCaptureInit: seen.audioCapture,
    callEvents: seen.callEvents.length
}));

try { engine.destroy?.(); } catch {}

console.log('\n[wasm-boot] RESULT: engine boots and the VoIP stack becomes ready.');
process.exit(0);
