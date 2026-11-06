import type {KanbanProjectRecord} from './contracts/context';
import {requireValue} from './rules';

/** Delivery preferences are immutable inputs to each execution snapshot. */
export function validateDecisionOptions(value: Pick<KanbanProjectRecord, 'verificationLevel' | 'deliveryMode'>, kind: string): void {
    requireValue(value.verificationLevel === undefined || kind === 'decision' && ['full', 'quick', 'none'].includes(value.verificationLevel), 'INVALID_VERIFICATION_LEVEL');
    requireValue(value.deliveryMode === undefined || kind === 'decision' && ['release', 'source', 'build'].includes(value.deliveryMode), 'INVALID_DELIVERY_MODE');
    const level = value.verificationLevel ?? 'full', mode = value.deliveryMode ?? 'release';
    requireValue(level === 'none' ? mode === 'build' || mode === 'source' || mode === 'release' : mode === 'release', 'INVALID_VERIFICATION_MODE');
}
