import { describe, expect, it } from 'vitest';
import { altitude, downforce, fmtAdaptive, gForce, pitch, pressure, speed, streamTimer } from '../../src/ui/units';
import { FT, MPH } from '../../src/shared/math';

describe('units & formatting (stream style)', () => {
  it('adaptive decimals like the stream', () => {
    expect(fmtAdaptive(20.8)).toBe('20.8');
    expect(fmtAdaptive(69)).toBe('69.0');
    expect(fmtAdaptive(98.24)).toBe('98.2');
    expect(fmtAdaptive(170)).toBe('170');
    expect(fmtAdaptive(99.96)).toBe('100');
    expect(fmtAdaptive(-0.02)).toBe('0.0');
    expect(fmtAdaptive(-12.34)).toBe('-12.3');
    expect(fmtAdaptive(NaN)).toBe('--');
  });
  it('altitude ft <-> m', () => {
    expect(altitude(21.0312, 'imperial')).toEqual({ value: '69.0', unit: 'FT' });
    expect(altitude(21.0312, 'metric')).toEqual({ value: '21.0', unit: 'M' });
    expect(altitude(25 * FT, 'imperial').value).toBe('25.0');
  });
  it('speed mph <-> km/h', () => {
    expect(speed(60 * MPH, 'imperial')).toEqual({ value: '60', unit: 'MPH' });
    expect(speed(100 / 3.6, 'metric')).toEqual({ value: '100', unit: 'KM/H' });
  });
  it('downforce stays kg in both systems, never negative', () => {
    expect(downforce(4697.4)).toEqual({ value: '4697', unit: 'KG' });
    expect(downforce(-5)).toEqual({ value: '0', unit: 'KG' });
  });
  it('g, pitch, pressure', () => {
    expect(gForce(3.46).value).toBe('3.5');
    expect(pitch(170).value).toBe('170');
    expect(pressure(690, 'metric')).toEqual({ value: '690', unit: 'BAR' });
    expect(pressure(689.476, 'imperial')).toEqual({ value: '10,000', unit: 'PSI' });
  });
  it('0-60 timer HH:MM:SS:CC', () => {
    expect(streamTimer(0)).toBe('00:00:00:00');
    expect(streamTimer(0.81)).toBe('00:00:00:81');
    expect(streamTimer(1)).toBe('00:00:01:00');
    expect(streamTimer(61.234)).toBe('00:01:01:23');
    expect(streamTimer(-1)).toBe('00:00:00:00');
  });
});
