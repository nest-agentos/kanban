import type {KanbanPresentation} from './ports';
import {boardView, catalogView, navigation, button} from './view';
import {detailView, itemEventsView, newBoardForm, newItemForm} from './forms';
import {recordLinks, recordsView, recordDetail, recordForm} from './context-view';
import {executionSessionView, executionBadge} from './session-view';
import {copyReference} from './references';

export function createRenderer(ui: KanbanPresentation) {
    const bind = <Args extends unknown[], Result>(fn: (ui: KanbanPresentation, ...args: Args) => Result) => (...args: Args): Result => fn(ui, ...args);
    return {label: ui.text.bind(ui),
        boardView: bind(boardView),
        catalogView: bind(catalogView),
        navigation: bind(navigation),
        button: bind(button),
        detailView: bind(detailView),
        itemEventsView: bind(itemEventsView),
        newBoardForm: bind(newBoardForm),
        newItemForm: bind(newItemForm),
        recordLinks: bind(recordLinks),
        recordsView: bind(recordsView),
        recordDetail: bind(recordDetail),
        recordForm: bind(recordForm),
        executionSessionView: bind(executionSessionView),
        executionBadge: bind(executionBadge),
        copyReference: bind(copyReference)
    };
}
