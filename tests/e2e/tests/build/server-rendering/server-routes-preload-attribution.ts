import assert from 'node:assert';
import { writeMultipleFiles } from '../../../utils/fs';
import { execAndWaitForOutputToMatch, execWithEnv, ng } from '../../../utils/process';
import { installWorkspacePackages, uninstallPackage } from '../../../utils/packages';
import { useSha } from '../../../utils/project';
import { getGlobalVariable } from '../../../utils/env';
import { findFreePort } from '../../../utils/network';

/**
 * Verifies per-route `modulepreload` *attribution* under chunk optimization.
 *
 * The server engine injects `<link rel="modulepreload">` for the lazy chunk(s) backing the
 * matched route, derived from the build's `entryPointToBrowserMapping` (keyed by the metafile
 * `entryPoint`). Chunk optimization renames and MERGES small lazy chunks; if a route's chunk is
 * merged into a sibling's, only one `entryPoint` survives the metafile reconstruction and the
 * other route can silently lose its preload. A 200/resolves check cannot see this — only a check
 * that each route actually preloads ITS OWN component's code can.
 *
 * Each lazy component embeds a unique marker string. For every route we fetch the SSR response,
 * collect its preload links, download those chunks, and assert the route's own marker is present.
 */
export default async function () {
  assert(
    getGlobalVariable('argv')['esbuild'],
    'This test should not be called in the Webpack suite.',
  );

  await uninstallPackage('@angular/ssr');
  await ng('add', '@angular/ssr', '--skip-confirmation', '--skip-install');
  await useSha();
  await installWorkspacePackages();

  // Six tiny, dependency-free lazy routes. Small sibling chunks like these are exactly what the
  // optimizer merges, which is the condition that can break per-route preload attribution.
  const routes = [
    { path: 'alpha', cls: 'Alpha', marker: 'MARKER_ALPHA_8f3a1c' },
    { path: 'bravo', cls: 'Bravo', marker: 'MARKER_BRAVO_2d9e4b' },
    { path: 'charlie', cls: 'Charlie', marker: 'MARKER_CHARLIE_7a1f6d' },
    { path: 'delta', cls: 'Delta', marker: 'MARKER_DELTA_5c8b2e' },
    { path: 'echo', cls: 'Echo', marker: 'MARKER_ECHO_3f7d9a' },
    { path: 'foxtrot', cls: 'Foxtrot', marker: 'MARKER_FOXTROT_6b4e1c' },
  ];

  const files: Record<string, string> = {
    'src/app/app.routes.ts': `
      import { Routes } from '@angular/router';

      export const routes: Routes = [
        ${routes
          .map(
            (r) =>
              `{ path: '${r.path}', loadComponent: () => import('./${r.path}').then(m => m.${r.cls}) }`,
          )
          .join(',\n        ')}
      ];
    `,
    'src/app/app.routes.server.ts': `
      import { RenderMode, ServerRoute } from '@angular/ssr';

      export const serverRoutes: ServerRoute[] = [
        { path: '**', renderMode: RenderMode.Server },
      ];
    `,
  };

  for (const r of routes) {
    files[`src/app/${r.path}.ts`] = `
      import { Component } from '@angular/core';

      @Component({
        selector: 'app-${r.path}',
        template: '<p>${r.marker}</p>',
      })
      export class ${r.cls} {}
    `;
  }

  await writeMultipleFiles(files);

  // Baseline: WITHOUT chunk optimization, attribution must hold (control for the assertion).
  await execWithEnv('ng', ['build', '--output-mode=server'], {
    ...process.env,
    NG_BUILD_OPTIMIZE_CHUNKS: 'false',
  });
  const unoptimizedPreloads = await assertEachRoutePreloadsOwnComponent(
    await spawnServer(),
    routes,
  );

  // Subject: WITH chunk optimization (default). Merging must not misattribute preloads.
  await ng('build', '--output-mode=server');
  const optimizedPreloads = await assertEachRoutePreloadsOwnComponent(await spawnServer(), routes);

  // Guard against a vacuous pass: the optimizer must actually have processed the route chunks
  // (renaming/merging changes their file names). If the preload sets are identical, optimization
  // did not run on these chunks and the attribution check above proved nothing.
  assert.notDeepEqual(
    optimizedPreloads,
    unoptimizedPreloads,
    'Optimized and unoptimized preload sets are identical; chunk optimization did not run on the ' +
      'route chunks, so the attribution assertions were not actually exercised under optimization.',
  );
}

/**
 * Asserts every route preloads its own component's chunk and returns the sorted, deduplicated set
 * of all preload hrefs seen across the routes (used to confirm optimization actually ran).
 */
async function assertEachRoutePreloadsOwnComponent(
  port: number,
  routes: { path: string; marker: string }[],
): Promise<string[]> {
  const allHrefs = new Set<string>();

  for (const { path, marker } of routes) {
    const res = await fetch(`http://localhost:${port}/${path}`);
    const html = await res.text();

    const hrefs = Array.from(
      html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g),
      (m) => m[1],
    );

    assert(
      hrefs.length > 0,
      `Route '/${path}' emitted no modulepreload links; its lazy chunk preload was dropped.`,
    );

    // Download every preloaded chunk for this route and confirm the route's own component code
    // (its unique marker) is actually among what gets preloaded.
    let preloadedContent = '';
    for (const href of hrefs) {
      allHrefs.add(href);
      const chunkRes = await fetch(`http://localhost:${port}/${href}`);
      assert.equal(
        chunkRes.status,
        200,
        `Preloaded chunk '${href}' for '/${path}' should resolve, got ${chunkRes.status}.`,
      );
      preloadedContent += await chunkRes.text();
    }

    assert(
      preloadedContent.includes(marker),
      `Route '/${path}' does not preload its own component chunk ` +
        `(marker '${marker}' absent from its ${hrefs.length} preloaded chunk(s)).`,
    );
  }

  return [...allHrefs].sort();
}

async function spawnServer(): Promise<number> {
  const port = await findFreePort();
  await execAndWaitForOutputToMatch(
    'npm',
    ['run', 'serve:ssr:test-project'],
    /Node Express server listening on/,
    {
      ...process.env,
      'PORT': String(port),
      'NG_ALLOWED_HOSTS': 'localhost',
    },
  );

  return port;
}
