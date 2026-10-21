// Display names shared by HUD, menus and result screens. All text comes from src/i18n and is
// looked up on access, so a language switch takes effect on the next render.
import type { AeroMode, AssistLevel, FanMode, StuntId } from '../shared/types';
import { t, tMaybe, type MsgKey } from '../i18n';

export interface StuntInfo { id: StuntId; title: string; short: string; description: string; videoTime: string }

const stunt = (id: StuntId, videoTime: string): StuntInfo => ({
  id, videoTime,
  get title() { return t(`stunt.${id}.title`); },
  get short() { return t(`stunt.${id}.short`); },
  get description() { return t(`stunt.${id}.description`); },
});

export const STUNTS: StuntInfo[] = [
  stunt('ramp_hang', '≈ 10:50'),
  stunt('ramp_launch', '≈ 12:00'),
  stunt('kickflip', '≈ 16:00'),
  stunt('zero60', '≈ 20:50'),
  stunt('ground_flip', '≈ 26:40'),
];

export const stuntInfo = (id: StuntId): StuntInfo => STUNTS.find((s) => s.id === id)!;

/** Record whose values are translated on every read (keys fixed, text follows the current locale). */
function lazyRecord<K extends string>(keys: readonly K[], key: (k: K) => MsgKey): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { enumerable: true, get: () => t(key(k)) });
  return o;
}

const ASSISTS = ['ASSIST', 'STABILIZED', 'RAW'] as const satisfies readonly AssistLevel[];
export const ASSIST_LABEL: Record<AssistLevel, string> = lazyRecord(ASSISTS, (a) => `assist.${a}`);
export const ASSIST_DESC: Record<AssistLevel, string> = lazyRecord(ASSISTS, (a) => `assist.${a}.desc`);
export const FAN_LABEL: Record<FanMode, string> = lazyRecord(['off', 'grip', 'highspeed'] as const, (m) => `fan.${m}`);
export const AERO_LABEL: Record<AeroMode, string> = lazyRecord(['lowDrag', 'highDownforce', 'auto'] as const, (m) => `aero.${m}`);

/** Reference value labels/units for TRACK.sites[].reference keys. */
export interface ReferenceMeta { label: string; unit: string; kind?: 'alt' | 'deg' | 'g' | 'kg' | 'kg1' | 's' }
const REF_META: Record<string, Omit<ReferenceMeta, 'label'>> = {
  maxPitchDeg: { unit: '°', kind: 'deg' },
  holdAltitudeM: { unit: 'm', kind: 'alt' },
  maxDownforceKg: { unit: 'kg', kind: 'kg' },
  holdSeconds: { unit: 's', kind: 's' },
  leaveAltitudeM: { unit: 'm', kind: 'alt' },
  touchdownG: { unit: 'g', kind: 'g' },
  climbG: { unit: 'g', kind: 'g' },
  launchG: { unit: 'g', kind: 'g' },
  apexAltitudeM: { unit: 'm', kind: 'alt' },
  rollDeg: { unit: '°', kind: 'deg' },
  airtimeS: { unit: 's', kind: 's' },
  zeroToSixtyS: { unit: 's', kind: 's' },
  airUsedKg: { unit: 'kg', kind: 'kg1' },
  durationS: { unit: 's', kind: 's' },
};
export const REFERENCE_LABEL: Record<string, ReferenceMeta> = Object.fromEntries(
  Object.entries(REF_META).map(([k, m]) => [k, { ...m, get label() { return t(`ref.${k}` as MsgKey); } }]),
);

