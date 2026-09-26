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
import { type BinaryNode } from './group-bridge.mjs';
/** Where the media stack currently is, for diagnostics and honest reporting. */
export type MediaStage = 'parado' | 'engine_iniciado' | 'call_iniciada' | 'aguardando_roster' | 'aguardando_relay' | 'aguardando_epoch' | 'pronta' | 'falhou';
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
/**
 * Owns every group-call media session in this process.
 *
 * One engine per group: the WASM stack keeps per-call state, and a second engine
 * in the same process would fight over it.
 */
export declare class GroupCallMedia {
    #private;
    constructor(options?: {
        log?: (msg: string, extra?: unknown) => void;
    });
    /** Is there a live media session for this group? */
    temSessao(grupo: string): boolean;
    /** Stage of the media stack for a group. */
    estagio(grupo: string): MediaStage;
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
    entrarNaCall: (options: {
        grupo: string;
        callId: string;
        callCreator: string;
        sock: any;
        groupInfo?: BinaryNode | null;
    }) => Promise<EntrarNaCallResult>;
    /**
     * Play a local audio file into the group call.
     *
     * The file is decoded by ffmpeg to 16 kHz mono PCM and metered into the
     * engine's uplink. Any format ffmpeg reads works (mp3, m4a, ogg, wav, opus,
     * or the .ogg voice note WhatsApp delivers).
     */
    tocarAudio: (grupo: string, arquivo: string) => Promise<TocarAudioResult>;
    /** Stop the audio currently playing, keeping the call up. */
    pararAudio: (grupo: string) => {
        ok: boolean;
        motivo?: string;
    };
    /** Leave the call entirely and release the media stack. */
    sairDaCall: (grupo: string) => Promise<{
        ok: boolean;
    }>;
}
