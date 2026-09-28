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
export declare const buildCallRoster: (participantes: string[], selfJid: string, sock: any, log?: (msg: string) => void) => Promise<any[]>;
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
export declare const podeAlimentarCaptura: (estado: {
    callFalhou?: boolean;
    feeder?: unknown;
} | null | undefined) => {
    pode: boolean;
    motivo?: string;
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
export declare const setupDaCallFalhou: (data?: string) => {
    falhou: boolean;
    resumo: string;
    result?: number;
    setupError?: number;
    encerrando?: boolean;
    motivo?: string;
};
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
        /** Reuse a call id, or omit to let the engine generate one. */
        callId?: string;
        /** Participants to invite (bare JIDs). */
        participantes?: string[];
        sock: any;
        groupInfo?: BinaryNode | null;
        /**
         * Inicia um CHAT DE VOZ em vez de uma chamada comum.
         *
         * Evidência no WASM instalado (`assets/wasm/whatsapp.wasm`): existe um
         * caminho próprio `voice_chat.cc` com `is_voice_chat`, `is_lightweight`,
         * `lightweight-key` e `is_scheduled_call`, e a string
         * `preprocess_offer: sending missed call event for voice chat init`.
         *
         * O `startVoipGroupCall` do motor tem um parâmetro dedicado a isso
         * (`isLightWeight`), que este pacote repassava SEMPRE `false`. Com ele em
         * `true` o motor declara o offer como voice chat e o servidor trata a
         * chamada como o chat de voz do grupo (entra sem tocar), em vez da
         * chamada que toca para todo mundo.
         */
        isLightWeight?: boolean;
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
