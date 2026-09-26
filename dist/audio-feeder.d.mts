export declare class AudioFeeder {
    #private;
    private readonly sampleRate;
    private readonly channels;
    private readonly framesPerChunk;
    private readonly onChunk;
    private readonly source;
    /** Called once, when the source has been fully played out. */
    private readonly onEnd;
    droppedChunks: number;
    underflowChunks: number;
    bytesProduced: number;
    chunksEmitted: number;
    constructor(sampleRate: number, channels: number, framesPerChunk: number, onChunk: (chunk: Float32Array) => void, source?: string, 
    /** Called once, when the source has been fully played out. */
    onEnd?: (() => void) | null);
    start: () => void;
    stop: () => void;
}
