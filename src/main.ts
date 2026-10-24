// Entry point: boots the app and exposes a debug/test hook on window.__rft.
import { App } from './game/app';
import { t } from './i18n';
import { classifyDevice, defaultQualityFor, pickQuality, setDeviceProfile, type QualityLevel } from './render/quality';
import { SETTINGS_KEY } from './ui/settings';
import { TouchControls, hasTouch } from './ui/touchControls';
import { PREPARING_STEPS, type BootState } from './ui/bootProgress';
import { applyPendingUpdate, registerServiceWorker } from './pwa/register';
import type { StuntId } from '@shared/types';

declare global {
  interface Window {
    __rft?: Record<string, unknown>;
    /** Boot watchdog state shared with the inline script of index.html. */
    __rftBoot?: BootState;
  }
}

const STUNTS: StuntId[] = ['ramp_hang', 'ramp_launch', 'kickflip', 'zero60', 'ground_flip'];
/** sessionStorage flag: the automatic WebGPU -> WebGL2 retry happened once in this tab. */
const RETRY_KEY = 'rft.bootRetry';
/** Show the "taking long" hint after this long without readiness and without network activity (s). */
const SLOW_DEBUG = Number(new URLSearchParams(location.search).get('bootslow')) || 0; // ?bootslow=<s> (tests)
const SLOW_AFTER_S = SLOW_DEBUG || 75, SLOW_QUIET_S = SLOW_DEBUG ? 1 : 25;

const bootState = (window.__rftBoot ??= { t0: performance.now(), lastNet: performance.now(), errors: [] });
bootState.main = true;

function detectProfile() {
  const mm = (q: string) => { try { return matchMedia(q).matches; } catch { return false; } };
  return classifyDevice({
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    coarsePointer: mm('(pointer: coarse)'),
    canHover: mm('(hover: hover)'),
    minScreen: Math.min(screen.width || innerWidth, screen.height || innerHeight),
    userAgent: navigator.userAgent,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  });
}

function storedSettingsExist(): boolean {
  try { return !!localStorage.getItem(SETTINGS_KEY); } catch { return false; }
}

const profile = detectProfile();
setDeviceProfile(profile);
if (profile === 'mobile') document.documentElement.classList.add('rft-mobile');

