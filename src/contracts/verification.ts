import type {KanbanProjectRecord} from './context';
export type KanbanVerificationMode = 'full' | 'quick' | 'build' | 'source';
export type KanbanVerificationOptions = Pick<KanbanProjectRecord, 'verificationLevel' | 'deliveryMode'>;
const options = {
    full: {verificationLevel: 'full', deliveryMode: 'release'},
    quick: {verificationLevel: 'quick', deliveryMode: 'release'},
    build: {verificationLevel: 'none', deliveryMode: 'build'},
    source: {verificationLevel: 'none', deliveryMode: 'source'},
} as const;
/** The menu and public clients share the same four supported choices. */
export function kanbanVerificationOptions(mode: string): KanbanVerificationOptions {
    if (!Object.prototype.hasOwnProperty.call(options, mode)) throw Object.assign(new Error('Invalid verification mode'), {code: 'INVALID_VERIFICATION_MODE'});
    return {...options[mode as KanbanVerificationMode]};
}
export function kanbanVerificationMode(value: KanbanVerificationOptions): KanbanVerificationMode {
    if (value.verificationLevel !== 'none') return value.verificationLevel ?? 'full';
    return value.deliveryMode === 'source' ? 'source' : 'build';
}
