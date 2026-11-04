/** Keep browser failure diagnostics useful without logging messages or user content. */
export function failureDetails(error: unknown): {errorName?: string; source?: string} {
    if (!error || typeof error !== 'object') return {};
    const value = error as {name?: unknown; stack?: unknown};
    const known = /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|SecurityError|QuotaExceededError|NotSupportedError|InvalidStateError|DataCloneError|AbortError|NetworkError)$/;
    const errorName = typeof value.name === 'string' && known.test(value.name) ? value.name : undefined;
    const frame = typeof value.stack === 'string' ? value.stack.match(/(?:^|\/)([A-Za-z0-9_.-]+\.m?js):(\d+):(\d+)/m) : null;
    return {...(errorName ? {errorName} : {}), ...(frame ? {source: `${frame[1]}:${frame[2]}:${frame[3]}`} : {})};
}