/** URL of this page with the given query changes (null removes). */
function withParams(changes: Record<string, string | null>): string {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(changes)) if (v === null) u.searchParams.delete(k); else u.searchParams.set(k, v);
  return u.toString();
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
  root.appendChild(canvas);
  const params = new URLSearchParams(location.search);
  const app = new App(root, canvas);
  window.__rft = {
    ready: false, app, stunts: STUNTS, profile,
    startStunt: (id: StuntId) => { app.menu.hide(); app.startStunt(id); },
    startFreePlay: (id?: StuntId) => { app.menu.hide(); app.startFreePlay(id); },
    outcome: () => app.session?.outcome,
    startWorld: (id: string) => { app.menu.hide(); return app.startWorld(id as never); },
    /** Test hook: drive a track-editor level (src/shared/level.ts). */
    playLevel: (level: unknown) => { app.menu.hide(); return app.playLevel(level as never); },
    /** Test hook: Starship launch clock of the driven level (App.launchWarp). */
    launchWarp: (seconds: number, met?: number) => app.launchWarp(seconds, met),
    /** Frame capture (tools/trailer): stop the real-time loop and hold the full resolution; frames are then
     *  produced one by one with captureFrame(dt) (simulation + render on a fixed clock, independent of wall time). */
    captureBegin: () => { app.loop.stop(); app.renderer.setFixedResolution(true); },
    captureFrame: (dt: number) => { app.loop.advance(dt); },
    /** Hard camera cut: clears the temporal history (TRAA, motion blur) for the next frame. */
    captureCut: () => { app.renderer.rig.onCut?.(); },
    /** Test hook: advance the simulation synchronously by `seconds` (rendering continues normally). */
    fastForward: (seconds: number) => {
      const n = Math.round(seconds / app.sim.dt);
      for (let i = 0; i < n && app.session.outcome.status === 'running'; i++) app.session.step();
      const tel = app.session.telemetry();
      return { outcome: app.session.outcome.status, reason: app.session.outcome.reason, t: tel.t, phase: tel.phase, alt: tel.altitudeM, pitch: tel.pitchDeg };
    },
  };
  // Phones and tablets start on "low" unless the player picked a quality before (or ?q= is given).
  // (not under automation: the tests pin their preset, a preset switch in the middle of one would break it)
  const firstRun = !params.has('q') && !storedSettingsExist() && !params.has('nomenu') && !navigator.webdriver;
  const q = (params.get('q') as QualityLevel | null) ?? (storedSettingsExist() ? null : profile === 'mobile' ? defaultQualityFor(profile) : null);
  // A lost context before the first frame (GPU memory on phones) would otherwise leave the boot screen up forever.
  const lost = new Promise<never>((_, reject) => canvas.addEventListener('webglcontextlost', () => reject(new Error('WebGL context lost')), { once: true }));
  await Promise.race([app.init({ quality: q ?? undefined, forceWebGL: params.has('webgl'), skipMenu: params.has('nomenu') }), lost]);
  const stunt = params.get('stunt') as StuntId | null;
  if (stunt && STUNTS.includes(stunt)) { app.menu.hide(); app.startStunt(stunt); }
  const touch = new TouchControls(root, app.input, {
    force: params.has('touch') || hasTouch(), settings: app.settings,
    systems: () => app.manual ? { fans: app.manual.fanMode !== 'off' || app.manual.autoFan, refill: app.manual.refill } : null,
  });
  window.__rft.touch = touch;
  window.__rft.ready = true;
  window.__rft.openEditor = () => app.openEditor();
  // a shared track link (#track=v1.…) opens the editor with that track
  if (/[#&]track=/.test(location.hash)) void app.openEditor();
  try { sessionStorage.removeItem(RETRY_KEY); } catch { /* blocked */ }
  hideBootScreen();
  void registerServiceWorker(showUpdateNotice);
  if (firstRun) void benchmarkQuality(app);
}

/** A new build is ready (src/pwa/register.ts): a small notice with "Reload" – the game keeps running until then. */
/**
 * First start: measure a few seconds of the title scene at the device default and store the fitting preset
 * (pickQuality). Runs once: afterwards the settings exist. Said in a short note, changeable under Settings → Graphics.
 */
async function benchmarkQuality(app: App): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(2500); // shaders compiled, terrain streamed, dynamic resolution settled
  const f: number[] = [], g: number[] = [], r: number[] = [];
  for (let i = 0; i < 16; i++) {
    await wait(250);
    if (document.hidden) return; // a background tab throttles rAF: no valid measurement
    const s = app.renderer.getStats();
    f.push(s.frameMs); r.push(s.resolutionScale);
    if (s.gpuMs !== null) g.push(s.gpuMs);
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const pick = pickQuality(profile, { frameMs: med(f), gpuMs: g.length ? med(g) : null, resolutionScale: Math.min(...r) });
  const was = app.settings.get().graphics.quality;
  app.setQuality(pick);
  console.info(`[quality] first start: frame ${med(f).toFixed(1)} ms, gpu ${g.length ? med(g).toFixed(1) : '–'} ms, scale ${Math.min(...r)} -> ${pick}`);
  if (pick !== was) showNote(t('flash.autoQuality', { quality: t(`quality.${pick}`) }));
}

/** Short note at the bottom (same place as the update notice), gone after a few seconds. */
function showNote(text: string): void {
  const el = document.createElement('div');
  el.className = 'rft-update';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 7000);
}

function showUpdateNotice(apply: () => void): void {
  if (document.querySelector('.rft-update')) return;
  const el = document.createElement('div');
  el.className = 'rft-update';
  el.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = t('update.ready');
  const go = document.createElement('button');
  go.type = 'button'; go.className = 'rft-update-go'; go.textContent = t('update.reload');
  go.addEventListener('click', () => { go.disabled = true; apply(); });
  const later = document.createElement('button');
  later.type = 'button'; later.className = 'rft-update-later'; later.textContent = t('update.later');
  later.addEventListener('click', () => el.remove());
  el.append(msg, go, later);
  document.body.append(el);
}

