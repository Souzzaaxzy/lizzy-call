/**
 * Group call media session for the bot.
 *
 * This is the piece that turns "the bot is in the call" into "the bot can be
 * heard". It owns the media stack (the WhatsApp Web WASM engine + the WebRTC
 * relay transport) and exposes two operations the bot needs:
 *
 *   - `entrarNaCall(grupo, membros)` — attach to a group call as a media
 *     participant, so the call can carry our audio;
 *   - `tocarAudio(grupo, arquivo)` / `pararAudio(grupo)` — feed a local audio
 *     file into the call, or stop it.
 *
 * ## Why this exists at all
 *
 * Signaling (the `<call><offer>` we already send) only makes a call *exist*. It
 * carries no sound: call media is RTP/SRTP over UDP to a relay, encrypted with a
 * key negotiated separately. WhatsApp Web implements that in WASM, and the
 * upstream caller SDK drives that WASM for 1:1 calls only. Group calls need one
 * extra thing the SDK never wired — the `group_update` roster/relay snapshot —
 * which `group-bridge.mts` now parses and this module applies.
 *
 * ## Lifecycle
 *
 * ```
 * !callp      -> entrarNaCall()  : engine up, join the group call, wait for media
 * !musicap    -> tocarAudio()    : ffmpeg -> 16 kHz mono PCM -> engine uplink
 * !callp end  -> sairDaCall()    : stop audio, end the call, tear the engine down
 * ```
 *
 * ## Honest failure
 *
 * Every step can fail for reasons outside our control (no relay allocated yet,
 * nobody else connected, engine can't start). Rather than pretending, each
 * method returns a result describing what happened, and the bot reports it.
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { WasmEngine } from './wasm-engine.mjs';
import { RelayRtcTransport, type RelayListUpdatePayload } from './relay-transport.mjs';
import { SignalingBridge } from './signaling.mjs';
import {
    parseGroupUpdate,
    applyGroupUpdate,
    applyKeyEpoch,
    buildParticipantLists,
    callObjectJid,
    bareJid,
    type GroupSession,
    type BinaryNode
} from './group-bridge.mjs';
import { AudioFeeder } from './audio-feeder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

/** How long to wait for the roster/relay before giving up on media. */
const MEDIA_WAIT_MS = 30_000;

/** How long to wait for the WASM stack to come up. */
const STACK_READY_MS = 20_000;

/** Call-state event ids the engine emits (see the WASM's onCallEvent). */
const EVENT_CALL_STATE = 16;
const EVENT_RELAY_LIST = 156;
const EVENT_CALL_ENDED = 2;

/** Where the media stack currently is, for diagnostics and honest reporting. */
export type MediaStage =
    | 'parado'
    | 'engine_iniciado'
    | 'call_iniciada'
    | 'aguardando_roster'
    | 'aguardando_relay'
    | 'aguardando_epoch'
    | 'pronta'
    | 'falhou';

export interface EntrarNaCallResult {
    ok: boolean;
    /** Set when ok: the call id we are attached to. */
    callId?: string;
    /** Set when !ok: why it failed. */
    motivo?: string;
    /** Set when ok but audio cannot flow yet (e.g. nobody else joined). */
    aviso?: string;
    stage: MediaStage;
}

export interface TocarAudioResult {
    ok: boolean;
    motivo?: string;
    arquivo?: string;
    stage: MediaStage;
}

/** Per-group media session. */
interface GroupMedia {
    engine: WasmEngine;
    relay: RelayRtcTransport;
    signaling: SignalingBridge;
    session: GroupSession;
    callId: string;
    selfJid: string;
    stage: MediaStage;
    feeder: AudioFeeder | null;
    capturePtr: number;
    captureSampleRate: number;
    captureChannels: number;
    captureFramesPerChunk: number;
    /** Resolves when media readiness flips to ready. */
    readyWaiters: { resolve: (r: { ready: boolean; reason?: string }) => void }[];
    aviso: string | null;
    /** Audio queued by `!musicap` before the capture pipeline was ready. */
    pendingAudioSource?: string;
    /** Why media was not ready on the last roster snapshot. */
    lastReadinessReason?: string;
}

