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
