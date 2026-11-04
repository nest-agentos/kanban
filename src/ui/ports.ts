import type {KanbanClient, KanbanExternalReference, KanbanBoardSummary, KanbanItem} from '../contracts';
import type {ContentTitleBarParts} from '@nestos/ui-common';
export interface KanbanPresentation {
    text(key: string, values?: Record<string, string | number>): string;
    icons: {refreshView: string; more: string; close: string; back?: string; copy?: string; run?: string; pause?: string; resume?: string; fix?: string; edit?: string};
    log?(event: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; count?: number; errorName?: string; source?: string; durationMs: number}): void;
    referenceUrl?(path: string): string;
}
export interface KanbanReviewGuidance {title: string; paragraphs: string[]}
export interface KanbanUIOptions {
    itemOperationsAvailable?(board: KanbanBoardSummary, item: KanbanItem): boolean;
    reviewGuidance?(board: KanbanBoardSummary, item: KanbanItem): KanbanReviewGuidance | undefined;
    service?: KanbanClient;
    /** Omit when the host owns shared workspace navigation. */
    sidebar?: HTMLElement;
    editor: HTMLElement;
    presentation: KanbanPresentation;
    selected(path: string): void;
    openSession(id: string): Promise<void>;
    sessionUrl?(id: string): string;
    referenceLink?(reference: KanbanExternalReference): Promise<{href: string; label: string; sessionId?: string} | undefined>;
    activated?(): void;
    mountNavigation?(container: HTMLElement): () => void;
    mountWindowList?(container: HTMLElement): () => void;
    mountTitleBar?(container: HTMLElement, parts: ContentTitleBarParts): () => void;
    initialResource?: string;
    navigate?(path: string): Promise<void>;
    changed?(): void;
    committed?(): void;
    executionReference?(sessionId: string, bindingId: string): KanbanExternalReference;
}