/**
 * Owns every group-call media session in this process.
 *
 * One engine per group: the WASM stack keeps per-call state, and a second engine
 * in the same process would fight over it.
 */
export class GroupCallMedia {
    #sessions = new Map<string, GroupMedia>();
    #baileysModule: any = null;
    #log: (msg: string, extra?: unknown) => void;

    constructor(options: { log?: (msg: string, extra?: unknown) => void } = {}) {
        this.#log = options.log ?? (() => {});
    }

    /** Is there a live media session for this group? */
    temSessao(grupo: string): boolean {
        return this.#sessions.has(grupo);
    }

    /** Stage of the media stack for a group. */
    estagio(grupo: string): MediaStage {
        return this.#sessions.get(grupo)?.stage ?? 'parado';
    }

    /**
     * Attach to a group call as a media participant.
     *
     * `sock` is the bot's own Baileys socket — the media stack rides on the
     * session that is already linked, so no extra device is needed.
     *
     * @param grupo      group JID
     * @param callId     the call id from the signaling offer
     * @param callCreator who created the call
     * @param sock       the bot's Baileys socket
     * @param groupInfo  roster from our own offer, if we have it
     */
    entrarNaCall = async (options: {
        grupo: string;
        callId: string;
        callCreator: string;
        sock: any;
        groupInfo?: BinaryNode | null;
    }): Promise<EntrarNaCallResult> => {
        const { grupo, callId, callCreator, sock } = options;
        if (this.#sessions.has(grupo)) {
            return { ok: false, motivo: 'ja_na_call', stage: this.estagio(grupo) };
        }

        const selfJid = sock?.authState?.creds?.me?.lid ?? sock?.authState?.creds?.me?.id ?? null;
        if (!selfJid) {
            return { ok: false, motivo: 'sem_identidade', stage: 'parado' };
        }

        const engine = new WasmEngine({
            resourcesPath: PACKAGE_ROOT,
            callbacks: {
                onSignalingXmpp: (peerJid: string, cid: string, xmlPayload: Uint8Array) =>
                    this.#onSignaling(grupo, peerJid, cid, xmlPayload),
                onCallEvent: (type: number, data?: string) => this.#onCallEvent(grupo, type, data),
                sendDataToRelay: (data: Uint8Array, ip: string, port: number): number => {
                    try {
                        return this.#sessions.get(grupo)?.relay.send(data, ip, port) ?? 0;
                    } catch {
                        return 0;
                    }
                },
                onAudioCaptureInit: (cfg: { sampleRate: number; channels: number; framesPerChunk: number }) =>
                    this.#onCaptureInit(grupo, cfg),
                onAudioCaptureStart: () => this.#onCaptureStart(grupo),
                onAudioCaptureStop: () => this.#onCaptureStop(grupo),
                onAudioPlaybackData: () => {},
                cryptoHkdf: () => new Uint8Array(32),
                hmacSha256: () => new Uint8Array(32)
            }
        });

        const media: GroupMedia = {
            engine,
            relay: null as unknown as RelayRtcTransport,
            signaling: null as unknown as SignalingBridge,
            session: { relay: null },
            callId,
            selfJid,
            stage: 'parado',
            feeder: null,
            capturePtr: 0,
            captureSampleRate: 16000,
            captureChannels: 1,
            captureFramesPerChunk: 320,
            readyWaiters: [],
            aviso: null
        };
        this.#sessions.set(grupo, media);

        try {
            await engine.initialize();
            media.stage = 'engine_iniciado';

            media.relay = new RelayRtcTransport({
                onTransportMessage: (data, ip, port) => engine.handleOnTransportMessage(data, ip, port),
                onIceRtt: (rttMs, ip, port) => engine.updateIceRtt(rttMs, ip, port)
            });

            media.signaling = new SignalingBridge({ sock });
            await media.signaling.init();
            media.signaling.attachEngine(engine);

            engine.initVoipStack(selfJid, bareJid(selfJid) ?? selfJid, selfJid);
            await this.#waitStack(engine, STACK_READY_MS);

            // Take over the call: from here on, incoming call stanzas feed the
            // engine rather than only being reported.
            sock.ws?.on?.('CB:call', (node: any) => {
                void this.#onIncomingCallStanza(grupo, node);
            });

            const lists = options.groupInfo
                ? buildParticipantLists(parseGroupUpdate({
                    tag: 'group_update',
                    attrs: {},
                    content: [options.groupInfo]
                })?.groupInfo ?? null, selfJid)
                : { pnUserJids: [], lidUserJids: [], deviceJidsCsv: [] };

            engine.joinOngoingGroupCall({
                callId,
                callCreatorJid: callCreator,
                initialPeerJid: callCreator,
                groupJid: grupo,
                pnUserJids: lists.pnUserJids,
                lidUserJids: lists.lidUserJids,
                deviceJidsCsv: lists.deviceJidsCsv,
                initialGroupTransactionId: 0,
                joinAndAccept: true
            });
            media.stage = 'aguardando_roster';
            this.#log(`[CALLP] midia: entrou na call ${callId} do grupo ${grupo}`);

            // Media readiness needs the server's roster + relay. Wait a bounded
            // time and report honestly if it never arrives.
            const ready = await this.#waitForMedia(grupo, MEDIA_WAIT_MS);
            if (!ready.ready) {
                media.aviso = ready.reason ?? 'sem_midia';
                media.stage = 'aguardando_roster';
                return {
                    ok: true,
                    callId,
                    aviso: `Chamada aberta, mas a mídia ainda não está pronta (${ready.reason ?? 'sem motivo'}).`,
                    stage: media.stage
                };
            }

            media.stage = 'pronta';
            return { ok: true, callId, stage: media.stage };
        } catch (e: any) {
            this.#log(`[CALLP] midia falhou: ${e?.message || e}`);
            await this.#destroy(grupo);
            return { ok: false, motivo: e?.message || String(e), stage: 'falhou' };
        }
    };

