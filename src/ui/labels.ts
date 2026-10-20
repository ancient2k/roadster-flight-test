// German display names shared by HUD, menus and result screens.
import type { AeroMode, AssistLevel, FanMode, StuntId } from '../shared/types';

export interface StuntInfo { id: StuntId; title: string; short: string; description: string; videoTime: string }

export const STUNTS: StuntInfo[] = [
  {
    id: 'ramp_hang', title: 'Kopfüber-Rampe', short: 'Wand hoch, 170° Pitch, hängen',
    description: 'Mit 4 × 20 kW Lüfter-Ansaugung die gebogene Wand hinauf bis fast kopfüber und rund 10 Sekunden in 21 m Höhe hängen bleiben, dann kontrolliert zurück.',
    videoTime: '≈ 10:50',
  },
  {
    id: 'ramp_launch', title: 'Rampen-Absprung', short: 'Oben abheben, halber Flip, Düsenlandung',
    description: 'Die Wand mit 1,4 g hinauf, oben in rund 19,5 m Höhe über die Kante, halber Überschlag in der Luft und mit vier Hubdüsen weich abfangen.',
    videoTime: '≈ 12:00',
  },
  {
    id: 'kickflip', title: 'Kickflip', short: 'Über Semi und Fahrzeugreihe rollen',
    description: 'Vom kleinen Kicker mit 3,5 g abspringen, eine volle Rolle um die Längsachse über Semi und Fahrzeugreihe, Gipfel ≈ 7,7 m, Landung mit Abwärtsschub bei ≈ 2 g.',
    videoTime: '≈ 16:00',
  },
  {
    id: 'zero60', title: '0–60 mph', short: 'Lüfter + Heckdüsen, Ziel 0,81 s',
    description: 'Start aus dem Tor: Lüfter für Traktion, vier Heckdüsen mit Mach-Diamanten. Die Uhr läuft bis 60 mph (96,6 km/h). Tesla-Zeit: 0,81 s.',
    videoTime: '≈ 20:50',
  },
  {
    id: 'ground_flip', title: 'Bodenstart-Flip', short: 'Finale: abheben ohne Rampe, 360°',
    description: 'Das Finale: aus dem Stand vom flachen Boden nur mit Düsen abheben, eine komplette Drehung in der Luft und auf dem Luftpolster landen.',
    videoTime: '≈ 26:40',
  },
];

export const stuntInfo = (id: StuntId): StuntInfo => STUNTS.find((s) => s.id === id)!;

export const ASSIST_LABEL: Record<AssistLevel, string> = { ASSIST: 'Assistiert', STABILIZED: 'Stabilisiert', RAW: 'Direkt' };
export const ASSIST_DESC: Record<AssistLevel, string> = {
  ASSIST: 'Lage halten, automatisches Aufrichten und Auto-Landung. Ideal zum Einsteigen.',
  STABILIZED: 'Du steuerst Drehraten, der Regler hält sie. Landung und Lage liegen bei dir.',
  RAW: 'Direkte Düsengruppen ohne Regler. Für Testpiloten.',
};
export const FAN_LABEL: Record<FanMode, string> = { off: 'Aus', grip: 'Ansaugen', highspeed: 'High-Speed' };
export const AERO_LABEL: Record<AeroMode, string> = { lowDrag: 'Low Drag', highDownforce: 'Downforce', auto: 'Auto' };

/** Reference value labels/units for TRACK.sites[].reference keys. */
export const REFERENCE_LABEL: Record<string, { label: string; unit: string; kind?: 'alt' | 'deg' | 'g' | 'kg' | 'kg1' | 's' }> = {
  maxPitchDeg: { label: 'Max. Pitch', unit: '°', kind: 'deg' },
  holdAltitudeM: { label: 'Hänge-Höhe', unit: 'm', kind: 'alt' },
  maxDownforceKg: { label: 'Max. Downforce', unit: 'kg', kind: 'kg' },
  holdSeconds: { label: 'Hängezeit', unit: 's', kind: 's' },
  leaveAltitudeM: { label: 'Absprunghöhe', unit: 'm', kind: 'alt' },
  touchdownG: { label: 'Aufsetzen', unit: 'g', kind: 'g' },
  climbG: { label: 'Auffahrt', unit: 'g', kind: 'g' },
  launchG: { label: 'Absprung', unit: 'g', kind: 'g' },
  apexAltitudeM: { label: 'Gipfelhöhe', unit: 'm', kind: 'alt' },
  rollDeg: { label: 'Rolle', unit: '°', kind: 'deg' },
  airtimeS: { label: 'Flugzeit', unit: 's', kind: 's' },
  zeroToSixtyS: { label: '0–60 mph', unit: 's', kind: 's' },
  airUsedKg: { label: 'Luftverbrauch', unit: 'kg', kind: 'kg1' },
  durationS: { label: 'Dauer', unit: 's', kind: 's' },
};

