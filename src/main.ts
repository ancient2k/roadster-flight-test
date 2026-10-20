// Entry point: boots the app and exposes a debug/test hook on window.__rft.
import { App } from './game/app';
import type { StuntId } from '@shared/types';

declare global { interface Window { __rft?: Record<string, unknown> } }

const STUNTS: StuntId[] = ['ramp_hang', 'ramp_launch', 'kickflip', 'zero60', 'ground_flip'];

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  root.appendChild(canvas);
  const params = new URLSearchParams(location.search);
  const app = new App(root, canvas);
  window.__rft = {
    ready: false, app, stunts: STUNTS,
    startStunt: (id: StuntId) => { app.menu.hide(); app.startStunt(id); },
    startFreePlay: (id?: StuntId) => { app.menu.hide(); app.startFreePlay(id); },
    outcome: () => app.session?.outcome,
    startWorld: (id: string) => { app.menu.hide(); return app.startWorld(id as never); },
    /** Test hook: advance the simulation synchronously by `seconds` (rendering continues normally). */
    fastForward: (seconds: number) => {
      const n = Math.round(seconds / app.sim.dt);
      for (let i = 0; i < n && app.session.outcome.status === 'running'; i++) app.session.step();
      const tel = app.session.telemetry();
      return { outcome: app.session.outcome.status, reason: app.session.outcome.reason, t: tel.t, phase: tel.phase, alt: tel.altitudeM, pitch: tel.pitchDeg };
    },
  };
  const q = params.get('q') as 'low' | 'medium' | 'high' | 'ultra' | null;
  await app.init({ quality: q ?? undefined, forceWebGL: params.has('webgl'), skipMenu: params.has('nomenu') });
  const stunt = params.get('stunt') as StuntId | null;
  if (stunt && STUNTS.includes(stunt)) { app.menu.hide(); app.startStunt(stunt); }
  window.__rft.ready = true;
}

boot().catch((e) => {
  console.error(e);
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#f66;padding:24px;font:14px monospace';
  pre.textContent = `Start fehlgeschlagen: ${String(e?.stack ?? e)}`;
  document.body.appendChild(pre);
});
