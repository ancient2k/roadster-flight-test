// Line icons for the stunt cards (stroke = currentColor, accent = red LED colour).
import type { StuntId } from '../../shared/types';
import type { SiteId } from '../../shared/worlds';

const wrap = (body: string) =>
  `<svg viewBox="0 0 160 84" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// wall ramp profile (quarter pipe + vertical + overhang), scaled into the icon
const WALL = 'M18 76 H52 A30 30 0 0 0 82 46 V26 A9 9 0 0 0 73 17';
const CAR = (x: number, y: number, rot: number) =>
  `<g transform="translate(${x} ${y}) rotate(${rot})"><rect x="-9" y="-3.5" width="18" height="6" rx="2.5" fill="currentColor" stroke="none"/><circle cx="-5.5" cy="3.5" r="2.2" fill="#000" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="3.5" r="2.2" fill="#000" stroke="currentColor" stroke-width="1.2"/></g>`;

export const STUNT_ICONS: Record<StuntId, string> = {
  ramp_hang: wrap(`<path d="${WALL}"/><path d="M84 76 V30" stroke-width="1" opacity=".45"/><path d="M90 76 V22" stroke-width="1" opacity=".45"/><path class="led" d="M18 80 H52"/>${CAR(75, 25, 200)}<path d="M100 30 h22 M100 40 h16" stroke-width="1.4" opacity=".6"/><text x="104" y="58" font-size="15" fill="currentColor" stroke="none" font-family="RFT Display">170°</text>`),
  ramp_launch: wrap(`<path d="${WALL}"/><path class="led" d="M18 80 H52"/><path d="M73 15 C 95 -4, 128 12, 136 60" stroke-dasharray="3 5"/>${CAR(118, 18, 140)}<path d="M128 70 v-8 M136 70 v-8 M144 70 v-8" class="led"/><path d="M110 76 H156"/>`),
  kickflip: wrap(`<path d="M8 76 H34 Q46 74 52 64 V76"/><rect x="72" y="52" width="22" height="24" rx="2"/><rect x="96" y="62" width="14" height="14" rx="2"/><rect x="58" y="64" width="12" height="12" rx="2"/><path d="M52 62 C 70 10, 110 6, 140 72" stroke-dasharray="3 5"/>${CAR(96, 20, 180)}<path d="M84 8 a12 12 0 1 1 -6 22" class="led"/><path d="M76 26 l2 5 l5 -2" class="led"/><path d="M114 76 H156"/>`),
  zero60: wrap(`<path d="M10 76 H156"/><path d="M14 30 H40 V76 M14 30 V76" /><path class="led" d="M18 40 V70 M24 40 V70 M30 40 V70"/>${CAR(62, 70, 0)}<path d="M76 66 H120 M80 72 H140 M86 60 H110" stroke-width="1.5" opacity=".7"/><text x="112" y="36" font-size="18" fill="currentColor" stroke="none" font-family="RFT Display">0,81</text>`),
  ground_flip: wrap(`<path d="M8 76 H156"/>${CAR(80, 30, 120)}<path d="M80 6 a26 26 0 1 1 -24 36" class="led"/><path d="M54 34 l2 8 l7 -4" class="led"/><path d="M70 74 l-3 -8 M80 74 v-9 M90 74 l3 -8" stroke-width="1.5" opacity=".7"/>`),
};

export const ASSIST_ICONS = {
  ASSIST: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="24" cy="24" r="18"/><path d="M14 25 l7 7 l13 -15" class="led"/></svg>',
  STABILIZED: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="24" cy="24" r="18"/><path d="M8 24 H40 M24 8 V40" opacity=".5"/><path d="M24 24 L34 16" class="led"/></svg>',
  RAW: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="24" cy="24" r="18"/><path d="M16 18 l8 6 l-8 6 M26 30 h8" class="led"/></svg>',
} as const;

// ------------------------------------------------------------------ worlds (Phase 2)
const W = (body: string) =>
  `<svg viewBox="0 0 160 84" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const WORLD_ICONS: Record<SiteId, string> = {
  earth_mcgregor: W(`<path d="M6 76 H154"/><path d="M60 76 H80 A22 22 0 0 0 102 54 V34 A7 7 0 0 0 95 27"/><path class="led" d="M60 79 H80"/><path d="M128 76 V22 M122 22 h12 M123 18 h10" /><circle cx="128" cy="16" r="9" class="glow" stroke="none"/><path d="M14 76 l10 -10 h18 l6 10" opacity=".7"/>`),
  earth_stonehenge: W(`<path d="M6 76 H154"/><path d="M30 76 V44 M44 76 V44 M26 44 H48"/><path d="M66 76 V38 M82 76 V38 M62 38 H86"/><path d="M104 76 V46 M118 76 V46 M100 46 H122"/><path d="M134 76 V58 M142 76 V60" opacity=".6"/><circle cx="20" cy="18" r="6" class="led"/>`),
  earth_giza: W(`<path d="M6 76 H154"/><path d="M26 76 L62 30 L98 76"/><path d="M62 30 L70 76" opacity=".45"/><path d="M84 76 L112 42 L140 76"/><path d="M112 42 L118 76" opacity=".45"/><path d="M128 76 L142 60 L156 76" opacity=".7"/><circle cx="134" cy="16" r="7" class="led"/>`),
  moon_tranquility: W(`<path d="M6 70 Q60 64 154 70"/><path d="M66 62 l6 -14 h16 l6 14 M72 48 l4 -10 h8 l4 10 M60 66 l8 -6 M100 66 l-8 -6"/><path d="M110 62 V44 M110 44 h12 v8 h-12" class="led"/><circle cx="28" cy="20" r="8" opacity=".8"/><path d="M24 18 a3 3 0 0 0 6 4" opacity=".6"/>`),
  moon_hadley: W(`<path d="M6 60 Q40 56 62 62 Q74 76 92 74 Q110 72 120 60 Q140 56 154 58"/><path d="M62 62 Q74 70 92 68 Q108 66 120 60" opacity=".45"/><path d="M10 60 L30 34 L52 58 M110 58 L132 30 L152 56" opacity=".7"/><circle cx="80" cy="16" r="6" class="led"/>`),
  moon_shackleton: W(`<path d="M6 72 Q30 48 70 46 Q110 46 154 70"/><path d="M40 58 Q80 64 120 58" opacity=".45"/><circle cx="130" cy="34" r="10"/><path d="M122 32 q8 -6 16 2" opacity=".6"/><path d="M6 46 H154" stroke-dasharray="2 6" class="led"/>`),
  mars_jezero: W(`<path d="M6 70 Q50 60 154 70"/><path d="M40 66 Q70 40 80 30 M80 30 Q92 44 96 64 M80 30 Q84 50 72 66 M80 30 Q100 48 118 64" opacity=".8"/><path d="M80 30 V12" class="led"/><circle cx="132" cy="18" r="4" opacity=".7"/>`),
  mars_gale: W(`<path d="M6 74 H40 Q60 70 74 44 Q82 30 90 28 Q100 30 108 46 Q120 68 154 74"/><path d="M6 60 Q20 50 36 56 M120 56 Q140 48 154 54" opacity=".5"/><path d="M50 74 l8 -6 h10 l6 6" class="led"/>`),
  mars_valles: W(`<path d="M6 30 H48 L60 74 H100 L112 30 H154"/><path d="M60 74 L66 50 M100 74 L94 50" opacity=".45"/><path d="M48 30 Q80 22 112 30" stroke-dasharray="3 5" class="led"/>`),
  space_sun: W(`<circle cx="30" cy="42" r="16" class="led"/><circle cx="30" cy="42" r="26" opacity=".25"/><path d="M60 64 Q100 30 150 26" stroke-dasharray="2 5" opacity=".6"/><g transform="translate(112 40) rotate(-18)"><rect x="-14" y="-4" width="28" height="8" rx="3" fill="currentColor" stroke="none"/><circle cx="-8" cy="5" r="3" fill="#000"/><circle cx="8" cy="5" r="3" fill="#000"/><path d="M-2 -4 v-6" /></g><circle cx="142" cy="66" r="2" fill="currentColor" stroke="none"/><circle cx="74" cy="14" r="1.5" fill="currentColor" stroke="none"/>`),
};

