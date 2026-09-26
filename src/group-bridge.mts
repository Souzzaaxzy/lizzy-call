import { randomBytes } from 'crypto';
/**
 * Group-call bridge.
 *
 * The upstream caller SDK wires the 1:1 path only: it handles `offer`, `accept`,
 * `transport`, `terminate` and `relaylatency`, but never `group_update`. That is
 * the stanza where the server hands a group call its participant roster, the
 * per-device PIDs, and — critically — the **relay allocation** (key, tokens,
 * endpoints). Without it the WASM engine has no media path at all, which is why
 * "start a group call" alone never produced audio.
 *
 * This module closes that gap. It is deliberately pure with respect to I/O: it
 * takes parsed WABinary nodes and produces typed values plus the calls to make
 * on the engine, so the parsing can be tested without a socket or a call.
 *
 * ## What a group call needs, and where each piece comes from
 *
 * | Piece | Stanza | Why it matters |
 * |---|---|---|
 * | Roster (users + devices) | `group_update` > `group_info` | who is in the call |
 * | Per-device PID | `group_update` > `group_info` > `user` > `device@pid` | media is addressed by PID, not JID |
 * | Relay allocation | `group_update` > `relay` | the UDP path for media |
 * | Shared key epoch | `enc_rekey` | one 32-byte key per epoch, per participant |
 * | Roster transaction | `group_info@transaction-id` | snapshots must increase; stale ones are ignored |
 *
 * ## Shape reference
 *
 * Field names come from the group-call captures published by the WhatsApp Calls
 * Research Group effort and the `meowcaller` datasheets
 * (`voip/group_update_ingest`), which list the exact attribute paths:
 *
 * ```
 * call/group_update/group_info.attrs.transaction-id
 * call/group_update/group_info.attrs.media
 * call/group_update/group_info.attrs.group-jid        (optional)
 * call/group_update/group_info.attrs.joinable         (optional)
 * call/group_update/group_info/user.attrs.jid
 * call/group_update/group_info/user.attrs.state
 * call/group_update/group_info/user/device.attrs.jid
 * call/group_update/group_info/user/device.attrs.pid   (connected devices only)
 * call/group_update/relay.attrs.transaction-id
 * call/group_update/relay.attrs.self_pid
 * call/group_update/relay/token.attrs.id
 * call/group_update/relay/auth_token.attrs.id
 * call/group_update/relay/key
 * call/group_update/relay/te2.attrs.relay_id
 * ```
 */

/** A WABinary node as it arrives from the socket. */
export interface BinaryNode {
    tag: string;
    attrs: Record<string, string>;
    content?: unknown;
}

/** One linked device of a participant. */
export interface RosterDevice {
    jid: string | null;
    pid?: number;
    platform: string | null;
    capabilityVersion?: number;
}

/** One participant in the call roster. */
export interface RosterUser {
    jid: string | null;
    bare: string | null;
    pn: string | null;
    state: string | null;
    type: string | null;
    devices: RosterDevice[];
    connected: boolean;
}

/** The roster half of a group update. */
export interface GroupInfo {
    callId: string | null;
    callCreator: string | null;
    transactionId?: number;
    media: string | null;
    connectedLimit?: number;
    groupJid: string | null;
    joinable: boolean;
    rekeyRequested: boolean;
    users: RosterUser[];
}

/** One relay endpoint candidate. */
export interface RelayEndpoint {
    relayId?: number;
    tokenId?: number;
    authTokenId?: number;
    relayName: string | null;
    isFna: boolean;
    ipv4: string | null;
    port: number | null;
    address: Uint8Array | null;
}

/** The relay allocation for a group call. */
export interface RelayAllocation {
    transactionId?: number;
    selfPid?: number;
    uuid: string | null;
    participantUuid: string | null;
    warpMiTagLength?: number;
    key: Uint8Array | null;
    hbhKey: Uint8Array | null;
    tokens: { id?: number; token: Uint8Array | null }[];
    authTokens: { id?: number; token: Uint8Array | null }[];
    endpoints: RelayEndpoint[];
}

/** A parsed group_update. */
export interface ParsedGroupUpdate {
    groupInfo: GroupInfo | null;
    relay: RelayAllocation | null;
    avUpgradable: boolean;
}

/** Per-call mutable state this bridge maintains. */
export interface GroupSession {
    transactionId?: number;
    groupInfo?: GroupInfo;
    relay?: RelayAllocation | null;
    groupJid?: string;
    keyEpoch?: Uint8Array;
    keyEpochTransactionId?: number;
    keyEpochCallId?: string;
    keyEpochCallCreator?: string;
}

/** JIDs whose server is `call` address the call object itself. */
const CALL_SERVER = 'call';

