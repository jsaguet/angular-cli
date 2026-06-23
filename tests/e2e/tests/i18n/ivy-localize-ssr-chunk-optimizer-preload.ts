import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { getGlobalVariable } from '../../utils/env';
import { writeMultipleFiles } from '../../utils/fs';
import { installWorkspacePackages, uninstallPackage } from '../../utils/packages';
import { execWithEnv, ng } from '../../utils/process';
import { updateJsonFile, useSha } from '../../utils/project';
import { setupI18nConfig } from './setup';

const LOCALES = ['en-US', 'fr', 'de'];

/**
 * Builds the project (optionally toggling chunk optimization) and, for every locale, validates that
 * each browser chunk referenced by the server manifest's preload mapping exists in that locale's
 * browser output. Returns a map of locale -> sorted referenced chunk basenames.
 */
async function collectPerLocalePreloadChunks(optimize: boolean): Promise<Record<string, string[]>> {
  await execWithEnv('ng', ['build'], {
    ...process.env,
    NG_BUILD_OPTIMIZE_CHUNKS: optimize ? '1' : 'false',
  });

  const perLocale: Record<string, string[]> = {};
  for (const lang of LOCALES) {
    const manifestPath = `dist/test-project/server/${lang}/angular-app-manifest.mjs`;
    assert.ok(existsSync(manifestPath), `Server manifest missing for locale '${lang}'.`);
    const manifest = readFileSync(manifestPath, 'utf-8');

    // Every `.js` reference in the manifest is a browser chunk listed in the preload mapping
    // (the bootstrap and server assets use `.mjs`). Each must resolve to an emitted browser file.
    const referenced = Array.from(manifest.matchAll(/"([^"]+\.js)"/g), (m) => basename(m[1]));
    assert.ok(
      referenced.length > 0,
      `Locale '${lang}' manifest has no browser chunk preload references; ` +
        `expected lazy-route mappings to be present.`,
    );

    const browserDir = `dist/test-project/browser/${lang}`;
    assert.ok(existsSync(browserDir), `Browser output missing for locale '${lang}'.`);
    const emitted = new Set(readdirSync(browserDir));

    for (const chunk of referenced) {
      assert.ok(
        emitted.has(chunk),
        `Locale '${lang}': preload mapping references '${chunk}', which does not exist in ` +
          `'${browserDir}'${optimize ? ' after chunk optimization + i18n inlining' : ''}.`,
      );
    }

    perLocale[lang] = [...new Set(referenced)].sort();
  }

  return perLocale;
}

/**
 * Localized SSR builds run chunk optimization BEFORE i18n inlining, then `inlineI18n` calls the
 * same post-bundle pipeline per locale and relocates the output into a per-locale subdirectory.
 * This test guards that interaction: every browser chunk referenced by a locale's server manifest
 * preload mapping (`entryPointToBrowserMapping`) must still exist in that locale's browser output,
 * i.e. optimization's renaming did not leave the per-locale preloads pointing at missing files.
 */
export default async function () {
  // The `application` builder (esbuild) is the only one with chunk optimization.
  if (!getGlobalVariable('argv')['esbuild']) {
    return;
  }

  await setupI18nConfig();

  await updateJsonFile('angular.json', (workspaceJson) => {
    const i18n = workspaceJson.projects['test-project'].i18n;
    i18n.sourceLocale = { baseHref: '' };
    i18n.locales['fr'] = { translation: i18n.locales['fr'], baseHref: '' };
    i18n.locales['de'] = { translation: i18n.locales['de'], baseHref: '' };
  });

  // Add enough lazy routes to cross the chunk-optimization threshold (default 3).
  const routes = [
    { path: 'alpha', cls: 'Alpha' },
    { path: 'bravo', cls: 'Bravo' },
    { path: 'charlie', cls: 'Charlie' },
    { path: 'delta', cls: 'Delta' },
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
  };
  for (const r of routes) {
    files[`src/app/${r.path}.ts`] = `
      import { Component } from '@angular/core';

      @Component({ selector: 'app-${r.path}', template: '${r.path} works' })
      export class ${r.cls} {}
    `;
  }
  await writeMultipleFiles(files);

  await uninstallPackage('@angular/ssr');
  await ng('add', '@angular/ssr', '--skip-confirmation', '--skip-install');
  await useSha();
  await installWorkspacePackages();

  // Baseline without optimization (control), then the optimized build (subject). Both must keep
  // every per-locale preload reference resolvable.
  const unoptimized = await collectPerLocalePreloadChunks(false);
  const optimized = await collectPerLocalePreloadChunks(true);

  // Guard against a vacuous pass: optimization must actually have processed the route chunks
  // (renaming changes their file names). If nothing changed, the check above proved nothing.
  assert.notDeepEqual(
    optimized,
    unoptimized,
    'Optimized and unoptimized preload references are identical; chunk optimization did not run, ' +
      'so the i18n preload checks were not exercised under optimization.',
  );
}
