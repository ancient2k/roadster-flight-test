// Starship launch: flight profile, time lapse, ticker schedule and catch logic (src/shared/starshipFlight.ts).
import { describe, expect, it } from 'vitest';
import {
  ASCENT, BOOSTER, BOOSTER_CATCH_T, BOOSTER_LEN, CATCH_ALERT_S, ENTRY_T, EVENTS, SECO_T, SEP_T, SHIP_CATCH_T, SHIP_RETURN, WARP,
  armsAt, blastDv, BLAST_RADIUS_M, boosterState, eventsBetween, gameAt, metAt, returnsIn, shipState, toWorld, warpAt,
} from '../../src/shared/starshipFlight';

const kmh = (ms: number) => ms * 3.6;

describe('Starship flight profile', () => {
  it('ascent after the public Flight 5 numbers: Max-Q, MECO, SECO', () => {
    const maxq = boosterState(62);
    expect(maxq.h).toBeGreaterThan(8000); expect(maxq.h).toBeLessThan(13000);
    const meco = boosterState(161);
    expect(meco.h / 1000).toBeGreaterThan(60); expect(meco.h / 1000).toBeLessThan(75);
    expect(kmh(meco.speed)).toBeGreaterThan(5000); expect(kmh(meco.speed)).toBeLessThan(6500);
    expect(meco.engines).toBe(3);
    const seco = shipState(SECO_T);
    expect(kmh(seco.speed)).toBeGreaterThan(26000);
    expect(seco.h / 1000).toBeGreaterThan(150);
    expect(boosterState(10).engines).toBe(33);
    expect(boosterState(-5).engines).toBe(0);
    expect(boosterState(-2).engines).toBe(33);
  });

  it('tracks are continuous and smooth (no jumps between keys or at staging)', () => {
    for (const [name, f, t0, t1] of [
      ['booster', boosterState, 0, BOOSTER_CATCH_T], ['ship up', shipState, 0, SECO_T], ['ship back', shipState, ENTRY_T, SHIP_CATCH_T],
    ] as const) {
      let prev = f(t0);
      for (let t = t0 + 0.25; t <= t1; t += 0.25) {
        const s = f(t);
        // the step agrees with the velocity (no teleport), within the Hermite curvature
        const step = Math.hypot(s.h - prev.h, s.d - prev.d), v = Math.max(s.speed, prev.speed);
        expect(step, `${name} t=${t}`).toBeLessThan(v * 0.25 * 1.6 + 1);
        prev = s;
      }
    }
    // the ship leaves the top of the stack, ≈ BOOSTER_LEN away from the booster base
    const b = boosterState(SEP_T + 0.01), s = shipState(SEP_T + 0.01);
    expect(Math.hypot(s.h - b.h, s.d - b.d)).toBeCloseTo(BOOSTER_LEN, -1);
  });

  it('never goes below its origin before the catch, and the stages separate after staging', () => {
    for (let t = 0; t < BOOSTER_CATCH_T; t += 0.5) expect(boosterState(t).h).toBeGreaterThan(-1);
    for (let t = ENTRY_T; t < SHIP_CATCH_T; t += 0.5) expect(shipState(t).h).toBeGreaterThan(-1);
    for (let t = SEP_T + 5; t < 300; t += 5) {
      const b = boosterState(t), s = shipState(t);
      expect(Math.hypot(s.h - b.h, s.d - b.d)).toBeGreaterThan(BOOSTER_LEN + 200);
    }
  });

  it('booster: boostback reverses it, the landing burn slows it, caught at ≈ T+7 min at the tower', () => {
    expect(boosterState(170).vd).toBeGreaterThan(1000);
    expect(boosterState(240).vd).toBeLessThan(-500);
    const apogee = Math.max(...Array.from({ length: 200 }, (_, i) => boosterState(SEP_T + i).h));
    expect(apogee / 1000).toBeGreaterThan(85); expect(apogee / 1000).toBeLessThan(110);
    expect(BOOSTER_CATCH_T / 60).toBeGreaterThan(6.5); expect(BOOSTER_CATCH_T / 60).toBeLessThan(7.5);
    const near = boosterState(BOOSTER_CATCH_T - 0.5);
    expect(near.speed).toBeLessThan(3);
    expect(Math.hypot(near.h, near.d)).toBeLessThan(5);
    expect(Math.abs(near.tilt)).toBeLessThan(1);
    const c = boosterState(BOOSTER_CATCH_T + 100);
    expect(c.caught).toBe(true); expect(c.h).toBe(0); expect(c.d).toBe(0); expect(c.engines).toBe(0);
    expect(boosterState(397).engines).toBe(13);
    expect(boosterState(405).engines).toBe(3);
    // the booster comes back over the sea (east of the pad), not over the build field
    for (let t = 240; t < BOOSTER_CATCH_T - 5; t += 1) expect(boosterState(t).d).toBeGreaterThan(-5);
  });

  it('ship: orbit, entry from the west after one revolution, flip and catch at tower B', () => {
    const o = shipState(2000);
    expect(o.phase).toBe('orbit'); expect(o.hidden).toBe(true);
    const e = shipState(ENTRY_T);
    expect(e.fromB).toBe(true); expect(e.d).toBeLessThan(-2_000_000);
    expect(shipState(5800).tilt).toBeGreaterThan(85);                 // belly flop
    expect(Math.abs(shipState(5915).tilt)).toBeLessThan(5);          // vertical after the flip
    expect(shipState(5910).engines).toBe(3);
    const near = shipState(SHIP_CATCH_T - 0.5);
    expect(near.speed).toBeLessThan(3);
    expect(Math.hypot(near.h, near.d)).toBeLessThan(5);
    expect(shipState(SHIP_CATCH_T + 1).caught).toBe(true);
    // one orbit at least between orbit insertion and the catch (≈ 88 min at 170 km)
    expect((SHIP_CATCH_T - SECO_T) / 60).toBeGreaterThan(88);
    for (let t = ENTRY_T; t < SHIP_CATCH_T - 10; t += 1) expect(shipState(t).vd).toBeGreaterThan(0); // flies east all the way
  });

  it('keys are in time order', () => {
    for (const k of [ASCENT, BOOSTER, SHIP_RETURN]) for (let i = 1; i < k.length; i++) expect(k[i].t).toBeGreaterThan(k[i - 1].t);
  });
});