    /**
     * Play a local audio file into the group call.
     *
     * The file is decoded by ffmpeg to 16 kHz mono PCM and metered into the
     * engine's uplink. Any format ffmpeg reads works (mp3, m4a, ogg, wav, opus,
     * or the .ogg voice note WhatsApp delivers).
     */
    tocarAudio = async (grupo: string, arquivo: string): Promise<TocarAudioResult> => {
        const media = this.#sessions.get(grupo);
        if (!media) return { ok: false, motivo: 'sem_call', stage: 'parado' };
        if (media.stage !== 'pronta') {
            return { ok: false, motivo: 'midia_nao_pronta', stage: media.stage };
        }
        if (media.feeder) {
            return { ok: false, motivo: 'ja_tocando', stage: media.stage };
        }

        // The WASM asks for capture through `onAudioCaptureInit`/`Start` once
        // the call is live; it allocated the uplink buffer for us there. If that
        // has not happened yet there is nowhere to write PCM, so say so instead
        // of silently playing into the void.
        media.pendingAudioSource = arquivo;
        try {
            media.engine.setMute(false);
        } catch { /* mute is best-effort */ }

        if (!media.capturePtr) {
            return { ok: false, motivo: 'captura_ainda_nao_iniciada', stage: media.stage };
        }
        this.#startFeeder(media, arquivo);
        if (!media.feeder) {
            return { ok: false, motivo: 'captura_nao_iniciou', stage: media.stage };
        }
        return { ok: true, arquivo, stage: media.stage };
    };

    /** Stop the audio currently playing, keeping the call up. */
    pararAudio = (grupo: string): { ok: boolean; motivo?: string } => {
        const media = this.#sessions.get(grupo);
        if (!media) return { ok: false, motivo: 'sem_call' };
        media.feeder?.stop();
        media.feeder = null;
        media.pendingAudioSource = undefined;
        return { ok: true };
    };

