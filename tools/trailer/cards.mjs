// Trailer pieces that are not game renders: the DOS boot (frames) and the end card (transparent PNG over the closing
// shot). Plain HTML rendered by Playwright, no game needed.
//   node tools/trailer/cards.mjs [dos] [endcard]
import { chromium } from '@playwright/test';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { OUT, encode } from './lib.mjs';

const URL_SITE = 'https://roadster.ageco-labs.de';
const lang = process.env.TRAILER_LANG ?? 'en';
const TEXT = {
  de: { free: 'Kostenlos im Browser · Open Source', build: 'Bau deine Strecke.', fly: 'Flieg sie.', scan: 'Scannen und losfliegen', disclaimer: 'Inoffizielles Fan-Projekt · keine Verbindung zu Tesla, Inc. oder SpaceX' },
  en: { free: 'Free in your browser · Open source', build: 'Build your track.', fly: 'Fly it.', scan: 'Scan and take off', disclaimer: 'Unofficial fan project · not affiliated with Tesla, Inc. or SpaceX' },
}[lang];
const font = (w) => `url(${path.resolve(`public/assets/fonts/rft-display-${w}.woff`)})`;
const FONTS = `@font-face{font-family:RFT;font-weight:400;src:${font(400)}}@font-face{font-family:RFT;font-weight:600;src:${font(600)}}@font-face{font-family:RFT;font-weight:800;src:${font(800)}}`;

const which = process.argv.slice(2);
const all = which.length === 0;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

// ---------------------------------------------------------------- DOS boot (≈ 4.2 s)
if (all || which.includes('dos')) {
  const fps = 60, name = 'dos';
  // [time (s), line] – each line appears at its time; the memory count and the typed command are animated
  const script = [
    [0.25, 'RFT BIOS v1.0  (C) 1990 Roadster Flight Test'],
    [0.45, ''],
    [0.55, '@MEM'],
    [1.25, ''],
    [1.35, 'Detecting drives ... C: 40 MB'],
    [1.75, ''],
    [1.85, 'Starting DOS ...'],
    [2.35, ''],
    [2.45, '@TYPE C:\\>ROADSTER /EDIT'],
  ];
  const html = `<!doctype html><html><body style="margin:0;background:#000;width:1920px;height:1080px;overflow:hidden">
<pre id="t" style="margin:0;padding:60px 80px;color:#c0c0c0;font:700 34px/1.35 'Courier New',ui-monospace,monospace;letter-spacing:1px;text-shadow:0 0 6px rgba(200,200,200,.35)"></pre>
<div style="position:fixed;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.28) 0 2px,transparent 2px 4px);pointer-events:none"></div>
</body></html>`;
  await page.setContent(html);
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const end = 4.2, n = Math.round(end * fps);
  const typeStart = 2.45, typeCps = 14;
  const events = [{ t: 0.05, kind: 'beep' }, { t: 1.35, kind: 'disk' }];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const lines = [];
    for (const [at, line] of script) {
      if (t < at) break;
      if (line === '@MEM') { const kb = Math.min(4096, Math.floor(((t - at) / 0.6) * 4096 / 64) * 64); lines.push(`Memory Test: ${String(kb).padStart(5)}K${kb >= 4096 ? ' OK' : ''}`); }
      else if (line.startsWith('@TYPE ')) {
        const full = line.slice(6), prompt = 'C:\\>';
        const k = Math.min(full.length - prompt.length, Math.max(0, Math.floor((t - typeStart - 0.35) * typeCps)));
        lines.push(prompt + full.slice(prompt.length, prompt.length + k));
      } else lines.push(line);
    }
    const blink = Math.floor(t * 3.4) % 2 === 0 ? '█' : ' ';
    await page.evaluate((s) => { document.getElementById('t').textContent = s; }, lines.join('\n') + blink);
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
  }
  const typed = 'ROADSTER /EDIT'.length;
  for (let k = 0; k < typed; k++) events.push({ t: typeStart + 0.35 + k / typeCps, kind: 'key' });
  events.push({ t: typeStart + 0.35 + typed / typeCps + 0.25, kind: 'enter' });
  fs.writeFileSync(path.join(OUT, `${name}.events.json`), JSON.stringify({ fps, end, events }, null, 1));
  encode(name, fps);
  console.log('dos:', path.join(OUT, `${name}.mp4`));
}

// ---------------------------------------------------------------- end card (transparent PNG, right half)
if (all || which.includes('endcard')) {
  const qr = await QRCode.toString(URL_SITE, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  const html = `<!doctype html><html><head><style>${FONTS}
body{margin:0;width:1920px;height:1080px;background:transparent;font-family:RFT,system-ui,sans-serif;color:#fff}
.panel{position:absolute;right:90px;top:150px;width:700px;padding:44px 48px 36px;background:rgba(8,10,14,.62);backdrop-filter:blur(10px);
  border-left:4px solid #e8212b;box-shadow:0 20px 60px rgba(0,0,0,.35)}
h1{margin:0;font-weight:800;font-size:58px;letter-spacing:.06em;line-height:1.05;text-transform:uppercase}
.free{margin:12px 0 30px;font-weight:600;font-size:24px;letter-spacing:.08em;opacity:.85;text-transform:uppercase}
.row{display:flex;gap:30px;align-items:center}
.qr{width:250px;height:250px;background:#fff;padding:0;flex:none}
.qr svg{width:100%;height:100%;display:block}
.url{font-weight:800;font-size:30px;letter-spacing:.02em}
.scan{font-weight:600;font-size:19px;letter-spacing:.1em;text-transform:uppercase;opacity:.7;margin-bottom:10px}
.gh{margin-top:16px;font-weight:400;font-size:19px;opacity:.75}
.disc{margin-top:30px;font-weight:400;font-size:15px;opacity:.55;letter-spacing:.02em}
</style></head><body><div class="panel">
<h1>Roadster<br>Flight Test</h1>
<div class="free">${TEXT.free}</div>
<div class="row"><div class="qr">${qr}</div><div><div class="scan">${TEXT.scan}</div><div class="url">roadster.ageco-labs.de</div>
<div class="gh">github.com/ancient2k/<br>roadster-flight-test</div></div></div>
<div class="disc">${TEXT.disclaimer}</div>
</div></body></html>`;
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, 'endcard.png'), omitBackground: true });
  console.log('endcard:', path.join(OUT, 'endcard.png'));
}
await browser.close();
