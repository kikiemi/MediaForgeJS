import { awaitWithAbort } from '../../core/io/abort';
import { errorMessage } from '../../core/errors/errors';
import { bufferView } from './codec';

/** A WebCodecs interface of the host. */
export type HostCodecKind = 'AudioDecoder' | 'AudioEncoder' | 'VideoDecoder' | 'VideoEncoder';

/** The chunk or frame class a codec needs next to it before the host counts as able to run it. */
const COMPANIONS: Readonly<Record<HostCodecKind, string>> = {
    AudioDecoder: 'EncodedAudioChunk',
    AudioEncoder: 'AudioData',
    VideoDecoder: 'EncodedVideoChunk',
    VideoEncoder: 'VideoFrame',
};

/**
 * A host's answer for one configuration; `error` holds the message of a rejected (invalid)
 * configuration.
 */
interface HostCodecSupport {
    readonly available: boolean;
    readonly supported: boolean;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly error?: string;
}

type SupportQuery = (
    config: unknown,
) => Promise<{ supported?: boolean; config?: Record<string, unknown> }>;

const answers = new WeakMap<SupportQuery, Map<string, Promise<HostCodecSupport>>>();

function keyOf(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || isSharedBuffer(value)) {
        let hex = 'bytes:';
        for (const byte of bufferView(value as AllowSharedBufferSource))
            hex += byte.toString(16).padStart(2, '0');
        return hex;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .filter(key => record[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${keyOf(record[key])}`)
        .join(',')}}`;
}

function isSharedBuffer(value: object): boolean {
    return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
}

function hostClass(kind: HostCodecKind): { isConfigSupported?: SupportQuery } | undefined {
    const host = (globalThis as Record<string, unknown>)[kind];
    return typeof host === 'function' ? (host as { isConfigSupported?: SupportQuery }) : undefined;
}

/**
 * True when the host defines the codec class, its support query and the chunk or frame class it
 * consumes.
 */
export function hostCodecAvailable(kind: HostCodecKind): boolean {
    return (
        typeof hostClass(kind)?.isConfigSupported === 'function' &&
        typeof (globalThis as Record<string, unknown>)[COMPANIONS[kind]] === 'function'
    );
}

/**
 * The host's isConfigSupported answer, asked once per normalized configuration and support
 * function, so a replaced codec class or support function asks again. A rejected or throwing query
 * reads as unsupported with its message.
 */
export function queryHostCodec(kind: HostCodecKind, config: object): Promise<HostCodecSupport> {
    const host = hostClass(kind);
    const query = host?.isConfigSupported;
    if (typeof query !== 'function') return Promise.resolve({ available: false, supported: false });
    let cached = answers.get(query);
    if (!cached) answers.set(query, (cached = new Map()));
    const key = keyOf(config);
    let answer = cached.get(key);
    if (!answer) {
        answer = Promise.resolve()
            .then(() => Reflect.apply(query, host, [config]) as ReturnType<SupportQuery>)
            .then(
                result => ({
                    available: true,
                    supported: result?.supported === true,
                    config: result?.config,
                }),
                error => ({ available: true, supported: false, error: errorMessage(error) }),
            );
        cached.set(key, answer);
    }

    return answer;
}

/** Whether the host can run `config`, including the chunk or frame class the codec consumes. */
export async function hostSupports(
    kind: HostCodecKind,
    config: object,
    signal?: AbortSignal,
): Promise<boolean> {
    if (!hostCodecAvailable(kind)) return false;
    return (await awaitWithAbort(queryHostCodec(kind, config), signal)).supported;
}
