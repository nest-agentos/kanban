import type {KanbanBoard, KanbanItem} from './contracts';

export interface KanbanBoardControl {
    mode: 'automatic' | 'manual'; paused: boolean;
    controls: Record<string, string>;
}
/** Manual mode still honors an explicit per-task run request. */
export function boardAllowsStart(board: Pick<KanbanBoard, 'executionControl'>, item?: Pick<KanbanItem, 'launch'>): boolean {
    return !board.executionControl?.paused && (board.executionControl?.mode !== 'manual' || item?.launch?.requestedAt !== undefined);
}
export function boardControlPhase(board: Pick<KanbanBoard, 'executionControl'> & {items: Array<Pick<KanbanItem, 'id' | 'status' | 'control'>>}): 'automatic' | 'manual' | 'pausing' | 'paused' | 'resuming' | 'error' {
    const policy = board.executionControl;
    const controls = Object.entries(policy?.controls ?? {}).flatMap(([id, controlId]) => {
        const item = board.items.find(item => item.id === id);
        return item && !['completed', 'cancelled', 'review'].includes(item.status) && item.control?.id === controlId ? [item.control] : [];
    });
    if (controls.some(control => control?.state === 'failed' || control?.state === 'unknown')) return 'error';
    if (controls.some(control => control?.state === 'requested' || control?.state === 'accepted')) return policy?.paused ? 'pausing' : 'resuming';
    return policy?.paused ? 'paused' : policy?.mode ?? 'automatic';
}
