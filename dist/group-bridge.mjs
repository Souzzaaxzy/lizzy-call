import { randomBytes } from 'crypto';
/** JIDs whose server is `call` address the call object itself. */
const CALL_SERVER = 'call';
/** Actions that carry a group roster update. */
export const GROUP_UPDATE_TAG = 'group_update';
/** The shared-key epoch action. */
export const ENC_REKEY_TAG = 'enc_rekey';
/** `jid` of the call object for a call id. */
export const callObjectJid = (callId) => `${callId}@${CALL_SERVER}`;
/**
 * Fresh call id: 16 random bytes as uppercase hex, the same shape WhatsApp Web
 * uses. The engine can generate one too; this is for callers that want the id up
 * front.
 */
export const generateCallId = () => randomBytes(16).toString('hex').toUpperCase();
/** Bare account JID (strips the `:device` suffix). */
export const bareJid = (jid) => {
    if (typeof jid !== 'string' || !jid)
        return null;
    const [user, server] = jid.split('@');
    if (!server)
        return null;
    return `${user.split(':')[0]}@${server}`;
};
/** Device id from a JID (`x:3@s.whatsapp.net` -> 3, `x@s.whatsapp.net` -> 0). */
export const deviceOf = (jid) => {
    if (typeof jid !== 'string' || !jid)
        return 0;
    const user = jid.split('@')[0];
    const [, device] = user.split(':');
    const parsed = Number(device);
    return Number.isFinite(parsed) ? parsed : 0;
};
/** Children of a node, defensively. */
const children = (node) => (Array.isArray(node?.content) ? node.content : []);
/** First child with a tag. */
const childByTag = (node, tag) => children(node).find((c) => c?.tag === tag) || null;
/** All children with a tag. */
const childrenByTag = (node, tag) => children(node).filter((c) => c?.tag === tag);
/** Read a byte payload as a Uint8Array, whatever shape it arrived in. */
const bytesOf = (node) => {
    const content = node?.content;
    if (content instanceof Uint8Array)
        return content;
    if (Buffer.isBuffer(content))
        return new Uint8Array(content);
    if (Array.isArray(content))
        return new Uint8Array(content);
    return null;
};
const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};
/**
 * Parse one `<relay>` node into the allocation the transport needs.
 *
 * Returns null when the node is absent; throws nothing — a malformed relay is
 * reported as `{ error }` so the caller can log it instead of dying mid-call.
 */
export const parseRelay = (relayNode) => {
    if (!relayNode)
        return null;
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
export const parseGroupInfo = (groupInfoNode) => {
    if (!groupInfoNode)
        return null;
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
export const parseGroupUpdate = (node) => {
    if (!node || node.tag !== GROUP_UPDATE_TAG)
        return null;
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
export const shouldApplyRoster = (previousTransactionId, nextTransactionId) => {
    if (nextTransactionId === undefined || !Number.isFinite(nextTransactionId))
        return false;
    if (previousTransactionId === undefined || !Number.isFinite(previousTransactionId))
        return true;
    return nextTransactionId > previousTransactionId;
};
/**
 * Pick the relay endpoint to use from an allocation.
 *
 * The capture resolves the first usable non-FNA IPv4 endpoint in list order.
 * FNA ("fast network address"?) entries are skipped, as are entries without a
 * usable address or a matching token.
 */
export const pickRelayEndpoint = (relay) => {
    if (!relay || !relay.endpoints?.length)
        return null;
    for (const endpoint of relay.endpoints) {
        if (endpoint.isFna)
            continue;
        if (!endpoint.ipv4 || !endpoint.port)
            continue;
        const tokenOk = relay.tokens?.some((t) => t.id === endpoint.tokenId) ?? false;
        if (!tokenOk)
            continue;
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
export const mediaReady = ({ relay, groupInfo, hasKeyEpoch, selfJid }) => {
    if (!hasKeyEpoch)
        return { ready: false, reason: 'sem_epoch_de_chave' };
    if (!relay)
        return { ready: false, reason: 'sem_alocacao_de_relay' };
    const endpoint = pickRelayEndpoint(relay);
    if (!endpoint)
        return { ready: false, reason: 'sem_endpoint_utilizavel' };
    const selfBare = bareJid(selfJid);
    const remoteWithPid = (groupInfo?.users || []).find((user) => user.connected &&
        user.bare !== selfBare &&
        user.devices.some((d) => Number.isFinite(d.pid)));
    if (!remoteWithPid)
        return { ready: false, reason: 'sem_remoto_conectado_com_pid' };
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
export const buildParticipantLists = (groupInfo, selfJid) => {
    const pnUserJids = [];
    const lidUserJids = [];
    const deviceJidsCsv = [];
    for (const user of groupInfo?.users || []) {
        if (!user.jid)
            continue;
        const isLid = user.jid.endsWith('@lid');
        // Phone-number form: the known PN, else the LID (alignment > purity).
        const pn = isLid ? user.pn : user.jid;
        // LID form: the LID account, or the PN's LID when the roster has one.
        const lid = isLid ? user.jid : user.pn;
        pnUserJids.push(pn || user.jid);
        lidUserJids.push(lid || user.jid);
        const devices = user.devices.map((d) => d.jid).filter(Boolean);
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
export const applyGroupUpdate = (session, update, selfJid) => {
    if (!session || !update?.groupInfo)
        return { applied: false, reason: 'sem_group_info' };
    const next = update.groupInfo.transactionId;
    if (!shouldApplyRoster(session.transactionId, next)) {
        return { applied: false, reason: 'transacao_antiga' };
    }
    session.transactionId = next;
    session.groupInfo = update.groupInfo;
    if (update.relay)
        session.relay = update.relay;
    else
        session.relay = session.relay ?? null;
    if (update.groupInfo.groupJid)
        session.groupJid = update.groupInfo.groupJid;
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
        connected: session.groupInfo.users.filter((u) => u.connected).length,
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
export const applyKeyEpoch = (session, { callId, callCreator, transactionId, key }) => {
    if (!session)
        return { applied: false, reason: 'sem_sessao' };
    // Aceita o epoch CIFRADO (formato real: `<enc>` msg/pkmsg v=2, com o
    // ciphertext) alem do `<key>` cru de 32 bytes das capturas antigas. Exigir
    // 32 bytes recusava o formato real, e a midia ficava em
    // 'sem_epoch_de_chave' para sempre. Quem decifra e o motor.
    if (!key || key.length === 0)
        return { applied: false, reason: 'sem_epoch' };
    if (transactionId !== undefined &&
        Number.isFinite(transactionId) &&
        session.keyEpochTransactionId !== undefined &&
        Number.isFinite(session.keyEpochTransactionId)) {
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
