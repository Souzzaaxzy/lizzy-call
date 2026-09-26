/**
 * Audio feeder.
 *
 * Spawns ffmpeg to decode `source` into f32le PCM at the requested rate, then
 * meters frames out at chunk cadence to the WASM uplink.
 *
 * ## Why the drain loop looks like this
 *
 * ffmpeg reads a local file far faster than real time, so it finishes and exits
 * while most of the decoded audio is still sitting in our queue. An earlier
 * version stopped the emitter as soon as the child process was gone, which meant
 * only the first couple of chunks ever reached the call — about 40 ms of any
 * song. The emitter must therefore keep draining the queue after ffmpeg exits,
 * and only stop when the queue is empty too.
 *
 * @author ShellTear
 */
import { spawn } from "node:child_process";
const LOW_WATERMARK_CHUNKS = 16;
const MAX_QUEUED_CHUNKS = 1024;
const DEFAULT_WARMUP_MS = 500;
export class AudioFeeder {
    sampleRate;
    channels;
    framesPerChunk;
    onChunk;
    source;
    onEnd;
    #proc = null;
    #pending = Buffer.alloc(0);
    #queue = [];
    #emitTimer = null;
    #nextEmitAtMs = 0;
    #warmupUntilMs = 0;
    #procExited = false;
    #drained = false;
    droppedChunks = 0;
    underflowChunks = 0;
    bytesProduced = 0;
    chunksEmitted = 0;
    constructor(sampleRate, channels, framesPerChunk, onChunk, source = "silence", 
    /** Called once, when the source has been fully played out. */
    onEnd = null) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.framesPerChunk = framesPerChunk;
        this.onChunk = onChunk;
        this.source = source;
        this.onEnd = onEnd;
    }
    start = () => {
        if (this.#proc)
            return;
        const chunkSamples = this.framesPerChunk * this.channels;
        const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
        const inputArgs = this.#resolveInputArgs();
        this.#procExited = false;
        this.#drained = false;
        this.#proc = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            "-thread_queue_size", "512",
            ...inputArgs,
            "-f", "f32le",
            "-ac", String(this.channels),
            "-ar", String(this.sampleRate),
            "pipe:1",
        ]);
        this.#proc.stdout.on("data", (chunk) => {
            this.#pending = Buffer.concat([this.#pending, chunk]);
            while (this.#pending.length >= chunkBytes) {
                if (this.#queue.length >= MAX_QUEUED_CHUNKS) {
                    this.#proc?.stdout.pause();
                    break;
                }
                const frame = this.#pending.subarray(0, chunkBytes);
                this.#pending = this.#pending.subarray(chunkBytes);
                const out = new Float32Array(chunkSamples);
                out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
                this.bytesProduced += chunkBytes;
                this.#queue.push(out);
            }
        });
        this.#proc.stderr.on("data", (chunk) => {
            process.stderr.write(`[AudioFeeder] ${chunk.toString().trim()}\n`);
        });
        this.#proc.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                process.stderr.write(`[AudioFeeder] ffmpeg exited with code=${code}\n`);
            }
            // Flush the tail: ffmpeg can exit with a partial chunk still pending.
            if (this.#pending.length >= Float32Array.BYTES_PER_ELEMENT) {
                const usable = Math.floor(this.#pending.length / Float32Array.BYTES_PER_ELEMENT) * Float32Array.BYTES_PER_ELEMENT;
                const out = new Float32Array(chunkSamples);
                const slice = this.#pending.subarray(0, Math.min(usable, chunkBytes));
                out.set(new Float32Array(slice.buffer, slice.byteOffset, Math.floor(slice.length / 4)));
                this.#queue.push(out);
                this.#pending = Buffer.alloc(0);
            }
            this.#proc = null;
            this.#procExited = true;
            // Do NOT stop the emitter here: the queue still holds the decoded audio.
            this.#scheduleNext(chunkSamples, chunkIntervalMs);
        });
        this.#nextEmitAtMs = 0;
        this.#warmupUntilMs = Date.now() + DEFAULT_WARMUP_MS;
        this.#scheduleNext(chunkSamples, chunkIntervalMs);
    };
    stop = () => {
        if (this.#emitTimer) {
            clearTimeout(this.#emitTimer);
            this.#emitTimer = null;
        }
        this.#proc?.kill("SIGTERM");
        this.#proc = null;
        this.#pending = Buffer.alloc(0);
        this.#queue = [];
        this.#warmupUntilMs = 0;
        this.#procExited = false;
    };
    #resolveInputArgs = () => {
        if (!this.source || this.source === "silence") {
            return ["-f", "lavfi", "-i", `aevalsrc=0:d=3600:s=${this.sampleRate}`];
        }
        if (this.source.startsWith("lavfi:")) {
            return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
        }
        return ["-i", this.source];
    };
    #scheduleNext = (chunkSamples, chunkIntervalMs) => {
        // Nothing left to play: ffmpeg is gone AND the queue is drained.
        if (this.#procExited && this.#queue.length === 0) {
            if (!this.#drained) {
                this.#drained = true;
                try {
                    this.onEnd?.();
                }
                catch { /* the callback must not break playback */ }
            }
            return;
        }
        if (!this.#proc && this.#queue.length === 0)
            return;
        const now = Date.now();
        if (this.#nextEmitAtMs === 0)
            this.#nextEmitAtMs = now;
        const delayMs = Math.max(0, this.#nextEmitAtMs - now);
        this.#emitTimer = setTimeout(() => {
            this.#emitTimer = null;
            // Hold the first chunks back until the buffer has depth, but only while
            // ffmpeg is still feeding us.
            if (this.#proc && this.#queue.length < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs) {
                this.#nextEmitAtMs = Date.now() + 10;
                this.#scheduleNext(chunkSamples, chunkIntervalMs);
                return;
            }
            this.#flushOne(chunkSamples);
            this.#nextEmitAtMs += chunkIntervalMs;
            this.#scheduleNext(chunkSamples, chunkIntervalMs);
        }, delayMs);
    };
    #flushOne = (chunkSamples) => {
        let nextChunk = this.#queue.shift();
        if (!nextChunk) {
            // Ran dry while ffmpeg is still producing: send silence to keep the RTP
            // stream continuous instead of stalling the encoder.
            nextChunk = new Float32Array(chunkSamples);
            this.underflowChunks += 1;
        }
        this.chunksEmitted += 1;
        this.onChunk(nextChunk);
        if (this.#proc?.stdout.isPaused() && this.#queue.length <= MAX_QUEUED_CHUNKS / 4) {
            this.#proc.stdout.resume();
        }
    };
}
