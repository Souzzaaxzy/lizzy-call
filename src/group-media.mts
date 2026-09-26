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
    generateCallId,
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
    /**
     * O setup da call FALHOU no servidor (`call_result` != 0).
     *
     * Marcado a partir do evento de estado do motor. Serve para NÃO alimentar
     * áudio num motor cuja call não existe — isso deixava o processo num estado
     * inconsistente e ele morria por sinal ("código: null" no log do bot).
     */
    callFalhou?: boolean;
}

/**
 * Build the call roster the engine needs, with real identities.
 *
 * `startVoipGroupCall` takes the participants in three parallel forms (PN users,
 * LID users, device JIDs) and zips them by index. The caller only knows the
 * group members' JIDs, which on a modern group are LIDs — so the phone-number
 * form has to be resolved, and the device list has to come from a real discovery
 * instead of assuming one device per person.
 *
 * Both are best-effort: a member whose PN or devices cannot be discovered is
 * still included with whatever is known, so one unreachable member does not sink
 * the whole call. Exported so the roster can be asserted without booting the
 * WASM (`tests/roster-build.mjs`).
 */
export const buildCallRoster = async (
    participantes: string[],
    selfJid: string,
    sock: any,
    log: (msg: string) => void = () => {}
): Promise<any[]> => {
    const selfBare = bareJid(selfJid) ?? selfJid;

    // O PRÓPRIO bot NÃO entra na lista de convidados.
    //
    // `startVoipGroupCall` recebe os CONVIDADOS; o motor já conhece a si mesmo
    // pelo `initVoipStack`. Medido (`measure-self-in-roster.mjs`): se o JID do
    // bot vier também na lista, o motor emite ZERO stanzas — nenhum offer sai e
    // a chamada nunca sobe. Era uma regressão real: o roster antigo não incluía
    // o bot, e a versão com identidades resolvidas passou a incluir.
    const convidados = [...new Set(participantes.filter(Boolean))].filter((jid) => {
        const bare = bareJid(jid) ?? jid;
        return bare !== selfBare && bare !== (bareJid(selfJid) ?? selfJid);
    });
    const removidos = [...new Set(participantes.filter(Boolean))].length - convidados.length;
    if (removidos > 0) {
        log(`[CALLP] ${removidos} entrada(s) do próprio bot removida(s) dos convidados`);
    }

    // Phone numbers: the LID->PN map lives on the socket's signal repository.
    const pnByLid = new Map<string, string>();
    try {
        const mapping = sock?.signalRepository?.lidMapping;
        if (mapping?.getPNsForLIDs) {
            const lids = convidados.filter((j) => String(j).endsWith('@lid'));
            if (lids.length) {
                const results = await mapping.getPNsForLIDs(lids.map((j) => bareJid(j) ?? j));
                for (const entry of results || []) {
                    if (entry?.lid && entry?.pn) pnByLid.set(bareJid(entry.lid) ?? entry.lid, entry.pn);
                }
            }
        }
    } catch (e: any) {
        log(`[CALLP] não consegui resolver PN dos convidados: ${e?.message || e}`);
    }

    // Devices: the same multi-device discovery the messaging path uses.
    const devicesByUser = new Map<string, string[]>();
    try {
        if (typeof sock?.getUSyncDevices === 'function') {
            const targets = [selfBare, ...convidados].filter(Boolean);
            const devices = await sock.getUSyncDevices(targets, true, false);
            for (const d of devices || []) {
                const jid = d?.jid;
                if (!jid) continue;
                const user = bareJid(jid) ?? jid;
                const existing = devicesByUser.get(user);
                if (existing) existing.push(jid);
                else devicesByUser.set(user, [jid]);
            }
        }
    } catch (e: any) {
        log(`[CALLP] não consegui descobrir devices dos convidados: ${e?.message || e}`);
    }

    return convidados.map((jid: string) => {
        const bare = bareJid(jid) ?? jid;
        const isLid = String(jid).endsWith('@lid');
        const pn = isLid ? (pnByLid.get(bare) ?? null) : bare;
        const discovered = devicesByUser.get(bare) ?? [];
        return {
            jid: bare,
            bare,
            pn,
            state: 'outgoing',
            type: null,
            connected: false,
            // Fall back to the account JID when discovery found nothing, so the
            // entry is never device-less (the engine rejects those).
            devices: (discovered.length ? discovered : [bare]).map((d) => ({
                jid: d,
                pid: undefined,
                platform: null,
                capabilityVersion: undefined
            }))
        };
    });
};

