import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODIES, bodyFacts, gravityText, sitesOf } from '../../src/ui/worlds';
import { WORLD_ICONS, BODY_ICONS } from '../../src/ui/menu/icons';
import { ENVIRONMENTS } from '../../src/shared/environment';
import { BODY_NAMES, SITES } from '../../src/shared/worlds';
import { setLocale } from '../../src/i18n';

describe('worlds menu, derived from src/shared/worlds.ts', () => {
  it('bodies in tab order with names from the shared contract', () => {
    expect(BODIES.map((b) => b.id)).toEqual(['earth', 'moon', 'mars', 'space']);
    for (const b of BODIES) { expect(b.label).toBe(BODY_NAMES[b.id]); expect(ENVIRONMENTS[b.id]).toBeDefined(); expect(BODY_ICONS[b.id]).toBeTruthy(); }
  });
  it('every shared site appears exactly once under its body, availability comes from SITES', () => {
    const listed = BODIES.flatMap((b) => sitesOf(b.id));
    expect(listed.map((s) => s.id).sort()).toEqual(SITES.map((s) => s.id).sort());
    expect(sitesOf('earth').map((s) => s.id)).toEqual(['earth_mcgregor', 'earth_stonehenge', 'earth_giza', 'earth_bocachica']);
    expect(sitesOf('space').map((s) => s.id)).toEqual(['space_sun']);
    for (const s of listed) expect(s).toBe(SITES.find((x) => x.id === s.id)); // same objects, no copy
  });
  it('every site has an icon', () => {
    for (const s of SITES) expect(WORLD_ICONS[s.id], s.id).toBeTruthy();
  });
  it('gravity text per site card', () => {
    expect(gravityText('moon')).toBe('1.62 m/s² · 0.17 g');
    expect(gravityText('earth')).toBe('9.81 m/s² · 1.00 g');
    expect(gravityText('mars')).toBe('3.72 m/s² · 0.38 g');
    expect(gravityText('space')).toBe('0 m/s² · weightless');
  });
  it('physics facts from the environment contract', () => {
    expect(bodyFacts('earth').map((f) => f.value)).toEqual(['1.00 g', '1.01 bar', '100%', 'yes']);
    expect(bodyFacts('mars')[1].value).toBe('610 Pa');
    expect(bodyFacts('mars')[2].value).toBe('1.7%');
    expect(bodyFacts('moon')[2].value).toBe('–');
  });
  it('site texts and coordinates follow the locale', () => {
    const giza = SITES.find((s) => s.id === 'earth_giza')!;
    expect(giza.name).toBe('Giza Plateau');
    expect(giza.coords).toBe('29.9792° N 31.1342° E');
    expect(SITES.find((s) => s.id === 'mars_valles')!.coords).toBe('13.5° S 61° W');
    expect(SITES.find((s) => s.id === 'space_sun')!.coords).toBe('Heliocentric orbit, ~1.0–1.66 AU');
  });
});

describe('worlds in German', () => {
  beforeAll(() => setLocale('de'));
  afterAll(() => setLocale('en'));
  it('the original German texts and number format', () => {
    expect(gravityText('moon')).toBe('1,62 m/s² · 0,17 g');
    expect(gravityText('space')).toBe('0 m/s² · schwerelos');
    expect(bodyFacts('earth').map((f) => f.value)).toEqual(['1,00 g', '1,01 bar', '100\u00a0%', 'ja']);
    expect(BODIES[0].label).toBe('Erde');
    expect(bodyFacts('mars')[2].value).toBe('1,7\u00a0%'); // Intl puts a no-break space before % in German
    const giza = SITES.find((s) => s.id === 'earth_giza')!;
    expect(giza.name).toBe('Gizeh-Plateau');
    expect(giza.coords).toBe('29,9792° N 31,1342° O');
    expect(SITES.find((s) => s.id === 'space_sun')!.coords).toBe('Heliozentrische Bahn, ~1,0–1,66 AE');
  });
});
