// public API: ground-vehicle physics as ForceModules for the shared RoadsterSim kernel.
import { RoadsterSim, type ForceModule, type RoadsterSimOptions } from '@sim/core/roadsterSim';
import { VehicleBus } from './bus';
import { ChassisModule } from './chassis';
import { FanModule } from './fans';
import { AeroModule } from './aero';
import { IntegrityModule } from './integrity';
import { DamageModule } from './damage';
import type { DamageMode } from '@shared/damage';

export { ChassisModule, Wheel, steerLimitRad, damperForce, bumpStopForce, hydraulicStopForce } from './chassis';
export { FanModule, plenumEquilibrium, skirtRect } from './fans';
export { AeroModule, aeroCoeffs } from './aero';
export { IntegrityModule, type LandingEvent } from './integrity';
export { VehicleBus, DamageFactors } from './bus';
export { DamageModule, crushFromEnergy, energyForCrush, CRUSH } from './damage';
export * as tire from './tire';
export { SURFACES, surfaceAt, surfaceAtPoint, type SurfaceParams, type SoilParams } from './surfaces';

export interface VehicleModules {
  bus: VehicleBus;
  aero: AeroModule;
  fans: FanModule;
  chassis: ChassisModule;
  integrity: IntegrityModule;
  damage: DamageModule;
  /** In application order (aero + fans before chassis: the accel governor feeds forward ctx.acc). */
  list: ForceModule[];
}

export function createVehicleModuleSet(): VehicleModules {
  const bus = new VehicleBus();
  const aero = new AeroModule(bus);
  const fans = new FanModule(bus);
  const chassis = new ChassisModule(bus);
  const integrity = new IntegrityModule(chassis);
  const damage = new DamageModule(bus, integrity);
  return { bus, aero, fans, chassis, integrity, damage, list: [aero, fans, chassis, integrity, damage] };
}

/** Fresh module instances for one RoadsterSim (do not share between sims). */
export function createVehicleModules(): ForceModule[] { return createVehicleModuleSet().list; }

/** Typed access to the modules of a sim created with createRoadsterSim / createVehicleModules. */
export function vehicleModules(sim: RoadsterSim): { aero: AeroModule; fans: FanModule; chassis: ChassisModule; integrity: IntegrityModule; damage: DamageModule } {
  const find = <T>(name: string) => sim.modules.find((m) => m.name === name) as T;
  return { aero: find('aero'), fans: find('fans'), chassis: find('chassis'), integrity: find('integrity'), damage: find('damage') };
}

/** Vehicle damage setting of a sim (takes full effect with the next reset = repair). No-op without the module. */
export function setDamageMode(sim: RoadsterSim, mode: DamageMode): void {
  (sim.modules.find((m) => m.name === 'damage') as DamageModule | undefined)?.setMode(sim, mode);
}

export function createRoadsterSim(opts: Omit<RoadsterSimOptions, 'modules'> = {}): Promise<RoadsterSim> {
  return RoadsterSim.create({ ...opts, modules: createVehicleModules() });
}