// ------------------------------------------------------------------ GNC result reasons (English ids) -> UI text
/** Check names used by the stunt evaluators (src/sim/stunts/*.ts evaluate()) -> message key. */
export const CHECK_KEY: Record<string, MsgKey> = {
  'pitch ≥ 165°': 'check.pitch165',
  'hang altitude 21 m ±10 %': 'check.hangAlt21',
  'downforce 4700 kg ±10 %': 'check.downforce4700',
  'hang ≥ 9.5 s at ≥ 165°': 'check.hang95',
  'not crashed / fallen': 'check.notFallen',
  'apex altitude 7.7 m ±15 %': 'check.apex77',
  'apex altitude 8 m ±15 %': 'check.apex8',
  'launch g 3.5 ±0.7': 'check.launchG35',
  'touchdown g ≤ 2.5': 'check.touchdownG25',
  'touchdown sink ≤ 2 m/s': 'check.sink2',
  'full roll 360°': 'check.fullRoll',
  'half flip ≈ 180°': 'check.halfFlip',
  'wheels down at touchdown': 'check.wheelsDown',
  'landed upright': 'check.upright',
  'no contact with Semi / car row': 'check.noContactRow',
  'no ramp contact in flight': 'check.noRampContact',
  'lifted off from the flat pad': 'check.flatLiftoff',
  'leaves the top at ≈ 20.7 m (±15 %)': 'check.leaveTop',
  '0–60 mph 0.81 s ±0.1 s': 'check.zero60',
  'not crashed': 'check.notCrashed',
  'stunt completed': 'check.completed',
};
/** Translated check names (read on access). */
export const CHECK_LABEL: Record<string, string> = lazyRecord(Object.keys(CHECK_KEY), (k) => CHECK_KEY[k]);

const REASON_EXACT: Record<string, MsgKey> = {
  crash: 'reason.crash',
  totalLoss: 'damage.totalLoss',
  timeout: 'reason.timeout',
  'lost the wall': 'reason.lostWall',
  'insufficient air': 'reason.insufficientAir',
};

/** Display text of a stunt/manual phase id (HUD "PHASE" line); unknown ids are shown as they are. */
export function phaseLabel(id: string): string {
  return tMaybe(`phase.${id}`) ?? id.replace(/_/g, ' ').toUpperCase();
}

/**
 * Display text for a GNC result reason. Returns null when nothing should be shown ('ok', empty).
 * Unknown reasons are returned unchanged.
 */
export function reasonText(reason: string | undefined | null): string | null {
  const r = (reason ?? '').trim();
  if (!r || r.toLowerCase() === 'ok') return null;
  return translateReason(r);
}

function translateReason(r: string): string {
  if (REASON_EXACT[r]) return t(REASON_EXACT[r]);
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^(.*)\s*\(car recovered\)$/s))) return t('reason.recovered', { reason: translateReason(m[1].trim()) });
  if ((m = r.match(/^checks failed:\s*(.*)$/s))) {
    const items = m[1].split(/,\s*(?![^(]*\))/).map((x) => (CHECK_KEY[x.trim()] ? t(CHECK_KEY[x.trim()]) : x.trim())).filter(Boolean);
    return t('reason.checksFailed', { items: items.join(' · ') });
  }
  if ((m = r.match(/^aborted:\s*valve test failed\s*\((.*)\)$/s))) return t('reason.valveTest', { jets: m[1] });
  if ((m = r.match(/^aborted:\s*(.*)$/s))) return t('reason.aborted', { reason: translateReason(m[1].trim()) });
  if ((m = r.match(/^insufficient air:\s*(.*)$/s))) return t('reason.insufficientAirDetail', { detail: m[1] });
  if ((m = r.match(/^timeout in\s+(\S+)$/))) return t('reason.timeoutIn', { phase: phaseLabel(m[1]) });
  if ((m = r.match(/^rotation bailed at\s+(\d+)\s*%:\s*too low$/))) return t('reason.rotationBailed', { pct: m[1] });
  if (CHECK_KEY[r]) return t(CHECK_KEY[r]);
  return r;
}

/** Low-air warning from the GNC phase label (ManualAssist ids LOW_AIR / AUTOLAND): 'low' | 'autoland' | null. */
export function airWarning(phase: string | undefined | null): 'low' | 'autoland' | null {
  const p = (phase ?? '').toUpperCase();
  if (p.includes('AUTOLAND')) return 'autoland';
  if (p.includes('LOW_AIR')) return 'low';
  return null;
}
