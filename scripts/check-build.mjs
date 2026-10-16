import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
for (const browser of ['chrome', 'firefox']) {
  const root = `dist/${browser}`;
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'webNavigation', 'storage', 'alarms', 'downloads']);
  assert.equal(manifest.action.default_popup, undefined, 'Toolbar must open the panel directly');
  const content = await readFile(`${root}/content.js`, 'utf8');
  assert.ok(!/^\s*(?:import|export)\s/m.test(content), 'Injected content must be a standalone bundle');
  assert.ok(content.includes('SN_EXPORT_OPEN'));
  const backgroundPath = browser === 'firefox' ? manifest.background.scripts[0] : manifest.background.service_worker;
  const background = await readFile(`${root}/${backgroundPath}`, 'utf8');
  assert.ok(background.includes('SN_EXPORT_APPLY'));
  if (browser === 'firefox') assert.ok(manifest.browser_specific_settings.gecko.id);
  console.log(`${browser}: manifest, direct toolbar action, and standalone content bundle verified`);
}
