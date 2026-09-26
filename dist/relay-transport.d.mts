type RelayAddress = {
    protocol: number;
    ipv4?: string;
    ipv6?: string;
    port?: number;
    port_v6?: number;
};
type RelayDescriptor = {
    relay_id: number;
    relay_name: string;
    token_id: number;
    auth_token_id?: number;
    addresses: RelayAddress[];
};
export type RelayListUpdatePayload = {
    relay_key: string;
    relay_tokens: string[];
    auth_tokens?: string[];
    enable_edgeray_dtls_active_mode?: boolean;
    relays: RelayDescriptor[];
};
export type RelayTransportStats = {
    sentPackets: number;
    receivedPackets: number;
    sentBytes: number;
    receivedBytes: number;
    droppedPackets: number;
    openConnections: number;
};
export type RelayTransportConfig = {
    onTransportMessage: (data: Uint8Array, ip: string, port: number) => void;
    onIceRtt?: (rttMs: number, ip: string, port: number) => void;
    /**
     * Diagnóstico por etapa do transporte (Fase 3 da investigação).
     *
     * Sem isto, o log só dizia "relay list inválida" quando a lista NÃO parseava —
     * e nada quando ela chegava. Não dava para distinguir "o relay não chegou" de
     * "chegou, escolheu endpoint, começou a conectar e falhou", que são causas
     * completamente diferentes.
     *
     * NUNCA recebe material sensível: só id, índice, tamanho e estado.
     */
    onStage?: (stage: RelayStage, detalhe: RelayStageDetalhe) => void;
};
/** Etapas observáveis do caminho do relay (nenhuma carrega credencial). */
export type RelayStage = 'relay_list_recebida' | 'endpoint_selecionado' | 'transporte_iniciando' | 'conexao_aberta' | 'conexao_falhou' | 'stun_alloc_visto' | 'midia_enviada';
export type RelayStageDetalhe = {
    relayName?: string | null;
    relayId?: number;
    ip?: string;
    port?: number;
    originalPort?: number;
    endpoints?: number;
    state?: string;
    /** Só o tamanho, nunca o conteúdo da credencial. */
    tokenLen?: number;
    authTokenLen?: number;
    keyLen?: number;
};
export declare class RelayRtcTransport {
    #private;
    private readonly config;
    constructor(config: RelayTransportConfig);
    updateRelayList: (update: RelayListUpdatePayload) => void;
    send: (packet: Uint8Array | Buffer, ip: string, port: number) => number;
    getStats: () => RelayTransportStats;
    closeAll: () => Promise<void>;
}
export {};
