import type {KanbanProjectRecord} from './context';
export type KanbanVerificationMode = 'full' | 'quick' | 'release' | 'build' | 'source';
export type KanbanVerificationOptions = Pick<KanbanProjectRecord, 'verificationLevel' | 'deliveryMode'>;
const options = {
    full: {verificationLevel: 'full', deliveryMode: 'release'},
    quick: {verificationLevel: 'quick', deliveryMode: 'release'},
    release: {verificationLevel: 'none', deliveryMode: 'release'},
    build: {verificationLevel: 'none', deliveryMode: 'build'},
    source: {verificationLevel: 'none', deliveryMode: 'source'},
} as const;
/** The menu and public clients share the same supported choices. */
export function kanbanVerificationOptions(mode: string): KanbanVerificationOptions {
    if (!Object.prototype.hasOwnProperty.call(options, mode)) throw Object.assign(new Error('Invalid verification mode'), {code: 'INVALID_VERIFICATION_MODE'});
    return {...options[mode as KanbanVerificationMode]};
}
export function kanbanVerificationMode(value: KanbanVerificationOptions & Pick<KanbanProjectRecord,'deliveryOptions'>): KanbanVerificationMode {
    value=value.deliveryOptions??value;
    if (value.verificationLevel === 'full' || value.verificationLevel === 'quick') return value.verificationLevel;
    return value.deliveryMode === 'source' ? 'source' : value.deliveryMode === 'build' ? 'build' : 'release';
}

export interface KanbanRecordDelivery {boardId:string;recordId:string;revision:number;mode:KanbanVerificationMode;editable:boolean;code?:string}
