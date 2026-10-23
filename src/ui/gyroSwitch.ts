// Tilt steering on/off from a tap (Settings -> Controls toggle and the touch HUD's TILT button).
// enable() must start inside the tap (iOS permission prompt); the setting is stored only once the
// sensor delivers, so a denied or missing sensor leaves the option off.
import type { GyroInput, GyroResult } from '../input/gyroSensor';
import type { MsgKey } from '../i18n';
import type { SettingsStore } from './settings';

export function switchGyro(gyro: GyroInput, settings: SettingsStore, on: boolean): Promise<GyroResult> {
  if (!on) {
    gyro.disable();
    settings.update((d) => { d.controls.gyro = false; }, 'controls.gyro');
    return Promise.resolve('ok');
  }
  return gyro.enable().then((r) => {
    settings.update((d) => { d.controls.gyro = r === 'ok'; }, 'controls.gyro');
    return r;
  });
}

/** Hint for a failed switch-on. */
export function gyroFailText(r: GyroResult): MsgKey | null {
  return r === 'denied' ? 'gyro.denied' : r === 'unsupported' ? 'gyro.unsupported' : null;
}
