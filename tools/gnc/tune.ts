// TUNE='{"rampLaunch":{"fanLevel":null}}' overrides stunt tuning constants for one tool run.
import { TUNING } from '../../src/sim/stunts/tuning';

export function applyTuneEnv(): void {
  const tune = JSON.parse(process.env.TUNE ?? '{}') as Record<string, Record<string, unknown>>;
  for (const [k, o] of Object.entries(tune)) Object.assign((TUNING as unknown as Record<string, object>)[k], o);
}