    /** Leave the call entirely and release the media stack. */
    sairDaCall = async (grupo: string): Promise<{ ok: boolean }> => {
        if (!this.#sessions.has(grupo)) return { ok: false };
        await this.#destroy(grupo);
        return { ok: true };
    };

    // ─── private ──────────────────────────────────────────────────────────────

    /**
     * The Baileys module, loaded lazily.
     *
     * It is a peer dependency and has no type declarations here, so the import
     * is dynamic and untyped on purpose. Both the fork name and the upstream
     * name are tried, so the module works in either setup.
     */
    #baileys = async (): Promise<any> => {
        if (this.#baileysModule) return this.#baileysModule;
        const names = ['@itsliaaa/baileys', '@whiskeysockets/baileys'];
        for (const name of names) {
            try {
                this.#baileysModule = await import(name);
                return this.#baileysModule;
            } catch { /* try the next name */ }
        }
        throw new Error('Baileys não encontrado (peer dependency ausente)');
    };

    #waitStack = async (engine: WasmEngine, timeoutMs: number): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (engine.isVoipStackReady?.()) return;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('a pilha de VoIP não ficou pronta');
    };

    #waitForMedia = (grupo: string, timeoutMs: number): Promise<{ ready: boolean; reason?: string }> => {
        const media = this.#sessions.get(grupo);
        if (!media) return Promise.resolve({ ready: false, reason: 'sem_sessao' });
        if (media.stage === 'pronta') return Promise.resolve({ ready: true });
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const still = media.readyWaiters.filter((w) => w.resolve !== wrapped);
                media.readyWaiters = still;
                resolve({ ready: false, reason: media.lastReadinessReason ?? 'timeout' });
            }, timeoutMs);
            const wrapped = (r: { ready: boolean; reason?: string }) => {
                clearTimeout(timer);
                resolve(r);
            };
            media.readyWaiters.push({ resolve: wrapped });
        });
    };

    #onSignaling = (grupo: string, peerJid: string, callId: string, xmlPayload: Uint8Array): void => {
        const media = this.#sessions.get(grupo);
        if (!media) return;
        void media.signaling.sendSignaling(peerJid, callId || media.callId, xmlPayload);
    };

    #onIncomingCallStanza = async (grupo: string, node: any): Promise<void> => {
        const media = this.#sessions.get(grupo);
        if (!media) return;
        try {
            const action = Array.isArray(node?.content) ? node.content[0] : null;
            if (!action) return;

            if (action.tag === 'group_update') {
                const parsed = parseGroupUpdate(action as BinaryNode);
                const result = applyGroupUpdate(media.session, parsed, media.selfJid);
                if (!result.applied) return;
                const readiness = result.readiness ?? { ready: false, reason: 'indefinido' };
                media.lastReadinessReason = readiness.reason;
                this.#log(`[CALLP] roster tx=${result.transactionId} participantes=${result.participants} conectados=${result.connected} midia=${readiness.ready}`);

                if (readiness.ready) {
                    media.stage = 'pronta';
                    for (const waiter of media.readyWaiters) waiter.resolve({ ready: true });
                    media.readyWaiters = [];
                } else if (readiness.reason === 'sem_epoch_de_chave') {
                    media.stage = 'aguardando_epoch';
                } else if (readiness.reason === 'sem_alocacao_de_relay') {
                    media.stage = 'aguardando_relay';
                }
                // Feed the engine so it can address media by PID.
                const { encodeBinaryNode } = await this.#baileys();
                media.engine.handleGroupUpdate({
                    payload: Buffer.from(encodeBinaryNode(action)).toString('base64'),
                    peerJid: node.attrs?.from ?? grupo
                });
                return;
            }

            if (action.tag === 'enc_rekey') {
                const keyNode = Array.isArray(action.content)
                    ? action.content.find((c: any) => c.tag === 'key')
                    : null;
                const key = keyNode?.content instanceof Uint8Array ? keyNode.content : null;
                const epoch = applyKeyEpoch(media.session, {
                    callId: action.attrs?.['call-id'],
                    callCreator: action.attrs?.['call-creator'],
                    transactionId: Number(action.attrs?.['transaction-id']),
                    key
                });
                if (epoch.applied) {
                    this.#log(`[CALLP] epoch de chave tx=${epoch.transactionId}`);
                }
                // The engine needs it too (it decrypts its own copy).
                const { encodeBinaryNode } = await this.#baileys();
                media.engine.handleEncRekey({
                    payload: Buffer.from(encodeBinaryNode(action)).toString('base64'),
                    peerJid: node.attrs?.from ?? grupo
                });
                return;
            }

            // Everything else (accept/transport/terminate/relaylatency) goes
            // through the SDK's existing path.
            media.signaling.processIncomingCall(node, media.engine, media.callId);
        } catch (e: any) {
            this.#log(`[CALLP] erro ao processar stanza: ${e?.message || e}`);
        }
    };

    #onCallEvent = (grupo: string, type: number, data?: string): void => {
        const media = this.#sessions.get(grupo);
        if (!media) return;
        if (type === EVENT_RELAY_LIST && data) {
            try {
                media.relay.updateRelayList(JSON.parse(data) as RelayListUpdatePayload);
            } catch (e: any) {
                this.#log(`[CALLP] relay list inválida: ${e?.message || e}`);
            }
        } else if (type === EVENT_CALL_STATE) {
            this.#log(`[CALLP] estado da call: ${data ?? ''}`);
        } else if (type === EVENT_CALL_ENDED) {
            this.#log('[CALLP] call encerrada pelo servidor');
            void this.#destroy(grupo);
        }
    };

    #onCaptureInit = (grupo: string, cfg: { sampleRate: number; channels: number; framesPerChunk: number }): void => {
        const media = this.#sessions.get(grupo);
        if (!media) return;
        media.captureSampleRate = cfg.sampleRate || 16000;
        media.captureChannels = cfg.channels || 1;
        media.captureFramesPerChunk = cfg.framesPerChunk || 320;
        const chunkSamples = media.captureFramesPerChunk * media.captureChannels;
        const bytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        media.capturePtr = media.engine.malloc(bytes);
    };

    #onCaptureStart = (grupo: string): void => {
        const media = this.#sessions.get(grupo);
        if (!media) return;
        if (media.feeder) return;
        this.#startFeeder(media, media.pendingAudioSource ?? 'silence');
    };

    #onCaptureStop = (grupo: string): void => {
        const media = this.#sessions.get(grupo);
        if (!media) return;
        media.feeder?.stop();
        media.feeder = null;
        if (media.capturePtr) {
            try { media.engine.free(media.capturePtr); } catch {}
            media.capturePtr = 0;
        }
    };

    #startFeeder = (media: GroupMedia, arquivo: string): void => {
        if (!media.capturePtr) {
            this.#log('[CALLP] captura sem ponteiro; audio não iniciado');
            return;
        }
        media.feeder = new AudioFeeder(
            media.captureSampleRate,
            media.captureChannels,
            media.captureFramesPerChunk,
            (chunk) => {
                if (media.capturePtr) media.engine.sendAudioData(chunk, media.capturePtr);
            },
            arquivo
        );
        media.feeder.start();
        this.#log(`[CALLP] tocando audio: ${arquivo}`);
    };

    #destroy = async (grupo: string): Promise<void> => {
        const media = this.#sessions.get(grupo);
        if (!media) return;
        this.#sessions.delete(grupo);
        try { media.feeder?.stop(); } catch {}
        try { media.engine.endCall(0, true); } catch {}
        try { media.engine.destroy?.(); } catch {}
        try { media.relay.closeAll?.(); } catch {}
    };
}
