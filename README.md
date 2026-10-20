# lizzy-call

Group-call media stack for WhatsApp Web, built on the VoIP WASM engine.

This package is a fork of **[baileys-caller](https://github.com/SheIITear/baileys-caller)**
by **ShellTear** (MIT), extended with **group-call support**. The original
covered 1:1 calls only; everything group-related here is new.

The WASM assets (`assets/wasm/whatsapp.wasm`, `loader.js`, `worker-modules.js`)
come from the upstream repository unchanged. They are WhatsApp Web's own
proprietary engine, vendored so no browser session is needed to obtain them.

## What the group support adds

| Piece | File | What it does |
|---|---|---|
| Group entry points | `src/wasm-engine.mts` | `startGroupCall`, `joinOngoingGroupCall`, `checkOngoingCalls`, `inviteToCall` — wrappers over `startVoipGroupCall` / `joinVoipOngoingCall`, which the upstream SDK never called |
| Roster + relay bridge | `src/group-bridge.mts` | Parses `group_update` (participant roster, per-device PIDs, relay allocation) and `enc_rekey` (shared key epoch). The upstream SDK never handled `group_update` at all, which is why group media had no path |
| Media session | `src/group-media.mts` | Ties it together: attach to a group call, wait for media readiness honestly, play a local audio file into the call |
| Audio drain fix | `src/audio-feeder.mts` | The original stopped emitting as soon as ffmpeg exited, so only ~40 ms of any file played. Now it drains the queue |

## Fixes on top of the original group work

**The server ack was being dropped.** `#sendCallStanza` sent the stanza and only
then called `waitForMessage`. The ack is a WebSocket frame, so a fast one arrived
while no listener existed and was discarded — the engine never learned the offer
was accepted, the setup stalled, and the call died a few seconds later with
`call_result: 4` / `call_setup_error_type: 1` (the "conectando..." that never
finishes). The wait is now registered **before** the send, the same ordering the
socket's own `query()` uses. Locked by `tests/signaling-ack-race.test.mjs`.

**The roster carried the wrong identities.** `entrarNaCall` fabricated the
participants from the member JIDs: `pn: null` and a single device equal to the
account JID. On a modern group those members are LIDs, so the engine received
LIDs in the phone-number slot and a device list that never came from discovery.
The roster is now built by `buildCallRoster`, which resolves LID→PN through the
socket's mapping and discovers devices with `getUSyncDevices`. Locked by
`tests/roster.test.mjs`.


## Why `group_update` matters

Signaling alone (`<call><offer>`) only makes a call *exist*. Media is RTP/SRTP
over UDP to a relay, keyed per participant. A group call needs three things the
server only provides in `group_update`:

1. the **roster** — who is in the call, and which of their devices;
2. the **PIDs** — media is addressed by PID, not by JID;
3. the **relay allocation** — the UDP endpoints, key and tokens.

Plus one shared **key epoch** per `enc_rekey`. `group-bridge.mts` parses all of
it and `mediaReady()` gates playback on all three, so the caller is told the
truth instead of getting a call that looks up but carries nothing.

## Raw UDP legs (the relay with no ICE)

A group-call relay often arrives **without an ICE credential**. The reference
that works (`zapo-caller`, marked `working` by the wacrg) classifies it exactly
like this (`group-media-plan.js`):

```js
endpoint.authToken ? undefined : 'raw-udp'
```

— i.e. **a relay with no `authToken` only works over raw UDP**. Dialing that
relay through an `RTCPeerConnection` has no ICE to negotiate: the call sits on
connecting forever, with nothing arriving. That was the defect.

The transport now opens a **raw UDP leg** for those relays (a connected
`node:dgram` socket — the 5-tuple *is* the leg, no ICE/DTLS/SCTP), mirroring
`rawUdpLegs: 'required'`:

| `CALL_RAW_UDP` | behavior |
| --- | --- |
| `required` (default) | raw UDP **only** for the relay with no `authToken` |
| `all` | every relay goes raw UDP |
| `0` / `off` | raw UDP disabled (WebRTC only) |

Because sending is what elects a raw leg, it **polices its own return path**: if
media goes out and none comes back, the leg closes (`raw_udp_no_return_path`)
instead of pretending the call is up. The leg uses the relay's **advertised
port** (a raw leg keeps the advertised one; only WebRTC legs move to 3480).

## Usage

```js
import { GroupCallMedia } from 'lizzy-call/group-media';

const media = new GroupCallMedia({ log: console.log });

// Attach to a group call on an existing Baileys socket.
const joined = await media.entrarNaCall({
  grupo: '123@g.us',
  callId: 'ABCDEF...',
  callCreator: 'creator@lid',
  sock,                      // your linked Baileys socket
});

// Play a file into the call (any format ffmpeg reads).
if (joined.ok && media.estagio('123@g.us') === 'pronta') {
  await media.tocarAudio('123@g.us', '/path/to/song.mp3');
}
```

## Tests

```bash
npm run build
node --test tests/
```

## License

MIT, inherited from baileys-caller. See `LICENSE`.

The vendored WASM is WhatsApp Web's proprietary engine and is not covered by
that license. Use at your own discretion.
