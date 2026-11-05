// Real-app UI harness: launches the PACKAGED Electron app (release/linux-unpacked) under Xvfb
// with an isolated user-data dir and drives it through Chromium's DevTools protocol.
// Usage: node e2e/run.cjs   (build first: npm run build && npx electron-builder --linux dir)
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright-core');

const APP = path.join(__dirname, '..', 'release', 'linux-unpacked', 'local-pos');
let port = 9400;

async function launch(userDataDir) {
  const p = port++;
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', APP, '--no-sandbox', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${p}`],
    { detached: true, stdio: 'ignore' });
  let browser;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`); break; } catch { /* retry */ }
  }
  if (!browser) throw new Error('app did not start');
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts()[0]?.pages().find((x) => x.url().startsWith('file://'));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.waitForLoadState('domcontentloaded');
  return {
    page,
    userDataDir,
    // simulate a crash: SIGKILL the whole process group (no graceful shutdown)
    kill() { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } },
    async close() { try { await browser.close(); } catch { /* */ } this.kill(); await new Promise((r) => setTimeout(r, 800)); },
  };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-e2e-')); }
module.exports = { launch, tmpDir };
