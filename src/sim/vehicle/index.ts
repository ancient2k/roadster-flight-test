// public API: ground-vehicle physics as ForceModules for the shared RoadsterSim kernel.
import { RoadsterSim, type ForceModule, type RoadsterSimOptions } from '@sim/core/roadsterSim';
import { VehicleBus } from './bus';
import { ChassisModule } from './chassis';
import { FanModule } from './fans';
import { AeroModule } from './aero';
import { IntegrityModule } from './integrity';

export { ChassisModule, Wheel, steerLimitRad, damperForce, bumpStopForce, hydraulicStopForce } from './chassis';
export { FanModule, plenumEquilibrium, skirtRect } from './fans';
export { AeroModule, aeroCoeffs } from './aero';
export { IntegrityModule, type LandingEvent } from './integrity';
export { VehicleBus } from './bus';
export * as tire from './tire';
export { SURFACES, surfaceAt, surfaceAtPoint, type SurfaceParams, type SoilParams } from './surfaces';

export interface VehicleModules {
  bus: VehicleBus;
  aero: AeroModule;
  fans: FanModule;
  chassis: ChassisModule;
  integrity: IntegrityModule;
  /** In application order (aero + fans before chassis: the accel governor feeds forward ctx.acc). */
  list: ForceModule[];
}

export function createVehicleModuleSet(): VehicleModules {
  const bus = new VehicleBus();
  const aero = new AeroModule(bus);
  const fans = new FanModule(bus);
  const chassis = new ChassisModule(bus);
  const integrity = new IntegrityModule(chassis);
  return { bus, aero, fans, chassis, integrity, list: [aero, fans, chassis, integrity] };
}

/** Fresh module instances for one RoadsterSim (do not share between sims). */
export function createVehicleModules(): ForceModule[] { return createVehicleModuleSet().list; }

/** Typed access to the modules of a sim created with createRoadsterSim / createVehicleModules. */
export function vehicleModules(sim: RoadsterSim): { aero: AeroModule; fans: FanModule; chassis: ChassisModule; integrity: IntegrityModule } {
  const find = <T>(name: string) => sim.modules.find((m) => m.name === name) as T;
  return { aero: find('aero'), fans: find('fans'), chassis: find('chassis'), integrity: find('integrity') };
}

export function createRoadsterSim(opts: Omit<RoadsterSimOptions, 'modules'> = {}): Promise<RoadsterSim> {
  return RoadsterSim.create({ ...opts, modules: createVehicleModules() });
}
