import {defineConfig} from 'tsup';
import {mkdir, copyFile} from 'node:fs/promises';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'contracts/index': 'src/contracts/index.ts',
        activity: 'src/activity.ts',
        storage: 'src/storage.ts',
        execution: 'src/execution.ts',
        discovery: 'src/discovery-entry.ts',
        'ui/index': 'src/ui/index.ts',
    },
    format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true, splitting: true,
    onSuccess: async () => {
        await mkdir('dist/ui', {recursive: true});
        await copyFile('src/ui/kanban.css', 'dist/ui/kanban.css');
    },
});