/**
 * Decide se a captura pode ser alimentada com áudio.
 *
 * ## Por que existe
 *
 * Medido no log do dono: o motor emite `call_result=4` /
 * `call_setup_error_type=1` / `is_group_call_created_on_server=false` (o setup
 * da call FALHOU) e, mesmo assim, o `startCaptureJS` chega e o feeder começa a
 * escrever PCM no uplink. Alimentar um motor cuja call não existe o deixa num
 * estado inconsistente e o processo MORRE POR SINAL — o log do bot mostra
 * "código: null", que é justamente ausência de código de saída.
 *
 * Sem a call criada no servidor não há para onde mandar áudio, então não manda.
 * Extraído como função pura para a regra ser testável sem WASM
 * (`tests/capture-gate.test.mjs`).
 */
export const podeAlimentarCaptura = (estado: {
    callFalhou?: boolean;
    feeder?: unknown;
} | null | undefined): { pode: boolean; motivo?: string } => {
    if (!estado) return { pode: false, motivo: 'sem_sessao' };
    if (estado.feeder) return { pode: false, motivo: 'ja_tocando' };
    if (estado.callFalhou) return { pode: false, motivo: 'setup_falhou' };
    return { pode: true };
};

/**
 * Interpreta o evento de estado da call.
 *
 * ## `call_result != 0` NÃO é falha
 *
 * Medido (`probe-estados.mjs`), com o motor real:
 *
 *   [t= 1357ms] state=1 result=4 setup=1 noSrv=false ending=false   <- logo apos criar
 *   [t=16469ms] state=0 result=8 ending=true                        <- falha real
 *
 * O `result=4` aparece ~100 ms depois de `startGroupCall`, ANTES de qualquer
 * resposta do servidor: é o **estado inicial** ("ainda não conectada"), não um
 * erro. Tratar `result != 0` como falha gerava um alarme falso em TODA chamada —
 * e fazia o log dizer "A CALL FALHOU NO SETUP" mesmo com a call saudável.
 *
 * A falha REAL é o motor começar a derrubar a call: `call_ending === true`, ou
 * `state === 0` (encerrada) com `result` de erro (8 = FAILED).
 *
 * Função pura, para ser testável sem WASM.
 */