// ------------------------------------------------------------------ GNC result reasons (English) -> German
/** Check names used by the stunt evaluators (src/sim/stunts/*.ts evaluate()). */
export const CHECK_LABEL: Record<string, string> = {
  'pitch ≥ 165°': 'Pitch ≥ 165°',
  'hang altitude 21 m ±10 %': 'Hänge-Höhe 21 m ±10 %',
  'downforce 4700 kg ±10 %': 'Downforce 4700 kg ±10 %',
  'hang ≥ 9.5 s at ≥ 165°': 'Hängezeit ≥ 9,5 s bei ≥ 165°',
  'not crashed / fallen': 'kein Absturz',
  'apex altitude 7.7 m ±15 %': 'Gipfelhöhe 7,7 m ±15 %',
  'apex altitude 8 m ±15 %': 'Gipfelhöhe 8 m ±15 %',
  'launch g 3.5 ±0.7': 'Absprung 3,5 g ±0,7',
  'touchdown g ≤ 2.5': 'Aufsetzen ≤ 2,5 g',
  'touchdown sink ≤ 2 m/s': 'Sinkrate beim Aufsetzen ≤ 2 m/s',
  'full roll 360°': 'volle 360°-Drehung',
  'half flip ≈ 180°': 'halber Überschlag ≈ 180°',
  'wheels down at touchdown': 'Räder unten beim Aufsetzen',
  'landed upright': 'aufrecht gelandet',
  'no contact with Semi / car row': 'keine Berührung mit Semi und Fahrzeugreihe',
  'no ramp contact in flight': 'keine Rampenberührung im Flug',
  'lifted off from the flat pad': 'vom flachen Boden abgehoben',
  'leaves the top at ≈ 19.5 m (±15 %)': 'Absprung oben bei ≈ 19,5 m (±15 %)',
  '0–60 mph 0.81 s ±0.1 s': '0–60 mph in 0,81 s ±0,1 s',
  'not crashed': 'kein Crash',
  'stunt completed': 'Stunt abgeschlossen',
};

const REASON_EXACT: Record<string, string> = {
  crash: 'Kollision',
  timeout: 'Zeitüberschreitung',
  'lost the wall': 'Wandkontakt verloren',
  'insufficient air': 'zu wenig Druckluft',
};

/**
 * German text for a GNC result reason. Returns null when nothing should be shown ('ok', empty).
 * Unknown reasons are returned unchanged.
 */
export function reasonText(reason: string | undefined | null): string | null {
  const r = (reason ?? '').trim();
  if (!r || r.toLowerCase() === 'ok') return null;
  return translateReason(r);
}

function translateReason(r: string): string {
  if (REASON_EXACT[r]) return REASON_EXACT[r];
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^checks failed:\s*(.*)$/s))) {
    const items = m[1].split(/,\s*(?![^(]*\))/).map((x) => CHECK_LABEL[x.trim()] ?? x.trim()).filter(Boolean);
    return `Referenzwerte verfehlt: ${items.join(' · ')}`;
  }
  if ((m = r.match(/^(.*)\s*\(car recovered\)$/s))) return `${translateReason(m[1].trim())} (Auto gerettet)`;
  if ((m = r.match(/^aborted:\s*valve test failed\s*\((.*)\)$/s))) return `Abgebrochen: Ventiltest fehlgeschlagen (${m[1]})`;
  if ((m = r.match(/^aborted:\s*(.*)$/s))) return `Abgebrochen: ${translateReason(m[1].trim())}`;
  if ((m = r.match(/^insufficient air:\s*(.*)$/s))) return `zu wenig Druckluft: ${m[1]}`;
  if ((m = r.match(/^timeout in\s+(\S+)$/))) return `Zeitüberschreitung in Phase ${m[1].replace(/_/g, ' ').toUpperCase()}`;
  if ((m = r.match(/^rotation bailed at\s+(\d+)\s*%:\s*too low$/))) return `Drehung bei ${m[1]} % abgebrochen: zu niedrig`;
  if (CHECK_LABEL[r]) return CHECK_LABEL[r];
  return r;
}

/** Low-air warning from the GNC phase label (ManualAssist): 'low' | 'autoland' | null. */
export function airWarning(phase: string | undefined | null): 'low' | 'autoland' | null {
  const p = (phase ?? '').toUpperCase();
  if (p.includes('AUTO-LANDUNG') || p.includes('AUTO_LANDUNG')) return 'autoland';
  if (p.includes('LUFT KNAPP') || p.includes('LUFT_KNAPP')) return 'low';
  return null;
}
