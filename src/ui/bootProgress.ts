// Progress hooks for the boot screen of index.html: finished start-up steps (the timing laps of
// GameRenderer.create/setup) and bytes of large downloads still in flight. No-ops once the boot screen is gone.
export interface BootState {
  t0: number; main?: boolean; lastNet: number; errors: string[];
  /** Last finished start-up step. */
  phase?: string;
  step?: (k: string) => void;
  bytes?: (url: string, loaded: number) => void;
}

const state = (): BootState | undefined => (typeof window === 'undefined' ? undefined : window.__rftBoot);

export function bootStep(k: string): void { state()?.step?.(k); }

/** Download progress callback for three.js loaders (ProgressEvent.loaded). */
export function bootBytes(url: string): (e: { loaded: number }) => void {
  return (e) => state()?.bytes?.(url, e.loaded);
}

/** The steps after which only shader compilation and invisible warm-up frames remain. */
export const PREPARING_STEPS = new Set(['s.rest', 's.compile', 'setup', 'prewarm', 'bakeWait']);