describe('time lapse', () => {
  it('real time until the booster catch and SECO, then faster; game ↔ MET round trip', () => {
    expect(metAt(BOOSTER_CATCH_T)).toBe(BOOSTER_CATCH_T);
    expect(metAt(SECO_T)).toBe(SECO_T);
    expect(warpAt(3000)).toBeGreaterThan(20);
    expect(warpAt(SHIP_CATCH_T - CATCH_ALERT_S)).toBe(1);   // the ship's last minute in real time
    for (const m of [-20, 0, 100, 539, 541, 2000, 4800, 5000, 5605, 5841, 5925, 7000]) expect(metAt(gameAt(m))).toBeCloseTo(m, 6);
    const total = gameAt(SHIP_CATCH_T);
    expect(total / 60).toBeGreaterThan(10); expect(total / 60).toBeLessThan(16);  // the whole show in ≤ a quarter hour
    for (let i = 1; i < WARP.length; i++) expect(WARP[i][0]).toBeGreaterThan(WARP[i - 1][0]);
  });
});

describe('ticker and catch alerts', () => {
  it('all stream messages, in MET order, each catch announced 30 s before', () => {
    const msgs = EVENTS.map((e) => e.msg);
    for (const m of ['liftoff', 'maxq', 'meco', 'sep', 'boostback', 'seco', 'reentry', 'catchAttempt', 'caught', 'alert'] as const) expect(msgs).toContain(m);
    for (let i = 1; i < EVENTS.length; i++) expect(EVENTS[i].met).toBeGreaterThanOrEqual(EVENTS[i - 1].met);
    for (const [stage, c] of [['booster', BOOSTER_CATCH_T], ['ship', SHIP_CATCH_T]] as const) {
      const a = EVENTS.find((e) => e.msg === 'alert' && e.stage === stage)!;
      expect(gameAt(c) - gameAt(a.met)).toBeCloseTo(CATCH_ALERT_S, 6);
      expect(EVENTS.find((e) => e.msg === 'caught' && e.stage === stage)!.met).toBe(c);
    }
    expect(eventsBetween(-1, 0.5).map((e) => e.msg)).toEqual(['liftoff']);
    expect(eventsBetween(0, 0)).toEqual([]);
  });

  it('"returns in" counts down in game seconds while a stage is on its way back', () => {
    expect(returnsIn('booster', 100)).toBeNull();
    expect(returnsIn('booster', 300)).toBeCloseTo(BOOSTER_CATCH_T - 300, 6);
    expect(returnsIn('booster', BOOSTER_CATCH_T)).toBeNull();
    expect(returnsIn('ship', 300)).toBeNull();
    const r = returnsIn('ship', 1000)!;
    expect(r).toBeGreaterThan(0); expect(r).toBeLessThan(gameAt(SHIP_CATCH_T));
    expect(returnsIn('ship', SHIP_CATCH_T - 10)).toBeCloseTo(10, 6);
  });
});

describe('catch arms and pressure wave', () => {
  it('arms open until 2.5 s before the catch, closed on the pins at it; the carriage gives and settles', () => {
    expect(armsAt(0, BOOSTER_CATCH_T)).toEqual({ open: 1, dy: 0 });
    expect(armsAt(BOOSTER_CATCH_T - 1, BOOSTER_CATCH_T).open).toBeGreaterThan(0);
    expect(armsAt(BOOSTER_CATCH_T - 1, BOOSTER_CATCH_T).open).toBeLessThan(1);
    expect(armsAt(BOOSTER_CATCH_T, BOOSTER_CATCH_T).open).toBe(0);
    const dips = Array.from({ length: 60 }, (_, i) => armsAt(BOOSTER_CATCH_T + i * 0.1, BOOSTER_CATCH_T).dy);
    expect(Math.min(...dips)).toBeLessThan(-1.2);
    expect(Math.min(...dips)).toBeGreaterThan(-2.5);
    expect(armsAt(BOOSTER_CATCH_T + 30, BOOSTER_CATCH_T).dy).toBeCloseTo(-1.2, 2);
  });

  it('pressure wave: strongest at the mount, nothing outside the exclusion ring', () => {
    expect(blastDv(0)).toBeGreaterThan(15);
    expect(blastDv(200)).toBeLessThan(blastDv(50));
    expect(blastDv(BLAST_RADIUS_M)).toBe(0);
    expect(blastDv(5000)).toBe(0);
  });

  it('world placement: east along the azimuth, the Earth curving away', () => {
    const p = toWorld({ x: 0, y: 0, z: 0 }, 100_000, 0);
    expect(p.x).toBeGreaterThan(99_000);
    expect(p.z).toBeGreaterThan(0);          // 97°: a little south of east (+Z = south)
    expect(p.y).toBeLessThan(-700);          // ≈ 785 m drop at 100 km
  });
});
