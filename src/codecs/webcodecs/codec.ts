import type { CodecLifetime } from '../shared/codec-lifetime';
import { yieldEventLoop } from '../../core/io/event-loop';
import { MediaForgeError, errorMessage } from '../../core/errors/errors';

type HostCodec = AudioDecoder | AudioEncoder | VideoDecoder | VideoEncoder;

/** A view of a WebCodecs buffer source; the caller must not keep it past the source's lifetime. */
export function bufferView(source: AllowSharedBufferSource): Uint8Array {
    return ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source as ArrayBufferLike);
}

/**
 * An owned copy of a WebCodecs buffer source, such as a decoder configuration record the host
 * reported.
 */
export function bufferCopy(source: AllowSharedBufferSource): Uint8Array {
    return bufferView(source).slice();
}

/**
 * Seconds as the integer microseconds of WebCodecs timestamps; fails with FORMAT outside the safe
 * range.
 */
export function micros(seconds: number): number {
    const value = Math.round(seconds * 1e6);
    if (!Number.isSafeInteger(value))
        throw new MediaForgeError('Media timing exceeds the safe microsecond range', 'FORMAT');
    return value;
}

/**
 * A host codec failure as a MediaForgeError of `code`; library errors and aborts keep their
 * identity.
 */
export function codecError(error: unknown, code: 'DECODE' | 'ENCODE', context: string): Error {
    if (
        error instanceof MediaForgeError ||
        (error instanceof DOMException && error.name === 'AbortError')
    )
        return error;
    return new MediaForgeError(`${context}: ${errorMessage(error)}`, code);
}

/**
 * A codec failure another encoder or decoder may take over from; I/O, format and abort errors are
 * final.
 */
export function isCodecFailure(error: unknown): error is MediaForgeError {
    return error instanceof MediaForgeError && (error.code === 'ENCODE' || error.code === 'DECODE');
}

/** Closes a host codec that is still open; a failing close does not hide the caller's outcome. */
export function closeCodec(codec: HostCodec | undefined | null): void {
    if (!codec || (codec.state as string) === 'closed') return;
    try {
        codec.close();
    } catch {}
}

/**
 * Waits for a codec queue to shrink. The codec's dequeue event wakes the waiter; hosts without the
 * event are polled once per task. `wake()` releases a waiter so it can re-check after a codec
 * error.
 */
export class QueueGate {
    private waiter: (() => void) | undefined;
    private readonly evented: boolean;

    constructor(private readonly codec: HostCodec) {
        this.evented = 'ondequeue' in codec && typeof codec.addEventListener === 'function';
        if (this.evented) codec.addEventListener('dequeue', this.wake);
    }

    readonly wake = (): void => {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.();
    };

    async until(ready: () => boolean, lifetime: CodecLifetime): Promise<void> {
        while (!ready()) {
            await lifetime.waitFor(
                this.evented
                    ? new Promise<void>(resolve => {
                          this.waiter = resolve;
                      })
                    : yieldEventLoop(),
            );
        }
    }

    dispose(): void {
        if (this.evented) this.codec.removeEventListener('dequeue', this.wake);
        this.wake();
    }
}
