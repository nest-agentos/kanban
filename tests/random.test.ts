import {afterEach, expect, it, vi} from 'vitest';
import {randomUUID} from '../src/utils/random';
afterEach(()=>vi.unstubAllGlobals());
it.each(['missing','throwing'])('generates valid distinct UUID v4 values when native randomUUID is %s',mode=>{
    const getRandomValues=globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal('crypto',{getRandomValues,...(mode==='throwing'?{randomUUID:()=>{throw new Error('insecure context');}}:{})});
    const first=randomUUID(),second=randomUUID();expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);expect(second).not.toBe(first);
});