/** Small planet discs for the body tabs. */
export const BODY_ICONS: Record<string, string> = {
  earth: '<svg viewBox="0 0 24 24"><defs><radialGradient id="bi-e" cx="35%" cy="35%"><stop offset="0" stop-color="#9cc6ff"/><stop offset="1" stop-color="#1f4f8c"/></radialGradient></defs><circle cx="12" cy="12" r="10" fill="url(#bi-e)"/><path d="M6 9 q3 -3 6 0 t5 2 M8 15 q4 2 7 -1" stroke="#cfe8c8" stroke-width="1.4" fill="none" opacity=".8"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><defs><radialGradient id="bi-m" cx="35%" cy="35%"><stop offset="0" stop-color="#e8e8e8"/><stop offset="1" stop-color="#6e6e6e"/></radialGradient></defs><circle cx="12" cy="12" r="10" fill="url(#bi-m)"/><circle cx="9" cy="10" r="2" fill="#8a8a8a"/><circle cx="15" cy="15" r="1.5" fill="#8a8a8a"/></svg>',
  mars: '<svg viewBox="0 0 24 24"><defs><radialGradient id="bi-r" cx="35%" cy="35%"><stop offset="0" stop-color="#f2a073"/><stop offset="1" stop-color="#8a2f12"/></radialGradient></defs><circle cx="12" cy="12" r="10" fill="url(#bi-r)"/><path d="M6 13 q6 -2 12 1" stroke="#5d1f0b" stroke-width="1.2" fill="none" opacity=".7"/></svg>',
  space: '<svg viewBox="0 0 24 24"><defs><radialGradient id="bi-s" cx="50%" cy="50%"><stop offset="0" stop-color="#fff6d8"/><stop offset=".55" stop-color="#ffb347"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient></defs><circle cx="12" cy="12" r="11" fill="url(#bi-s)"/><circle cx="12" cy="12" r="6" fill="#ffd27a"/></svg>',
};
