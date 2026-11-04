/**
 * @file common/utils/digest.ts
 * @description SHA-256 that does not require WebCrypto.
 *
 * `crypto.subtle` only exists in a secure context (HTTPS or localhost) and is
 * absent in WebKitGTK, so `crypto.subtle.digest(...)` throws "Cannot read
 * properties of undefined (reading 'digest')" when the app is opened over a LAN
 * HTTP origin (e.g. http://192.168.x.x:3000) or in the packaged Linux app. The
 * pure-JS fallback below computes the very same SHA-256, so digests stay stable
 * across environments.
 */

/** Any input a caller may want hashed. */
export type DigestInput = string | ArrayBuffer | ArrayBufferView;

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotateRight = (value: number, bits: number): number =>
    ((value >>> bits) | (value << (32 - bits))) >>> 0;

function toBytes(input: DigestInput): Uint8Array<ArrayBuffer> {
    if (typeof input === 'string') return new TextEncoder().encode(input);
    if (input instanceof Uint8Array && input.buffer instanceof ArrayBuffer) {
        return input as Uint8Array<ArrayBuffer>;
    }
    if (ArrayBuffer.isView(input)) {
        // Copy so WebCrypto gets a plain ArrayBuffer (never a SharedArrayBuffer view).
        const source = new Uint8Array(input.buffer as ArrayBufferLike, input.byteOffset, input.byteLength);
        const copy = new Uint8Array(input.byteLength);
        copy.set(source);
        return copy;
    }
    return new Uint8Array(input);
}

function toHex(bytes: Uint8Array): string {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function paddedMessage(message: Uint8Array): Uint8Array {
    const padded = new Uint8Array((Math.floor((message.length + 8) / 64) + 1) * 64);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = message.length * 8;
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
    view.setUint32(padded.length - 4, bitLength >>> 0);
    return padded;
}

function blockSchedule(view: DataView, offset: number): Uint32Array {
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
        const s0 = rotateRight(words[i - 15], 7) ^ rotateRight(words[i - 15], 18) ^ (words[i - 15] >>> 3);
        const s1 = rotateRight(words[i - 2], 17) ^ rotateRight(words[i - 2], 19) ^ (words[i - 2] >>> 10);
        words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    return words;
}

function compressBlock(state: Uint32Array, words: Uint32Array): void {
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
        const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + sigma1 + choose + SHA256_K[i] + words[i]) >>> 0;
        const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sigma0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) state[i] = (state[i] + next[i]) >>> 0;
}

/** Pure-JS SHA-256 usable where WebCrypto is unavailable. */
export function sha256Bytes(input: DigestInput): Uint8Array {
    const padded = paddedMessage(toBytes(input));
    const view = new DataView(padded.buffer);
    const state = SHA256_H.slice();
    for (let offset = 0; offset < padded.length; offset += 64) {
        compressBlock(state, blockSchedule(view, offset));
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, state[i]);
    return out;
}

/** SHA-256 hex digest — WebCrypto when available, pure JS otherwise. */
export async function sha256Hex(input: DigestInput): Promise<string> {
    const bytes = toBytes(input);
    const subtle = globalThis.crypto?.subtle;
    if (subtle?.digest) {
        try {
            return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
        } catch {
            // WebCrypto present but unusable (e.g. blocked by an insecure context).
        }
    }
    return toHex(sha256Bytes(bytes));
}

/** Synchronous SHA-256 hex digest (pure JS, no WebCrypto). */
export function sha256HexSync(input: DigestInput): string {
    return toHex(sha256Bytes(input));
}
