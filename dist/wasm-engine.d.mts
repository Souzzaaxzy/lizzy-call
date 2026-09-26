export type WasmAudioConfig = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    framesPerChunk: number;
};
export type WasmEngineCallbacks = {
    onSignalingXmpp?: (peerJid: string, callId: string, xmlPayload: Uint8Array) => void;
    onCallEvent?: (eventType: number, eventData?: string) => void;
    onVoipReady?: () => void;
    sendDataToRelay?: (data: Uint8Array, ip: string, port: number) => number;
    onLog?: (level: string, message: string) => void;
    onAudioCaptureInit?: (config: WasmAudioConfig) => void;
    onAudioCaptureStart?: () => void;
    onAudioCaptureStop?: () => void;
    onAudioPlaybackInit?: (config: WasmAudioConfig) => void;
    onAudioPlaybackStart?: () => void;
    onAudioPlaybackStop?: () => void;
    onAudioPlaybackData?: (audioData: Float32Array) => void;
    cryptoHkdf?: (key: Uint8Array, salt: Uint8Array | null, info: Uint8Array, length: number) => Uint8Array;
    hmacSha256?: (data: Uint8Array, key: Uint8Array) => Uint8Array;
};
export type WasmEngineConfig = {
    resourcesPath?: string;
    wasmPath?: string;
    wasmBinary?: Uint8Array;
    loaderCode?: string;
    workerModulesCode?: string;
    loaderModuleName?: string;
    callbacks?: WasmEngineCallbacks;
    enableLogs?: boolean;
    options?: {
        heartbeatInterval?: number;
        lobbyTimeout?: number;
        maxParticipantsScreenShare?: number;
        maxGroupSizeLongRingtone?: number;
        logLevel?: number;
    };
};
export declare class WasmEngine {
    #private;
    static registerGlobalCallbackListener: (callbackName: string, handler: (data: any) => void) => void;
    static notifyGlobalCallbackListeners: (callbackName: string, data: any) => void;
    constructor(config?: WasmEngineConfig);
    initialize: () => Promise<void>;
    isInitialized: () => boolean;
    destroy: () => void;
    initVoipStack: (selfJid: string, meUserJid: string, selfLid: string) => void;
    waitForVoipStackReady: () => Promise<void>;
    isVoipStackReady: () => boolean;
    startCall: (options: {
        peerJid: string;
        peerPn: string;
        peerList?: string[];
        callId: string;
        isVideo: boolean;
        isLidCall?: boolean;
        isFromDialer?: boolean;
        extraData?: Uint8Array;
    }) => unknown;
    endCall: (reason?: number, sendTerminate?: boolean) => void;
    setMute: (muted: boolean) => number;
    updateNetworkMedium: (networkMedium: number, networkMtu?: number) => void;
    handleSignalingOffer: (msg: {
        payload: string;
        peerPlatform?: number;
        peerAppVersion?: string;
        epochId?: string;
        timestamp?: string;
        isOffline?: boolean;
        isOfferNotContact?: boolean;
        peerJid: string;
        tcToken?: Uint8Array;
    }) => void;
    handleSignalingMessage: (msg: {
        payload: string;
        peerPlatform?: string | number;
        peerAppVersion?: string;
        epochId?: string;
        timestamp?: string;
        isOffline?: boolean;
        peerJid: string;
        tcToken?: Uint8Array;
    }) => void;
    handleSignalingAck: (msg: {
        payload: string;
        ackError?: string;
        msgType?: string;
        peerJid?: string;
        extraData?: Uint8Array;
    }) => void;
    handleSignalingReceipt: (msg: {
        payload: string;
        peerJid: string;
        tcToken?: Uint8Array;
    }) => void;
    handleOnTransportMessage: (data: Uint8Array, ip: string, port: number) => void;
    updateIceRtt: (rttMs: number, relayIp: string, relayPort: number) => void;
    sendAudioData: (data: Float32Array, ptr: number) => void;
    malloc: (size: number) => number;
    free: (ptr: number) => void;
    /**
     * Start a group call as its creator.
     *
     * @param options.groupJid        group the call is bound to
     * @param options.pnUserJids      participants' phone-number JIDs
     * @param options.lidUserJids     the same participants as LIDs
     * @param options.deviceJidsCsv   one CSV string per participant: its devices
     * @param options.callId          logical call id (from the signaling offer)
     * @param options.isVideo         request video instead of audio
     */
    startGroupCall: (options: {
        groupJid: string;
        pnUserJids: string[];
        lidUserJids: string[];
        deviceJidsCsv: string[];
        callId: string;
        isVideo?: boolean;
        isLightWeight?: boolean;
        chatName?: string;
        username?: string;
    }) => unknown;
    /**
     * Join a group call that is already active (the `!callp` → `!musicap` flow:
     * the call exists, we attach media to it).
     *
     * @param options.callId                  active call id
     * @param options.callCreatorJid          who created the call
     * @param options.initialPeerJid          first remote participant
     * @param options.initialGroupTransactionId roster transaction from the offer
     */
    joinOngoingGroupCall: (options: {
        callId: string;
        callCreatorJid: string;
        initialPeerJid: string;
        groupJid?: string;
        pnUserJids?: string[];
        lidUserJids?: string[];
        deviceJidsCsv?: string[];
        initialGroupTransactionId?: number;
        isVideo?: boolean;
        joinAndAccept?: boolean;
    }) => unknown;
    /** Ask the engine whether a call is already running (group-aware). */
    checkOngoingCalls: () => unknown;
    /**
     * Introspection for diagnostics and tests: the method names the instantiated
     * WASM module actually exposes. Used to verify a group entry point exists
     * before a call path depends on it.
     */
    describeInstance: () => {
        methods: string[];
    };
    /**
     * Feed a `group_update` roster/relay snapshot to the engine.
     *
     * This is the piece the upstream SDK never wired: `group_update` is how the
     * server hands us the participant roster, the per-device PIDs and the relay
     * allocation. Without it the engine has no media path, so it is sent through
     * the generic signaling entry point (the same one used for
     * accept/transport/terminate), which is where the WASM routes group actions.
     */
    handleGroupUpdate: (msg: {
        payload: string;
        peerJid: string;
        callId?: string;
        peerPlatform?: string | number;
        peerAppVersion?: string;
        epochId?: string;
        timestamp?: string;
    }) => void;
    /**
     * Feed an `enc_rekey` (group key epoch) to the engine.
     *
     * Group media uses one shared 32-byte key per epoch, re-distributed whenever
     * someone joins or leaves. It arrives encrypted per device, so it goes through
     * the same decrypting path as a signaling offer.
     */
    handleEncRekey: (msg: {
        payload: string;
        peerJid: string;
        peerPlatform?: string | number;
        peerAppVersion?: string;
        epochId?: string;
        timestamp?: string;
    }) => void;
    /** Invite one participant into an active call (roster + ring). */
    inviteToCall: (options: {
        callId: string;
        peerJid: string;
        peerPn?: string;
        deviceJids?: string[];
        isVideo?: boolean;
    }) => unknown;
}
export default WasmEngine;
