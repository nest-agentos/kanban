import type {KanbanExternalReference, KanbanPrincipal} from './configuration';

export interface KanbanAutomationSettings {
    preparation?: KanbanExternalReference;
    preparationOptions?: Record<string, string>;
    enabled: boolean; planner: KanbanExternalReference; executor: KanbanExternalReference;
    coordinator: KanbanPrincipal; worker: KanbanPrincipal; autoAccept: boolean;
}
export interface KanbanAutomationOption {
    name: string; label: string; defaultValue?: string;
    choices?: Array<{value: string; label: string}>;
}
export interface KanbanAutomationTarget {reference: KanbanExternalReference; label: string; options?: KanbanAutomationOption[]}
export interface KanbanAutomationCatalog {
    preparations?: KanbanAutomationTarget[];
    targets: KanbanAutomationTarget[]; coordinator: KanbanPrincipal; worker: KanbanPrincipal;
}
export interface KanbanAnalysisStatus {
    itemId: string; state: 'analyzing' | 'ready' | 'clarification' | 'failed' | 'unknown';
    reason?: string; code?: string; dependencies?: string[];
    recovery?: {attempt: number; limit: number; retryAt: number; code: string};
}
export function sameAutomationBinding(left?: KanbanAutomationSettings, right?: KanbanAutomationSettings): boolean {
    const signature = (value?: KanbanAutomationSettings) => JSON.stringify([value?.planner?.system, value?.planner?.id, value?.planner?.revision,
        value?.executor?.system, value?.executor?.id, value?.executor?.revision, value?.coordinator?.kind, value?.coordinator?.id,
        value?.worker?.kind, value?.worker?.id, value?.autoAccept, value?.preparation, Object.entries(value?.preparationOptions ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
    return signature(left) === signature(right);
}
