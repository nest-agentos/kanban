import path from 'node:path';
import {defineConfig} from 'vite';
import {workspaceAliases,workspaceExcludes} from '../../../../scripts/workspace-sources.mjs';
export default defineConfig({resolve:{alias:workspaceAliases(path.resolve(import.meta.dirname,'../../../../apps/web-app'))},optimizeDeps:{exclude:workspaceExcludes()}});
