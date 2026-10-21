import { MediaForgeError } from '../../core/errors/errors';

/** HLS AES-128: whole segments in CBC mode with PKCS#7 padding, one key for the presentation. */
export interface HlsEncryptionOptions {
    readonly method: 'AES-128';
    /** 16 key bytes. */
    readonly key: Uint8Array;
    /** Written to EXT-X-KEY as the address clients fetch the key from. */
    readonly keyUri: string;
    /**
     * sequence (default) derives each IV from the segment's media sequence number; a fixed IV is 16
     * bytes.
     */
    readonly iv?: 'sequence' | Uint8Array;
    /**
     * When set, the key bytes are emitted as a package file of this name for a server to publish.
     */
    readonly keyFile?: string;
}

export interface ResolvedHlsEncryption {
    readonly key: Uint8Array;
    readonly keyUri: string;
    readonly iv?: Uint8Array;
    readonly keyFile?: string;
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function resolveHlsEncryption(options: HlsEncryptionOptions): ResolvedHlsEncryption {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('Expected encryption options', 'INPUT');
    if (options.method !== 'AES-128')
        throw new MediaForgeError('encryption.method must be AES-128', 'INPUT');
    if (!(options.key instanceof Uint8Array) || options.key.length !== 16)
        throw new MediaForgeError('encryption.key must be 16 bytes', 'INPUT');
    if (typeof options.keyUri !== 'string' || !options.keyUri || /["\r\n\x00]/.test(options.keyUri))
        throw new MediaForgeError(
            'encryption.keyUri must be a string without quotes or control characters',
            'INPUT',
        );
    let iv: Uint8Array | undefined;
    if (options.iv !== undefined && options.iv !== 'sequence') {
        if (!(options.iv instanceof Uint8Array) || options.iv.length !== 16)
            throw new MediaForgeError("encryption.iv must be 'sequence' or 16 bytes", 'INPUT');
        iv = options.iv.slice();
    }

    if (
        options.keyFile !== undefined &&
        (typeof options.keyFile !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(options.keyFile))
    )
        throw new MediaForgeError('encryption.keyFile must be a plain file name', 'INPUT');
    return { key: options.key.slice(), keyUri: options.keyUri, iv, keyFile: options.keyFile };
}

/** The 16-byte IV clients derive when EXT-X-KEY has none: the media sequence number, big-endian. */
export function sequenceIv(sequence: number): Uint8Array {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, sequence >>> 0);
    new DataView(iv.buffer).setUint32(8, Math.floor(sequence / 2 ** 32) >>> 0);
    return iv;
}

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(bytes);
}

function subtle(): SubtleCrypto {
    const api = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (!api) throw new MediaForgeError('AES-128 packaging needs WebCrypto', 'OUTPUT');
    return api;
}

/** EXT-X-KEY attribute text for the resolved options. */
export function hlsKeyTag(encryption: ResolvedHlsEncryption): string {
    const attributes = ['METHOD=AES-128', `URI="${encryption.keyUri}"`];
    if (encryption.iv) attributes.push(`IV=0x${hex(encryption.iv)}`);
    return `#EXT-X-KEY:${attributes.join(',')}`;
}

export class HlsSegmentEncryptor {
    private keyHandle?: Promise<CryptoKey>;

    constructor(readonly encryption: ResolvedHlsEncryption) {}

    private key(): Promise<CryptoKey> {
        this.keyHandle ??= subtle().importKey(
            'raw',
            owned(this.encryption.key),
            { name: 'AES-CBC' },
            false,
            ['encrypt'],
        );
        return this.keyHandle;
    }

    async encrypt(data: Uint8Array, sequence: number): Promise<Uint8Array> {
        const iv = owned(this.encryption.iv ?? sequenceIv(sequence));
        const key = await this.key();
        return new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, key, owned(data)));
    }
}
