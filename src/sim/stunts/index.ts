// Stunt registry.
import type { StuntId } from '@shared/types';
import type { RoadsterSim } from '../core/roadsterSim';
import type { Stunt, StuntOptions } from './base';
import { GroundFlipStunt } from './groundFlip';
import { KickflipStunt } from './kickflip';
import { RampHangStunt } from './rampHang';
import { RampLaunchStunt } from './rampLaunch';
import { Zero60Stunt } from './zero60';

export * from './base';
export { TUNING } from './tuning';

export function createStunt(id: StuntId, sim: RoadsterSim, opts: StuntOptions = {}): Stunt {
  switch (id) {
    case 'kickflip': return new KickflipStunt(sim, opts);
    case 'ground_flip': return new GroundFlipStunt(sim, opts);
    case 'ramp_hang': return new RampHangStunt(sim, opts);
    case 'ramp_launch': return new RampLaunchStunt(sim, opts);
    case 'zero60': return new Zero60Stunt(sim, opts);
  }
}

export { GroundFlipStunt, KickflipStunt, RampHangStunt, RampLaunchStunt, Zero60Stunt };
export * from './validation';
