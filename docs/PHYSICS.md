# Physics, control and validation

Everything runs in the browser at a fixed physics step of 1/240 s (Rapier 0.21 for rigid bodies and contacts,
custom TypeScript for everything else). Body frame: +X left, +Y up, +Z forward, origin at the dry centre of gravity.

## Sources and parameter provenance

The single source of truth is the parameter register `src/shared/roadster.ts`. Every value carries a tag:

| Tag | Meaning |
|---|---|
| `[VIDEO]` | stated or shown in the official Tesla live stream of 15 October 2026 (McGregor, Texas) |
| `[PRESS]` | press coverage of the event (Electrek, The Next Web, PBS NewsHour) |
| `[REVIEW]` | value proposed or checked in an external second-opinion engineering review |
| `[EST]` | engineering estimate or tuning, where nothing public exists |
| `[TOOL]` | result of a tuning sweep in `tools/gnc/` |

Facts from the stream used here: two carbon-overwrapped pressure vessels of 600 L in total, ≈ 250 kg of air at
≈ 690 bar (10,000 psi), ten nozzles (attitude jets plus four rear main jets, > 80 kN), fan suction up to 2 g,
high-downforce and low-drag aero modes with a variable-pitch rear wing, 0–60 mph in 0.81 s.
Press figures: mass < 1,700 kg, four fans of ≈ 20 kW. The stream HUD values (downforce, pitch, altitude, g) are
the reference for the stunt validation (`src/shared/reference.ts`).

## Propulsion: tank, regulator, nozzles, valves

- **Tank** (`src/sim/core/tank.ts`): both vessels as one open thermodynamic system with the Abel–Noble equation
  of state `p = ρRT / (1 − bρ)`, mass and energy balance including heat exchange with the vessel wall. Blowdown
  cools the gas; the wall slowly warms it again.
- **Regulator:** feeds all nozzles at a set point with a flow limit (droop) and line losses.
- **Nozzles** (`nozzle.ts`, `gas.ts`): converging–diverging, choked flow, isentropic expansion and pressure thrust;
  the throat is sized for the nominal thrust at the regulator set point, so thrust and mass flow follow the feed
  state and the ambient pressure (Earth, Mars, vacuum).
- **Valves** (`valves.ts`): opening and closing delays, minimum on-time and PWM — the controller sees the
  quantised impulse it really gets.
- **Compressor:** refills the tank on the ground (slowly, as stated in the stream).

## Fan suction ("fan car")

`src/sim/vehicle/fans.ts`: four fans, each evacuating one quadrant of the sealed underbody. Per plenum the fan
curve (affinity laws), the skirt leak `Q = Cd · Σ(l·h) · √(2Δp/ρ)` with the gap heights sampled by rays along the
skirt perimeter, and the fan power limit give a closed-form equilibrium pressure; the plenum relaxes towards it,
the rotors spool up over ≈ 1.5 s. Unequal gaps produce a pressure moment. In grip mode a demand controller asks for
the normal force needed for friction plus a pull-off margin — full suction on a steep face, none needed on the flat.
Loose soil and grass seal worse. Sealed on asphalt the system reaches ≈ 4.7 t of suction, which lets the car hang
upside down on the wall ramp as in the stream; on a skid pad it lifts lateral grip from ≈ 1.3 g to ≈ 3.9 g.

## Tyres, suspension, ground

- **Tyres** (`tire.ts`): Pacejka Magic Formula for pure slip, combined slip via normalised-slip similarity,
  load sensitivity `μ = μ0 (Fz/Fz0)^-n`, a structural load cap and relaxation-length slip states (no singularity
  at standstill).
- **Ground** (`surfaces.ts`): tyre characteristics per surface, and a Bekker/Wong terramechanics model for sand,
  lunar regolith and Martian soil — pressure-sinkage, compaction and bulldozing resistance, slip sinkage, and
  Janosi–Hanamoto shear traction. The rut depth of the tyre tracks in the graphics is the same Bekker sinkage.
- **Suspension and chassis** (`chassis.ts`): ray-cast wheels with spring/damper, chassis collision hull,
  impact detection and a damage model (`integrity.ts`).
