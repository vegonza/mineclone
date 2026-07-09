/**
 * Shared headless-browser harness: serves the production build, boots the game
 * in Chromium (SwiftShader) and waits for the world to finish streaming.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/brave',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const path = CHROME_PATHS.find((p) => existsSync(p));
  if (!path) throw new Error(`No Chromium binary found. Tried:\n  ${CHROME_PATHS.join('\n  ')}`);
  return path;
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('preview server never came up');
}

/**
 * Boots everything and hands back `{ page, errors, close }`.
 * `errors` collects genuine page errors (SwiftShader chatter is filtered out).
 */
export async function boot({ port = 4178, width = 1280, height = 720, seed = 1337, readyTimeout = 180000 } = {}) {
  const appUrl = `http://127.0.0.1:${port}/`;
  const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--host', '127.0.0.1', '--strictPort'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
  });

  let browser;
  const close = async () => {
    await browser?.close().catch(() => {});
    server.kill('SIGTERM');
  };

  try {
    await waitForServer(appUrl);

    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader-webgl',
        '--ignore-gpu-blocklist',
        `--window-size=${width},${height}`,
        '--mute-audio',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    const errors = [];
    const IGNORE = /SwiftShader|GroupMarkerNotSet|Automatic fallback|ReadPixels|GPU stall|WebGL: CONTEXT_LOST/i;
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (!IGNORE.test(text)) errors.push(text);
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`${appUrl}?seed=${seed}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.mineclon && window.mineclon.loaded === true', { timeout: readyTimeout, polling: 500 });

    return { page, errors, close, appUrl };
  } catch (err) {
    await close();
    throw err;
  }
}
