import type {KanbanDiscoveryState} from './scan-ports';

export function discoveryState(state: {discovery?: unknown} | null | undefined): KanbanDiscoveryState | undefined {
    return state?.discovery as KanbanDiscoveryState | undefined;
}
