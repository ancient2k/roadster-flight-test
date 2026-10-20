// UI view of the Phase 2 worlds. Single source: src/shared/worlds.ts (SITES, BODY_NAMES) and
// src/shared/environment.ts (ENVIRONMENTS). This module only adds display helpers. DOM-free (tests/ui/worlds.test.ts).
import { ENVIRONMENTS, type BodyId } from '../shared/environment';
import { G0 } from '../shared/math';
import { BODY_NAMES, SITES, type SiteDef } from '../shared/worlds';

export interface BodyInfo { id: BodyId; label: string; tagline: string }

/** Tab order and the one-line effect of each body on the car (UI copy only). */
const TAGLINES: Record<BodyId, string> = {
  earth: '1 g, dichte Luft: Lüfter, Aero und Kompressor arbeiten wie im Stream.',
  moon: 'Ein Sechstel g, kein Luftdruck: nur Düsen, keine Ansaugung, kein Nachfüllen.',
  mars: '0,38 g, dünne CO₂-Atmosphäre: Lüfter und Flügel fast wirkungslos.',
  space: 'Freier Raum auf der Bahn um die Sonne: Schwerelosigkeit, nur Düsen.',
};
const ORDER: BodyId[] = ['earth', 'moon', 'mars', 'space'];

export const BODIES: BodyInfo[] = ORDER.map((id) => ({ id, label: BODY_NAMES[id], tagline: TAGLINES[id] }));

export const sitesOf = (body: BodyId): SiteDef[] => SITES.filter((s) => s.body === body);

const de = (v: number, d: number) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

const gravityOf = (body: BodyId) => { const g = ENVIRONMENTS[body].gravity; return Math.hypot(g.x, g.y, g.z); };

/** Surface gravity for a site card, e.g. "1,62 m/s² · 0,17 g" (free space: "0 m/s² · schwerelos"). */
export function gravityText(body: BodyId): string {
  const g = gravityOf(body);
  return g > 0 ? `${de(g, 2)} m/s² · ${de(g / G0, 2)} g` : '0 m/s² · schwerelos';
}

/** Short physics facts for a body (chips under the tabs). */
export function bodyFacts(body: BodyId): Array<{ value: string; label: string }> {
  const e = ENVIRONMENTS[body];
  const g = gravityOf(body);
  return [
    { value: g > 0 ? `${de(g / G0, 2)} g` : '0 g', label: g > 0 ? `${de(g, 2)} m/s²` : 'schwerelos' },
    { value: e.ambientPressurePa >= 1000 ? `${de(e.ambientPressurePa / 1e5, 2)} bar` : `${Math.round(e.ambientPressurePa)} Pa`, label: 'Luftdruck' },
    { value: e.airDensity > 0 ? `${de((e.airDensity / ENVIRONMENTS.earth.airDensity) * 100, e.airDensity < 0.1 ? 1 : 0)} %` : '–', label: 'Lüfter/Aero' },
    { value: e.canRefill ? 'ja' : 'nein', label: 'Nachfüllen' },
  ];
}