// ------------------------------------------------------------------ boot screen (index.html)
const bootEl = () => document.getElementById('boot');
let statusTimer = 0;
/** The "taking long" hint was shown once (Keep waiting must not bring it back). */
let slowShown = false;

/** Phase line under the MB counter: downloading -> preparing graphics (shader compilation), with elapsed time. */
function startBootStatus(): void {
  const el = bootEl();
  if (!el) return;
  const line = document.createElement('div');
  line.className = 'ph';
  el.appendChild(line);
  const tick = () => {
    const now = performance.now();
    const s = Math.round((now - bootState.t0) / 1000);
    const quiet = (now - bootState.lastNet) / 1000;
    // the renderer reports its steps (src/ui/bootProgress.ts); network silence is the fallback
    const preparing = PREPARING_STEPS.has(bootState.phase ?? '') || quiet > 3;
    line.textContent = preparing ? t('boot.preparing', { s }) : `${t('boot.loading')} ${s} s`;
    if (!slowShown && s > SLOW_AFTER_S && quiet > SLOW_QUIET_S) { slowShown = true; showBootMessage('slow'); }
  };
  tick();
  statusTimer = window.setInterval(tick, 500);
}

/** Message box in the boot screen: 'slow' keeps loading in the background, 'failed' is final. */
function showBootMessage(kind: 'slow' | 'failed', detail?: string): void {
  const el = bootEl();
  if (!el) return;
  el.querySelector('.msg')?.remove();
  el.classList.add(kind === 'failed' ? 'failed' : 'slow');
  const box = document.createElement('div');
  box.className = 'msg';
  box.setAttribute('role', 'alert');
  const p = document.createElement('p');
  p.textContent = t(kind === 'failed' ? 'boot.failed' : 'boot.slow');
  box.appendChild(p);
  const row = document.createElement('div');
  row.className = 'row';
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.onclick = fn; row.appendChild(b);
  };
  btn(t('boot.retryLow'), () => location.assign(withParams({ q: 'low', webgl: '1' })));
  if (kind === 'slow') btn(t('boot.keepWaiting'), () => box.remove());
  else btn(t('boot.retry'), () => location.reload());
  box.appendChild(row);
  const errs = [detail, ...bootState.errors].filter(Boolean);
  if (errs.length) {
    const d = document.createElement('details');
    const sm = document.createElement('summary');
    sm.textContent = t('boot.details');
    const pre = document.createElement('pre');
    pre.textContent = errs.join('\n\n').slice(0, 4000);
    d.append(sm, pre);
    box.appendChild(d);
  }
  el.appendChild(box);
}

/** Fades out the static boot screen of index.html (download progress while the game loads). */
function hideBootScreen(): void {
  clearInterval(statusTimer);
  const el = bootEl();
  if (!el) return;
  el.classList.add('done');
  el.removeAttribute('aria-busy');
  setTimeout(() => el.remove(), 500);
}

void applyPendingUpdate();
startBootStatus();
boot().catch((e) => {
  console.error(e);
  clearInterval(statusTimer);
  const params = new URLSearchParams(location.search);
  // WebGPU present but unusable (adapter/device creation, limits, memory): retry once on WebGL2.
  let retried = true;
  try { retried = !!sessionStorage.getItem(RETRY_KEY); if (!retried) sessionStorage.setItem(RETRY_KEY, '1'); } catch { /* blocked: no auto retry */ }
  if (!retried && 'gpu' in navigator && !params.has('webgl')) {
    location.replace(withParams({ webgl: '1', ...(profile === 'mobile' ? { q: 'low' } : {}) }));
    return;
  }
  if (bootEl()) { showBootMessage('failed', String(e?.stack ?? e)); return; }
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#f66;padding:24px;font:14px monospace';
  pre.textContent = t('app.bootFailed', { error: String(e?.stack ?? e) });
  document.body.appendChild(pre);
});
