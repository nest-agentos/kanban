import {defineConfig} from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'runtime/index': 'src/runtime/index.ts',
        'runtime/integration': 'src/runtime/integration.ts',
        'contracts/index': 'src/contracts/index.ts',
        activity: 'src/activity.ts',
        storage: 'src/storage.ts',
        execution: 'src/execution.ts',
        discovery: 'src/discovery-entry.ts',
    },
    format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true, splitting: true,
});
