// Driving physics setting (Settings → Simulation). 'realistic' is the plain model. 'fun' (default in free play) adds
// the helpers sim-arcade games use on crashes: walls guide a glancing car along instead of braking it, the spin
// after a hard hull impact is damped for a moment, and contacts give no rebound beyond stopping the car. The auto
// stunts and the demo always run 'realistic' (they reproduce the stream). Implementation: RoadsterSim.handling.
export type HandlingMode = 'fun' | 'realistic';
export const HANDLING_MODES: readonly HandlingMode[] = ['fun', 'realistic'];
