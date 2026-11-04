import type {KanbanClient} from './contracts';

/** Host supplies its scheduler; disposal prevents new scans and awaits in-flight work. */
export function startKanbanMonitor(options: {
    service: Pick<KanbanClient, 'scan'>;
    subscribeTick: (tick: () => void) => () => void;
    onError: (error: unknown) => void | Promise<void>;
    onSuccess?: () => void | Promise<void>;
    subscribeChanges?: (tick: () => void) => () => void;
    initialScan?: boolean;
}): { dispose(): Promise<void> } {
    let stopped = false, pending: Promise<void> | undefined;
    const tick = () => {
        if (stopped || pending) return;
        pending = Promise.resolve().then(() => stopped ? undefined : options.service.scan()).then(()=>stopped ? undefined : options.onSuccess?.()).catch(async error => {
            if (stopped) return;
            try { await options.onError(error); } catch { /* Reporting must not leave an unhandled rejection. */ }
        }).finally(() => { pending = undefined; });
    };
    const unsubscribe = options.subscribeTick(tick), unwatch = options.subscribeChanges?.(tick);
    if (options.initialScan !== false) tick();
    return { async dispose() {
        if (stopped) { await pending; return; }
        stopped = true; try { unsubscribe(); unwatch?.(); } finally { await pending; }
    } };
}
