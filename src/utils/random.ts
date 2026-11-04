/**
 * @file common/utils/random.ts
 * @description UUID v4 that also works outside a secure context.
 *
 * `crypto.randomUUID()` is secure-context-only: it is undefined over plain-HTTP
 * LAN origins (e.g. http://192.168.x.x:3000) and in WebKitGTK, so calling it
 * directly throws "crypto.randomUUID is not a function". `crypto.getRandomValues()`
 * stays available everywhere, so it backs the fallback below.
 */

/** UUID v4 — native WebCrypto when available, `getRandomValues` otherwise. */
export function randomUUID(): string {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.randomUUID === 'function') {
        try {
            return webCrypto.randomUUID();
        } catch {
            // Present but unusable (insecure context) — fall through.
        }
    }
    return formatV4(randomBytes(16));
}

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
        return bytes;
    }
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
}

function formatV4(bytes: Uint8Array): string {
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
