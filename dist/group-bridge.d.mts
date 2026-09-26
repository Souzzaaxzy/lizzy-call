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
    tokens: {
        id?: number;
        token: Uint8Array | null;
    }[];
    authTokens: {
        id?: number;
        token: Uint8Array | null;
    }[];
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
/** Actions that carry a group roster update. */
export declare const GROUP_UPDATE_TAG = "group_update";
/** The shared-key epoch action. */
export declare const ENC_REKEY_TAG = "enc_rekey";
/** `jid` of the call object for a call id. */
export declare const callObjectJid: (callId: string) => string;
/**
 * Fresh call id: 16 random bytes as uppercase hex, the same shape WhatsApp Web
 * uses. The engine can generate one too; this is for callers that want the id up
 * front.
 */
export declare const generateCallId: () => string;
/** Bare account JID (strips the `:device` suffix). */
export declare const bareJid: (jid: string | null | undefined) => string | null;
/** Device id from a JID (`x:3@s.whatsapp.net` -> 3, `x@s.whatsapp.net` -> 0). */
export declare const deviceOf: (jid: string | null | undefined) => number;
/**
 * Parse one `<relay>` node into the allocation the transport needs.
 *
 * Returns null when the node is absent; throws nothing — a malformed relay is
 * reported as `{ error }` so the caller can log it instead of dying mid-call.
 */
export declare const parseRelay: (relayNode: BinaryNode | null) => RelayAllocation | null;
/**
 * Parse the `<group_info>` roster.
 *
 * `state` distinguishes participants who can carry media (`connected`) from
 * those merely invited (`outgoing`, `receipt`). Only connected devices have a
 * `pid`, and the PID — not the JID — is how media is addressed.
 */
export declare const parseGroupInfo: (groupInfoNode: BinaryNode | null) => GroupInfo | null;
/**
 * Parse a whole `group_update` action node.
 *
 * @returns `{ groupInfo, relay, avUpgradable }` or null when the node is not a
 *          group update.
 */
export declare const parseGroupUpdate: (node: BinaryNode | null | undefined) => ParsedGroupUpdate | null;
/**
 * Decide whether a roster snapshot should be applied.
 *
 * Roster updates are transactional and can arrive out of order. Applying an
 * older one would tear down media that is already flowing, so only strictly
 * increasing transactions are accepted (the first snapshot, with no prior
 * transaction, always is).
 */
export declare const shouldApplyRoster: (previousTransactionId?: number, nextTransactionId?: number) => boolean;
/**
 * Pick the relay endpoint to use from an allocation.
 *
 * The capture resolves the first usable non-FNA IPv4 endpoint in list order.
 * FNA ("fast network address"?) entries are skipped, as are entries without a
 * usable address or a matching token.
 */
export declare const pickRelayEndpoint: (relay: RelayAllocation | null) => RelayEndpoint | null;
/**
 * Does the engine have everything it needs to move media?
 *
 * The reference implementation gates media readiness on all three: an installed
 * key epoch, a connected remote device carrying a PID, and a usable relay
 * endpoint. Reporting readiness honestly is what keeps the bot from claiming a
 * call is audible when it is not.
 */
export declare const mediaReady: ({ relay, groupInfo, hasKeyEpoch, selfJid }: {
    relay: RelayAllocation | null;
    groupInfo: GroupInfo | null;
    hasKeyEpoch: boolean;
    selfJid: string | null;
}) => {
    ready: boolean;
    reason?: string;
    endpoint?: RelayEndpoint;
    peer?: RosterUser;
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
export declare const buildParticipantLists: (groupInfo: GroupInfo | null, selfJid: string | null) => {
    pnUserJids: string[];
    lidUserJids: string[];
    deviceJidsCsv: string[];
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
export declare const applyGroupUpdate: (session: GroupSession, update: ParsedGroupUpdate | null, selfJid: string | null) => {
    applied: boolean;
    reason: string;
    transactionId?: undefined;
    participants?: undefined;
    connected?: undefined;
    readiness?: undefined;
} | {
    applied: boolean;
    transactionId: number | undefined;
    participants: number;
    connected: number;
    readiness: {
        ready: boolean;
        reason?: string;
        endpoint?: RelayEndpoint;
        peer?: RosterUser;
    };
    reason?: undefined;
};
/**
 * Record a shared-key epoch (`enc_rekey`).
 *
 * Group media uses ONE 32-byte key shared by every participant, rotated per
 * epoch. Each participant derives its own send key from that shared key plus its
 * own id, so the epoch is what unlocks audio in both directions.
 */
export declare const applyKeyEpoch: (session: GroupSession, { callId, callCreator, transactionId, key }: {
    callId?: string;
    callCreator?: string;
    transactionId?: number;
    key: Uint8Array | null;
}) => {
    applied: boolean;
    reason: string;
    transactionId?: undefined;
} | {
    applied: boolean;
    transactionId: number | undefined;
    reason?: undefined;
};
