import type {KanbanDispatch} from './contracts';

type Observation = Pick<KanbanDispatch, 'outcome' | 'code' | 'outputs' | 'executionSessionId' | 'controlCapabilities'>;
/** A lease renewal is operational state, separate from observable execution changes. */
export function executionObservationChanged(current: Observation, next: Observation): boolean {
    return current.outcome !== next.outcome || current.code !== next.code
        || JSON.stringify(current.outputs ?? []) !== JSON.stringify(next.outputs ?? [])
        || next.executionSessionId !== undefined && current.executionSessionId !== next.executionSessionId
        || next.controlCapabilities !== undefined && JSON.stringify(current.controlCapabilities) !== JSON.stringify(next.controlCapabilities);
}