/** Actions that carry a group roster update. */
export const GROUP_UPDATE_TAG = 'group_update';

/** The shared-key epoch action. */
export const ENC_REKEY_TAG = 'enc_rekey';

/** `jid` of the call object for a call id. */
export const callObjectJid = (callId: string): string => `${callId}@${CALL_SERVER}`;

/**
 * Fresh call id: 16 random bytes as uppercase hex, the same shape WhatsApp Web
 * uses. The engine can generate one too; this is for callers that want the id up
 * front.
 */
export const generateCallId = (): string =>
    randomBytes(16).toString('hex').toUpperCase();

/** Bare account JID (strips the `:device` suffix). */
export const bareJid = (jid: string | null | undefined): string | null => {
    if (typeof jid !== 'string' || !jid) return null;
    const [user, server] = jid.split('@');
    if (!server) return null;
    return `${user.split(':')[0]}@${server}`;
};

/** Device id from a JID (`x:3@s.whatsapp.net` -> 3, `x@s.whatsapp.net` -> 0). */
export const deviceOf = (jid: string | null | undefined): number => {
    if (typeof jid !== 'string' || !jid) return 0;
    const user = jid.split('@')[0];
    const [, device] = user.split(':');
    const parsed = Number(device);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Children of a node, defensively. */
const children = (node: BinaryNode | null | undefined): BinaryNode[] => (Array.isArray(node?.content) ? node.content : []);

/** First child with a tag. */
const childByTag = (node: BinaryNode | null | undefined, tag: string): BinaryNode | null => children(node).find((c) => c?.tag === tag) || null;

/** All children with a tag. */
const childrenByTag = (node: BinaryNode | null | undefined, tag: string): BinaryNode[] => children(node).filter((c) => c?.tag === tag);

/** Read a byte payload as a Uint8Array, whatever shape it arrived in. */
const bytesOf = (node: BinaryNode | null | undefined): Uint8Array | null => {
    const content = node?.content;
    if (content instanceof Uint8Array) return content;
    if (Buffer.isBuffer(content)) return new Uint8Array(content);
    if (Array.isArray(content)) return new Uint8Array(content);
    return null;
};

const num = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Parse one `<relay>` node into the allocation the transport needs.
 *
 * Returns null when the node is absent; throws nothing — a malformed relay is
 * reported as `{ error }` so the caller can log it instead of dying mid-call.
 */
export const parseRelay = (relayNode: BinaryNode | null): RelayAllocation | null => {
    if (!relayNode) return null;
    const attrs = relayNode.attrs || {};
    const key = bytesOf(childByTag(relayNode, 'key'));
    const hbhKey = bytesOf(childByTag(relayNode, 'hbh_key'));

    const tokens = childrenByTag(relayNode, 'token').map((t) => ({
        id: num(t.attrs?.id),
        token: bytesOf(t)
    }));
    const authTokens = childrenByTag(relayNode, 'auth_token').map((t) => ({
        id: num(t.attrs?.id),
        token: bytesOf(t)
    }));

    // `te2` carries the relay endpoints: id + an address blob whose last two
    // bytes are a big-endian port.
    const endpoints = childrenByTag(relayNode, 'te2').map((te) => {
        const address = bytesOf(te);
        let ipv4 = null;
        let port = null;
        if (address && address.length === 6) {
            ipv4 = `${address[0]}.${address[1]}.${address[2]}.${address[3]}`;
            port = (address[4] << 8) | address[5];
        }
        return {
            relayId: num(te.attrs?.relay_id),
            tokenId: num(te.attrs?.token_id),
            authTokenId: num(te.attrs?.auth_token_id),
            relayName: te.attrs?.relay_name ?? null,
            isFna: te.attrs?.is_fna === '1',
            ipv4,
            port,
            address
        };
    });

    return {
        transactionId: num(attrs['transaction-id']),
        selfPid: num(attrs.self_pid),
        uuid: attrs.uuid ?? null,
        participantUuid: attrs.participant_uuid ?? null,
        warpMiTagLength: num(attrs.warp_mi_tag_len),
        key,
        hbhKey,
        tokens,
        authTokens,
        endpoints
    };
};

/**
 * Parse the `<group_info>` roster.
 *
 * `state` distinguishes participants who can carry media (`connected`) from
 * those merely invited (`outgoing`, `receipt`). Only connected devices have a
 * `pid`, and the PID — not the JID — is how media is addressed.
 */
export const parseGroupInfo = (groupInfoNode: BinaryNode | null): GroupInfo | null => {
    if (!groupInfoNode) return null;
    const attrs = groupInfoNode.attrs || {};

    const users = childrenByTag(groupInfoNode, 'user').map((userNode) => {
        const userAttrs = userNode.attrs || {};
        const jid = userAttrs.jid ?? null;
        const devices = childrenByTag(userNode, 'device').map((deviceNode) => {
            const deviceAttrs = deviceNode.attrs || {};
            return {
                jid: deviceAttrs.jid ?? null,
                pid: num(deviceAttrs.pid),
                platform: deviceAttrs.platform ?? null,
                capabilityVersion: num(deviceAttrs.ver)
            };
        });
        return {
            jid,
            bare: bareJid(jid),
            pn: userAttrs.user_pn ?? null,
            state: userAttrs.state ?? null,
            type: userAttrs.type ?? null,
            devices,
            /** True when this participant can carry media right now. */
            connected: userAttrs.state === 'connected'
        };
    });

    return {
        callId: attrs['call-id'] ?? null,
        callCreator: attrs['call-creator'] ?? null,
        transactionId: num(attrs['transaction-id']),
        media: attrs.media ?? null,
        connectedLimit: num(attrs['connected-limit']),
        groupJid: attrs['group-jid'] ?? null,
        joinable: attrs.joinable === '1',
        rekeyRequested: attrs.rekey === '1',
        users
    };
};

/**
 * Parse a whole `group_update` action node.
 *
 * @returns `{ groupInfo, relay, avUpgradable }` or null when the node is not a
 *          group update.
 */
export const parseGroupUpdate = (node: BinaryNode | null | undefined): ParsedGroupUpdate | null => {
    if (!node || node.tag !== GROUP_UPDATE_TAG) return null;
    const groupInfoNode = childByTag(node, 'group_info');
    const relayNode = childByTag(node, 'relay');
    const avUpgrade = childByTag(node, 'av_upgrade');
    return {
        groupInfo: parseGroupInfo(groupInfoNode),
        relay: parseRelay(relayNode),
        avUpgradable: avUpgrade?.attrs?.['av-upgradable'] === '1'
    };
};

/**
 * Decide whether a roster snapshot should be applied.
 *
 * Roster updates are transactional and can arrive out of order. Applying an
 * older one would tear down media that is already flowing, so only strictly
 * increasing transactions are accepted (the first snapshot, with no prior
 * transaction, always is).
 */
export const shouldApplyRoster = (previousTransactionId?: number, nextTransactionId?: number): boolean => {
    if (nextTransactionId === undefined || !Number.isFinite(nextTransactionId)) return false;
    if (previousTransactionId === undefined || !Number.isFinite(previousTransactionId)) return true;
    return nextTransactionId > previousTransactionId;
};

/**
 * Pick the relay endpoint to use from an allocation.
 *
 * The capture resolves the first usable non-FNA IPv4 endpoint in list order.
 * FNA ("fast network address"?) entries are skipped, as are entries without a
 * usable address or a matching token.
 */
export const pickRelayEndpoint = (relay: RelayAllocation | null): RelayEndpoint | null => {
    if (!relay || !relay.endpoints?.length) return null;
    for (const endpoint of relay.endpoints) {
        if (endpoint.isFna) continue;
        if (!endpoint.ipv4 || !endpoint.port) continue;
        const tokenOk =
            relay.tokens?.some((t: { id?: number }) => t.id === endpoint.tokenId) ?? false;
        if (!tokenOk) continue;
        return endpoint;
    }
    return null;
};

/**
 * Does the engine have everything it needs to move media?
 *
 * The reference implementation gates media readiness on all three: an installed
 * key epoch, a connected remote device carrying a PID, and a usable relay
 * endpoint. Reporting readiness honestly is what keeps the bot from claiming a
 * call is audible when it is not.
 */
export const mediaReady = ({
    relay,
    groupInfo,
    hasKeyEpoch,
    selfJid
}: {
    relay: RelayAllocation | null;
    groupInfo: GroupInfo | null;
    hasKeyEpoch: boolean;
    selfJid: string | null;
}): { ready: boolean; reason?: string; endpoint?: RelayEndpoint; peer?: RosterUser } => {
    if (!hasKeyEpoch) return { ready: false, reason: 'sem_epoch_de_chave' };
    if (!relay) return { ready: false, reason: 'sem_alocacao_de_relay' };

    const endpoint = pickRelayEndpoint(relay);
    if (!endpoint) return { ready: false, reason: 'sem_endpoint_utilizavel' };

    const selfBare = bareJid(selfJid);
    const remoteWithPid = (groupInfo?.users || []).find(
        (user) =>
            user.connected &&
            user.bare !== selfBare &&
            user.devices.some((d: RosterDevice) => Number.isFinite(d.pid))
    );
    if (!remoteWithPid) return { ready: false, reason: 'sem_remoto_conectado_com_pid' };

    return { ready: true, endpoint, peer: remoteWithPid };
};

/**
 * Build the participant lists `startVoipGroupCall` / `joinVoipOngoingCall` want.
 *
 * The engine takes the same participants in three parallel arrays — PN users,
 * LID users and one CSV of device JIDs — and zips them BY INDEX. Entry `i` must
 * therefore describe the same person in all three, so the lists always keep the
 * same length.
 *
 * ## Prefer a real PN, fall back to the LID
 *
 * `pnUserJids` is the phone-number form. The roster the server sends carries the
 * account as a LID, and `user_pn` only when the server knows the number — so a
 * participant with no known PN falls back to its LID there. Dropping the entry
 * instead would shift every later participant out of alignment, which is worse
 * than the fallback (`tests/participant-lists.mjs`).
 */
export const buildParticipantLists = (groupInfo: GroupInfo | null, selfJid: string | null): { pnUserJids: string[]; lidUserJids: string[]; deviceJidsCsv: string[] } => {
    const pnUserJids: string[] = [];
    const lidUserJids: string[] = [];
    const deviceJidsCsv: string[] = [];

    for (const user of groupInfo?.users || []) {
        if (!user.jid) continue;
        const isLid = user.jid.endsWith('@lid');

        // Phone-number form: the known PN, else the LID (alignment > purity).
        const pn = isLid ? user.pn : user.jid;
        // LID form: the LID account, or the PN's LID when the roster has one.
        const lid = isLid ? user.jid : user.pn;

        pnUserJids.push(pn || user.jid);
        lidUserJids.push(lid || user.jid);

        const devices = user.devices.map((d: RosterDevice) => d.jid).filter(Boolean) as string[];
        deviceJidsCsv.push(devices.join(','));
    }

    return { pnUserJids, lidUserJids, deviceJidsCsv };
};

/**
 * Apply a parsed `group_update` to a call session.
 *
 * This is the seam the upstream SDK lacks. It keeps the roster transaction
 * monotonic, stores the relay allocation, and reports whether media can start —
 * the caller then tells the engine and (if ready) begins feeding audio.
 *
 * @param session  mutable per-call state (`{ relay, groupInfo, transactionId, keyEpoch }`)
 * @param update   result of `parseGroupUpdate`
 * @param selfJid  our own JID
 */
export const applyGroupUpdate = (session: GroupSession, update: ParsedGroupUpdate | null, selfJid: string | null) => {
    if (!session || !update?.groupInfo) return { applied: false, reason: 'sem_group_info' };

    const next = update.groupInfo.transactionId;
    if (!shouldApplyRoster(session.transactionId, next)) {
        return { applied: false, reason: 'transacao_antiga' };
    }

    session.transactionId = next;
    session.groupInfo = update.groupInfo;
    if (update.relay) session.relay = update.relay;
    else session.relay = session.relay ?? null;
    if (update.groupInfo.groupJid) session.groupJid = update.groupInfo.groupJid;

    const readiness = mediaReady({
        relay: session.relay,
        groupInfo: session.groupInfo,
        hasKeyEpoch: Boolean(session.keyEpoch),
        selfJid
    });

    return {
        applied: true,
        transactionId: next,
        participants: session.groupInfo.users.length,
        connected: session.groupInfo.users.filter((u: RosterUser) => u.connected).length,
        readiness
    };
};

/**
 * Record a shared-key epoch (`enc_rekey`).
 *
 * Group media uses ONE 32-byte key shared by every participant, rotated per
 * epoch. Each participant derives its own send key from that shared key plus its
 * own id, so the epoch is what unlocks audio in both directions.
 */
export const applyKeyEpoch = (
    session: GroupSession,
    { callId, callCreator, transactionId, key }: {
        callId?: string;
        callCreator?: string;
        transactionId?: number;
        key: Uint8Array | null;
    }
) => {
    if (!session) return { applied: false, reason: 'sem_sessao' };
    if (!key || key.length < 32) return { applied: false, reason: 'epoch_curto' };
    if (
        transactionId !== undefined &&
        Number.isFinite(transactionId) &&
        session.keyEpochTransactionId !== undefined &&
        Number.isFinite(session.keyEpochTransactionId)
    ) {
        if (transactionId <= session.keyEpochTransactionId) {
            return { applied: false, reason: 'epoch_antigo' };
        }
    }
    session.keyEpoch = key;
    session.keyEpochTransactionId = transactionId;
    session.keyEpochCallId = callId ?? session.keyEpochCallId;
    session.keyEpochCallCreator = callCreator ?? session.keyEpochCallCreator;
    return { applied: true, transactionId };
};
