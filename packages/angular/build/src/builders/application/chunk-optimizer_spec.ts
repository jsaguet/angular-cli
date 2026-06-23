/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import type { Metafile } from 'esbuild';
import { BundleContextResult } from '../../tools/esbuild/bundler-context';
import {
  BuildOutputFile,
  BuildOutputFileType,
  InitialFileRecord,
  createOutputFile,
} from '../../tools/esbuild/bundler-files';
import { optimizeChunks } from './chunk-optimizer';

/**
 * Builds a synthetic esbuild-style browser bundle result with a browser `main`
 * entry point that dynamically imports a number of lazy-route chunks. Each lazy
 * chunk carries an `entryPoint` pointing at its (fake) source file, mirroring how
 * esbuild records lazy route outputs.
 */
function createBrowserResult(lazyEntryPoints: string[]): BundleContextResult {
  const mainFile = 'main-MAINMAIN.js';

  const outputFiles: BuildOutputFile[] = [];
  const initialFiles = new Map<string, InitialFileRecord>();
  const outputs: Metafile['outputs'] = {};
  const inputs: Metafile['inputs'] = {};

  // Lazy chunks, each reachable only via a dynamic import from main.
  const lazyChunkPaths: string[] = [];
  lazyEntryPoints.forEach((entryPoint, index) => {
    const chunkPath = `chunk-LAZY000${index}.js`;
    lazyChunkPaths.push(chunkPath);

    outputFiles.push(
      createOutputFile(
        chunkPath,
        `export const route${index} = ${index};\n`,
        BuildOutputFileType.Browser,
      ),
    );

    inputs[entryPoint] = { bytes: 32, imports: [] };
    outputs[chunkPath] = {
      bytes: 32,
      inputs: { [entryPoint]: { bytesInOutput: 32 } },
      imports: [],
      exports: [`route${index}`],
      entryPoint,
    };
  });

  // Browser main entry point that dynamically imports every lazy chunk.
  const mainImports = lazyChunkPaths
    .map((p, i) => `export const load${i} = () => import('./${p}');\n`)
    .join('');
  outputFiles.push(createOutputFile(mainFile, mainImports, BuildOutputFileType.Browser));

  inputs['src/main.ts'] = { bytes: mainImports.length, imports: [] };
  outputs[mainFile] = {
    bytes: mainImports.length,
    inputs: { 'src/main.ts': { bytesInOutput: mainImports.length } },
    imports: [],
    dynamicImports: lazyChunkPaths,
    exports: lazyChunkPaths.map((_, i) => `load${i}`),
    entryPoint: 'src/main.ts',
  } as Metafile['outputs'][string];

  initialFiles.set(mainFile, {
    name: 'main',
    type: 'script',
    entrypoint: true,
    external: false,
    serverFile: false,
    depth: 0,
  });

  return {
    errors: undefined,
    warnings: [],
    metafile: { inputs, outputs },
    outputFiles,
    initialFiles,
    externalImports: {},
  };
}

/** Maps each lazy route source `entryPoint` to the output chunk file that carries it. */
function entryPointToChunk(result: BundleContextResult): Record<string, string> {
  if (result.errors) {
    throw new Error('Optimization failed.');
  }

  const mapping: Record<string, string> = {};
  for (const [fileName, output] of Object.entries(result.metafile.outputs)) {
    if (output.entryPoint && fileName.endsWith('.js')) {
      mapping[output.entryPoint] = fileName;
    }
  }

  return mapping;
}

describe('optimizeChunks', () => {
  it('preserves the entryPoint -> emitted chunk mapping used for SSR preloading', async () => {
    const lazyEntryPoints = [
      'src/app/a.component.ts',
      'src/app/b.component.ts',
      'src/app/c.component.ts',
    ];
    const result = await optimizeChunks(createBrowserResult(lazyEntryPoints), false);

    expect(result.errors).toBeUndefined();
    if (result.errors) {
      return;
    }

    const emittedFiles = new Set(result.outputFiles.map((f) => f.path));
    const mapping = entryPointToChunk(result);

    for (const entryPoint of lazyEntryPoints) {
      // Each lazy route must still resolve to a chunk in the metafile...
      const chunk = mapping[entryPoint];
      expect(chunk)
        .withContext(`entryPoint "${entryPoint}" should map to an output chunk`)
        .toBeDefined();

      // ...and that chunk must actually be emitted, otherwise the preload 404s.
      expect(emittedFiles.has(chunk))
        .withContext(`preloaded chunk "${chunk}" for "${entryPoint}" should be emitted`)
        .toBeTrue();
    }
  });
});
