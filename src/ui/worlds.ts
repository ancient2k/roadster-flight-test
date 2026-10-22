// UI view of the Phase 2 worlds. Single source: src/shared/worlds.ts (SITES, BODY_NAMES) and
// src/shared/environment.ts (ENVIRONMENTS). This module only adds display helpers. DOM-free (tests/ui/worlds.test.ts).
import { ENVIRONMENTS, type BodyId } from '../shared/environment';
import { G0 } from '../shared/math';
import { BODY_NAMES, SITES, type SiteDef } from '../shared/worlds';
import { fmtNum, fmtPct, t } from '../i18n';

export interface BodyInfo { id: BodyId; label: string; tagline: string }

const ORDER: BodyId[] = ['earth', 'moon', 'mars', 'space'];

/** Tab order; label and the one-line effect of each body on the car are translated on read. */
export const BODIES: BodyInfo[] = ORDER.map((id) => ({
  id,
  get label() { return BODY_NAMES[id]; },
  get tagline() { return t(`body.${id}.tagline`); },
}));

export const sitesOf = (body: BodyId): SiteDef[] => SITES.filter((s) => s.body === body);

const gravityOf = (body: BodyId) => { const g = ENVIRONMENTS[body].gravity; return Math.hypot(g.x, g.y, g.z); };

/** Surface gravity for a site card, e.g. "1.62 m/s² · 0.17 g" (free space: "0 m/s² · weightless"). */
export function gravityText(body: BodyId): string {
  const g = gravityOf(body);
  return g > 0 ? `${fmtNum(g, 2)} m/s² · ${fmtNum(g / G0, 2)} g` : `0 m/s² · ${t('worlds.weightless')}`;
}

/** Short physics facts for a body (chips under the tabs). `compressor` is the setting: with 'game' (Fun) the
 *  on-board supply refills where the atmosphere cannot. */
export function bodyFacts(body: BodyId, compressor: 'realistic' | 'game' = 'realistic'): Array<{ value: string; label: string }> {
  const e = ENVIRONMENTS[body];
  const g = gravityOf(body);
  return [
    { value: g > 0 ? `${fmtNum(g / G0, 2)} g` : '0 g', label: g > 0 ? `${fmtNum(g, 2)} m/s²` : t('worlds.weightless') },
    { value: e.ambientPressurePa >= 1000 ? `${fmtNum(e.ambientPressurePa / 1e5, 2)} bar` : `${Math.round(e.ambientPressurePa)} Pa`, label: t('worlds.airPressure') },
    { value: e.airDensity > 0 ? fmtPct(e.airDensity / ENVIRONMENTS.earth.airDensity, { digits: e.airDensity < 0.1 ? 1 : 0 }) : '–', label: t('worlds.fansAero') },
    { value: t(e.canRefill ? 'common.yes' : compressor === 'game' ? 'worlds.refillOnboard' : 'common.no'), label: t('worlds.refill') },
  ];
}
