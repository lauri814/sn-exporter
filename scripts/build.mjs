import { build } from 'vite';
import { panelStyles } from './panel-styles.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

for (const browser of ['chrome', 'firefox']) {
  const outDir = `dist/${browser}`;
  await build({ configFile: false, plugins: [panelStyles()], build: {
    outDir, emptyOutDir: true,
    lib: { entry: 'src/extension/content-entry.ts', name: 'SnExporterContent', formats: ['iife'], fileName: () => 'content.js' },
  } });
  await build({ configFile: false, plugins: [panelStyles()], build: {
    outDir, emptyOutDir: false,
    lib: { entry: 'src/extension/background.ts', name: 'SnExporterBackground', formats: ['iife'], fileName: () => 'background.js' },
  } });
  const manifest = {
    manifest_version: 3,
    name: 'ServiceNow Exporter',
    version: '0.1.0',
    description: 'Export filtered ServiceNow lists in concurrent chunks using your existing session.',
    permissions: ['activeTab', 'scripting', 'webNavigation', 'storage', 'alarms', 'downloads'],
    action: { default_title: 'ServiceNow exporter' },
    ...(browser === 'firefox' ? {
      background: { scripts: ['background.js'] },
      browser_specific_settings: { gecko: {
        id: 'sn-bg-exporter@lauri814.github.io', strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      }, gecko_android: { strict_min_version: '142.0' } },
    } : { minimum_chrome_version: '120', background: { service_worker: 'background.js' } }),
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
}
