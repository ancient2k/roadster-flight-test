// Emergency landing with a known stuck-closed corner jet: time history.
//   FAULT=4 Y0=10.45 npx vitest run --config tools/gnc/vitest.config.ts tools/gnc/fault.tool.ts
import { it } from 'vitest';
import { qrot, v3, hudPitchDeg } from '../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../src/shared/types';
import { createRoadsterSim } from '../../src/sim/vehicle';
import { FlightControl, newFlightCommand } from '../../src/sim/gnc/flight';
import { Lander } from '../../src/sim/gnc/guidance';
import { Estimator } from '../../src/sim/gnc/estimator';
import { setSpinRate } from '../../src/sim/gnc/flight';

it('known valve fault landing', async () => {
  const sim = await createRoadsterSim();
  const fault = Number(process.env.FAULT ?? 4), y0 = Number(process.env.Y0 ?? 10.45);
  if (process.env.SPIN) setSpinRate(Number(process.env.SPIN));
  sim.reset({ pos: v3(0, y0, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
  for (let i = 0; i < 10; i++) sim.propulsion.valves.setFault(i, i === fault ? -1 : 0);
  sim.step(neutralDrive(), neutralSystems(), zeroThrust());
  const fc = new FlightControl(sim), est = new Estimator(null), cmd = newFlightCommand(), lander = new Lander();
  fc.valveFault[fault] = -1;
  const thr = zeroThrust(), drive = neutralDrive(), sys = neutralSystems();
  const lines: string[] = [];
  for (let k = 0; k < 240 * 12; k++) {
    const e = est.update(sim.getState());
    fc.refresh(e);
    lander.maxDecel = fc.liftReserveAccel();
    lander.update(e, fc.mp, cmd);
    fc.compute(e, cmd, thr.duty);
    fc.observe(thr.duty);
    sim.step(drive, sys, thr);
    const s = sim.getState();
    if (k % 12 === 0) {
      const tel = sim.telemetry();
      lines.push(`${s.t.toFixed(2)} h ${(e.height - 0.45).toFixed(2)} vy ${s.linVel.y.toFixed(2)} vref ${lander.vref.toFixed(2)} aCmd ${lander.aCmd.toFixed(2)} pitch ${hudPitchDeg(s.quat).toFixed(1)} roll ${tel.rollDeg.toFixed(1)} upY ${qrot(s.quat, v3(0, 1, 0)).y.toFixed(3)} w ${Math.hypot(s.angVel.x, s.angVel.y, s.angVel.z).toFixed(2)} air ${s.tank.airMassKg.toFixed(1)} p ${tel.tankPressureBar.toFixed(0)} cmdD ${Array.from(thr.duty).map((d) => d.toFixed(2)).join(',')} act ${tel.thrusterDuty.map((d) => d.toFixed(2)).join(',')} reserve ${fc.liftReserveAccel().toFixed(2)}`);
    }
    if (s.bodyContact || s.groundContact) { lines.push(`TOUCH vy ${s.linVel.y.toFixed(2)} t ${s.t.toFixed(2)} crashed ${s.crashed} yaw rate ${s.angVel.y.toFixed(2)}`); break; }
  }
  // after touchdown: jets off, brakes on, 3 s
  const brake = { ...neutralDrive(), brake: 1 };
  let maxTilt = 0;
  for (let k = 0; k < 240 * 3; k++) { sim.step(brake, sys, zeroThrust()); maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, qrot(sim.getState().quat, v3(0, 1, 0)).y)) * 57.3); }
  const s = sim.getState();
  lines.push(`AFTER 3 s: crashed ${s.crashed} max tilt ${maxTilt.toFixed(1)}° yaw rate ${s.angVel.y.toFixed(2)} pos ${s.pos.x.toFixed(2)},${s.pos.z.toFixed(2)} speed ${Math.hypot(s.linVel.x, s.linVel.z).toFixed(2)}`);
  console.log(lines.join('\n'));
});