- **Aero** (`aero.ts`): drag and downforce for the low-drag and high-downforce modes, rear wing pitch.

## Guidance, navigation and control

- **Thrust allocation** (`src/sim/gnc/allocator.ts`): the desired body wrench is mapped to a duty cycle per
  nozzle by a lexicographic, box-constrained least-squares problem solved as a short sequence of small QPs. Each
  axis has a priority level per flight phase (landing: vertical force and roll/pitch first, yaw and lateral last),
  with fuel and rate penalties and awareness of valves inside their minimum on-time.
- **Attitude** (`attitude.ts`): geometric control on SO(3) with inertia feed-forward and `ω × Jω`; full 360° rolls
  are tracked as a continuously winding reference.
- **Guidance and landing** (`guidance.ts`, `trajectory.ts`, `flight.ts`): ballistic prediction, landing burn
  timing, air reserve accounting (`reserve.ts`) and a feasibility check before every launch.
- **Manual flight** (`manual.ts`): three assist levels — ASSIST (height hold and attitude hold), STABILIZED
  (rate control), RAW (direct nozzle groups).

## Stunts and validation

The five stunts (`src/sim/stunts/`) are state machines that drive the car only through the same throttle,
steering and valve commands a player has. Their traces are compared time-aligned with the stream HUD values
(`validation.ts`). Examples from the test suite:

| Stunt | Simulation | Stream |
|---|---|---|
| Wall ramp hang | 169.5° pitch at 68.7 ft | 170° at 69.1 ft |
| Ramp launch | leaves the ramp at 19.56 m | ≈ 19.6 m (64 ft) |
| 0–60 mph | four main jets plus rear-wheel drive; acceptance 0.81 s ± 0.1 s | 0.81 s |

The test suite also covers Monte Carlo robustness (mass ±10 %, inertia ±20 %, thrust and valve scatter), step-size
convergence at 240/480/960 Hz, emergency landing with a stuck valve, the drivable pyramids (every Giza pyramid
model, diagonal approaches, ridges) and momentum conservation when parts break off.

## Worlds and objects

- Real gravity and atmosphere per site (Earth, Moon, Mars, space); nozzle thrust and drag follow the ambient
  pressure and density.
- **Pyramids** (`src/shared/pyramid.ts`): each pyramid is fitted with a smooth frustum (with a debris apron at the
  foot and a rounded summit edge) as an outward-wound triangle mesh — a game simplification: the real stepped,
  weathered surface would not be drivable.
- **Movable objects** (`src/sim/core/props.ts`, `src/shared/props.ts`): Apollo descent stages (2,034 kg and
  2,809 kg), the Lunar Roving Vehicle, Curiosity, Perseverance and the Stonehenge stones are dynamic bodies with
  real masses; parts break off when the impact energy at the contact exceeds their break energy.
- **Roadster 1** (`src/game/orbit.ts`): heliocentric orbit from the JPL Horizons state of 19 October 2026; a ram
  changes its velocity and the panel shows the new elements (a, e, q, Q, period).
- **Sun dive:** a free radial fall from 1 AU with time-lapse; the orbital speed of ≈ 30 km/s is left out because
  250 kg of air (Δv ≈ 75 m/s) could not remove it. The car's temperature follows a radiation balance.

## Press sources

- Electrek, "An updated technical look at Tesla's kick-flipping, 0-60 in 1s next-gen Roadster", 15 Oct 2026
- Electrek, "Tesla unveils cyberfied new Roadster", 15 Oct 2026
- The Next Web, "Tesla Roadster reveal: thrusters, 2028", Oct 2026
- PBS NewsHour, "Tesla's new Roadster car can thrust itself in the air", Oct 2026
- Bekker, *Introduction to Terrain-Vehicle Systems*; Wong, *Theory of Ground Vehicles*; Pacejka, *Tire and Vehicle Dynamics*
- W. F. Rogers, *Apollo Lunar Module Landing Gear*, NASA; JPL Horizons (Roadster, −143205)
