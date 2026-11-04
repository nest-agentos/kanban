import {expect, it} from 'vitest';
import {failureDetails} from '../src/ui/diagnostics';
it('extracts Safari and Chrome script locations without messages, origins, queries or user text', () => {
    for (const stack of [
        'TypeError: PRIVATE_MESSAGE\nrender@https://private.example/assets/index-abc.js:12:34\nPRIVATE_BODY',
        'TypeError: PRIVATE_MESSAGE\n    at render (https://private.example/assets/index-abc.js:12:34)\nPRIVATE_BODY',
    ]) {
        const error = Object.assign(new TypeError('PRIVATE_MESSAGE'), {stack});
        expect(failureDetails(error)).toEqual({errorName: 'TypeError', source: 'index-abc.js:12:34'});
        expect(JSON.stringify(failureDetails(error))).not.toMatch(/PRIVATE|private.example/);
    }
});
it('ignores arbitrary names and stacks that are not script locations', () => {
    expect(failureDetails({name: 'PRIVATE_NAME', stack: 'PRIVATE_BODY'})).toEqual({});
    expect(failureDetails(null)).toEqual({});
    expect(failureDetails(new DOMException('PRIVATE_BODY', 'SecurityError'))).toMatchObject({errorName: 'SecurityError'});
});
