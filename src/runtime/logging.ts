import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanRuntimeDiagnostic} from './ports';
export function runtimeLogger(journal: KanbanAutomationJournal) {
    const emit = (_message: string, event: KanbanRuntimeDiagnostic) => journal.diagnostic(event);
    return {info: emit, warn: emit};
}