export const setupDaCallFalhou = (data?: string): {
    falhou: boolean;
    resumo: string;
    result?: number;
    setupError?: number;
    encerrando?: boolean;
    motivo?: string;
} => {
    try {
        const info = JSON.parse(String(data)).call_info ?? {};
        const resumo = [
            `state=${info.call_state}`,
            `result=${info.call_result}`,
            `setupError=${info.call_setup_error_type}`,
            `noServidor=${info.is_group_call_created_on_server}`,
            `participantes=${info.participant_count}`,
            `encerrando=${info.call_ending}`,
            `grupo=${info.is_group_call}`
        ].join(' ');

        // Falha real: o motor está encerrando a call, ou ela terminou com erro.
        const encerrando = info.call_ending === true;
        const terminouComErro = info.call_state === 0 && Boolean(info.call_result) && info.call_result !== 0;
        const falhou = encerrando || terminouComErro;
        const motivo = encerrando ? 'encerrando' : terminouComErro ? `result=${info.call_result}` : undefined;

        return {
            falhou,
            resumo,
            result: info.call_result,
            setupError: info.call_setup_error_type,
            encerrando,
            motivo
        };
    } catch {
        return { falhou: false, resumo: data ?? '' };
    }
};

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
        /** Reuse a call id, or omit to let the engine generate one. */
        callId?: string;
        /** Participants to invite (bare JIDs). */
        participantes?: string[];
        sock: any;
        groupInfo?: BinaryNode | null;
    }): Promise<EntrarNaCallResult> => {
        const { grupo, sock } = options;
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
            callId: options.callId ?? '',
            selfJid,
            stage: 'parado',
            feeder: null,
            capturePtr: 0,
            captureSampleRate: 16000,
            captureChannels: 1,
            captureFramesPerChunk: 320,
            readyWaiters: [],
            aviso: null,
            // Sessão nova: o setup ainda não falhou.
            callFalhou: false
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

            // Diagnostico do ack: o motor precisa dele para concluir o setup.
            // Sem isso, uma confirmacao que nao chega fica invisivel e a call
            // simplesmente morre alguns segundos depois.
            media.signaling.onAckMissing = (stanzaId, tag, routeTo) => {
                this.#log(`[CALLP] SEM ACK para ${tag} (id=${stanzaId}, destino=${routeTo}) — o motor nao conclui o setup`);
            };
            media.signaling.onAckReceived = (stanzaId, tag, error) => {
                this.#log(`[CALLP] ack de ${tag} (id=${stanzaId}) error=${error}`);
            };

            // O ROSTER INICIAL vem dentro do ACK do offer de grupo (medido na
            // referencia: `ParseInitialGroupCallAck`). Aqui ele entra no MESMO
            // caminho de um `group_update` — que ja parseia o roster, aloca o
            // relay, aplica o epoch e alimenta o motor. Sem isto o motor fica sem
            // caminho de midia e a call fica "conectando..." para sempre.
            media.signaling.onGroupInfoFromAck = ({ groupInfo, peerJid }) => {
                this.#log('[CALLP] ack trouxe group_info/relay — aplicando o roster inicial');
                void this.#onIncomingCallStanza(grupo, {
                    attrs: { from: peerJid || grupo },
                    content: [groupInfo]
                });
            };

            engine.initVoipStack(selfJid, bareJid(selfJid) ?? selfJid, selfJid);
            await this.#waitStack(engine, STACK_READY_MS);

            // Take over the call: from here on, incoming call stanzas feed the
            // engine rather than only being reported.
            sock.ws?.on?.('CB:call', (node: any) => {
                void this.#onIncomingCallStanza(grupo, node);
            });

            // The ENGINE owns the call, and that is the whole point.
            //
            // Measured (`tests/wasm-call-ownership.mjs`): `startGroupCall` makes
            // the engine emit the `<call><offer>` itself, while
            // `joinVoipOngoingCall` is silent unless the engine already knows the
            // call. Creating the call with separate signaling therefore left the
            // engine with NO call state, and the negotiation never completed —
            // which is exactly the "conectando..." that never finishes.
            //
            // So the engine creates the call here, and the signaling it emits
            // goes out through the socket (see `#onSignaling`).
            const participantes = options.participantes ?? [];
            const roster = await this.#buildRoster(participantes, selfJid, sock);
            const lists = buildParticipantLists({ users: roster } as any, selfJid);
            this.#log(
                `[CALLP] roster: ${roster.length} convidados, ` +
                `pn=${lists.pnUserJids.length} lid=${lists.lidUserJids.length} devices=${lists.deviceJidsCsv.filter(Boolean).length}`
            );

            const novoCallId = options.callId || generateCallId();
            engine.startGroupCall({
                groupJid: grupo,
                pnUserJids: lists.pnUserJids,
                lidUserJids: lists.lidUserJids,
                deviceJidsCsv: lists.deviceJidsCsv,
                callId: novoCallId,
                isVideo: false
            });
            media.callId = novoCallId;
            media.stage = 'aguardando_roster';
            this.#log(`[CALLP] midia: engine criou a call ${novoCallId} no grupo ${grupo} (${participantes.length} convidados)`);

            // Media readiness needs the server's roster + relay. Wait a bounded
            // time and report honestly if it never arrives.
            // NÃO espera a mídia aqui.
            //
            // Esperar bloqueava o comando por até 30s (medido: 46,5s no total), e
            // enquanto o handler não retorna o bot fica sem responder a mais nada —
            // foi isso que o dono viu como "o bot travou e depois voltou dizendo
            // que iniciou". A chamada já foi criada; a prontidão da mídia chega
            // sozinha pelo `group_update` e é reportada quando acontecer.
            void this.#acompanharMidia(grupo);
            return { ok: true, callId: media.callId, stage: media.stage };
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

    /**
     * Build the roster through the exported helper (kept as a thin wrapper so the
     * log sink is wired in one place).
     */
    #buildRoster = (participantes: string[], selfJid: string, sock: any): Promise<any[]> =>
        buildCallRoster(participantes, selfJid, sock, (msg) => this.#log(msg));

    #waitStack = async (engine: WasmEngine, timeoutMs: number): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (engine.isVoipStackReady?.()) return;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('a pilha de VoIP não ficou pronta');
    };

    /**
     * Acompanha a prontidão da mídia DEPOIS que o comando já respondeu.
     *
     * Não segura o handler: só registra no log quando a mídia fica pronta (ou
     * quando o tempo acaba), para o operador saber o que aconteceu sem que o bot
     * pare de responder nesse meio tempo.
     */
    #acompanharMidia = async (grupo: string): Promise<void> => {
        const ready = await this.#waitForMedia(grupo, MEDIA_WAIT_MS);
        const media = this.#sessions.get(grupo);
        if (!media) return;
        if (ready.ready) {
            media.stage = 'pronta';
            this.#log(`[CALLP] mídia PRONTA no grupo ${grupo} — \`!musicap\` já pode tocar`);
        } else {
            media.aviso = ready.reason ?? 'sem_midia';
            this.#log(`[CALLP] mídia não ficou pronta em ${Math.round(MEDIA_WAIT_MS / 1000)}s (${media.aviso}); a chamada segue aberta`);
        }
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
        // O bridge engole os próprios erros (`catch(() => {})`); aqui pelo menos
        // registramos que a sinalização saiu, senão uma falha de envio fica
        // invisível e o sintoma vira "a chamada não inicia" sem motivo aparente.
        this.#log(`[CALLP] sinalização -> ${peerJid} (${xmlPayload?.length ?? 0} bytes)`);
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
                // O epoch vem CIFRADO. Medido contra a referencia
                // (`ParseGroupCallEncRekey`): o formato real e
                //
                //   <enc_rekey call-id call-creator transaction-id>
                //     <encopt keygen="2"/>
                //     <enc type="msg|pkmsg" v="2">CIPHERTEXT</enc>
                //   </enc_rekey>
                //
                // A versao anterior procurava um filho `<key>` cru, que NAO
                // existe nesse formato — o epoch nunca era aceito e a midia
                // ficava presa em "sem_epoch_de_chave" para sempre.
                //
                // Quem decifra e o MOTOR (ele tem as sessoes Signal); aqui basta
                // reconhecer a presenca do epoch cifrado para o portao de
                // prontidao abrir, e repassar a stanza intacta ao motor.
                const encNode = Array.isArray(action.content)
                    ? action.content.find((c: any) => c.tag === 'enc')
                    : null;
                const keyNode = Array.isArray(action.content)
                    ? action.content.find((c: any) => c.tag === 'key')
                    : null;

                const ciphertext = encNode?.content instanceof Uint8Array ? encNode.content : null;
                const rawKey = keyNode?.content instanceof Uint8Array ? keyNode.content : null;
                // O portao aceita o epoch cifrado (formato real). Um `<key>` cru
                // continua valido, para compatibilidade com stanzas ja capturadas.
                const epochMaterial = rawKey ?? ciphertext;

                if (ciphertext) {
                    this.#log(`[CALLP] enc_rekey cifrado (type=${encNode?.attrs?.type} v=${encNode?.attrs?.v}, ${ciphertext.length} bytes)`);
                }

                const epoch = applyKeyEpoch(media.session, {
                    callId: action.attrs?.['call-id'],
                    callCreator: action.attrs?.['call-creator'],
                    transactionId: Number(action.attrs?.['transaction-id']),
                    key: epochMaterial
                });
                if (epoch.applied) {
                    this.#log(`[CALLP] epoch de chave tx=${epoch.transactionId}`);
                } else {
                    this.#log(`[CALLP] epoch NAO aplicado: ${epoch.reason}`);
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
            // O objeto de estado e' enorme; aqui so' os campos que dizem se a call
            // realmente existe no servidor. Sem eles, um 'call_result: 4' passa
            // invisivel e o sintoma vira 'nao inicia' sem motivo.
            const { falhou, resumo, motivo } = setupDaCallFalhou(data);
            if (falhou) {
                // Falha REAL (o motor começou a derrubar a call), não o
                // `result=4` do estado inicial — ver o comentário da função.
                this.#log(`[CALLP] a call ESTA CAINDO (${motivo}) — nao vou alimentar audio`);
                media.callFalhou = true;
                media.feeder?.stop();
                media.feeder = null;
            }
            this.#log(`[CALLP] estado da call: ${resumo}`);
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

        // NÃO alimentar áudio quando a call NÃO existe no servidor. Ver
        // `podeAlimentarCaptura`: alimentar um motor cujo setup falhou o deixa
        // num estado inconsistente e o processo morre por SINAL ("código: null"
        // no log do bot, que reinicia e derruba a call no meio do comando).
        const { pode, motivo } = podeAlimentarCaptura(media);
        if (!pode) {
            if (motivo === 'setup_falhou') {
                this.#log('[CALLP] captura pedida com o setup FALHO — nao vou alimentar audio (a call nao existe no servidor)');
            }
            return;
        }
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
