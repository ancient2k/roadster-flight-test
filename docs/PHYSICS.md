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
| Wall ramp hang | 170° pitch at 69.0 ft (21.02 m), 9.7 s hold | 170° at 69.1 ft, ≈ 10 s |
| Ramp launch | drives off the end of the overhang at 5.8 s, 22.2 m | off the end at ≈ 5.7 s, HUD peak 67.8 ft (20.7 m, lagging) |
| Ramp launch, landing | touchdown 9.75 s after the ramp entry, ≈ 17 m in front of the ramp foot, 1.65 g | ≈ 9.7 s, beyond 40 m (at 8 s still 3–5 m up; calibrated camera, see below), 1.4–1.5 g |
| 0–60 mph | four main jets plus rear-wheel drive; acceptance 0.81 s ± 0.1 s | 0.81 s |

The wall ramp (`WALL` in `src/shared/track.ts`) is **one evenly curved arc** (R 10.9 m) from the floor to 170°,
followed by a **straight 10 m overhang** at 170° whose end hangs ≈ 8 m out over the run-up, 23.4 m up; the slab is
4.1 m wide. The shape was fitted to the stream in R15 (`tools/ramp/`):

- **HUD pitch rate.** At a steady crawl the pitch rate is the speed over the radius. Reversing down, the HUD pitch
  falls from 161° to 16° at a constant ≈ 19°/s (2 fps, 703–710 s); climbing, it rises 13° → 82° and 95° → 166° at
  ≈ 24°/s each. That is one constant curvature over the whole wall – no tighter bend at the foot and no vertical
  straight (the earlier profile had R 9.8 m to 90°, a 4.3 m vertical straight and an R 8 m curl).
- **Straight overhang.** At a constant 170° the car crawls ≈ 1.6 m onto a straight and back (692–702 s); the
  straight runs on well beyond it (700 s; drone replay 753–755 s: 8–11 m measured in wheelbases).
- **Silhouettes.** The ramp masks of three stream frames (700 s and 674 s from the locked-off wide camera, 720 s from
  the launch camera) are fitted together with both cameras: the car at the ramp foot fixes their scale and angle
  (rear three-quarter view at ≈ 17°, 44–46 px rear width), the car's position at 14 HUD pitch readings ties the
  pitch to the image. Silhouette IoU ≈ 0.93 / 0.91 / 0.91; a free three-arc profile fits no better, and a separate
  landing view (727–728 s) fits the same arc. The stream camera stands ≈ 45 m in front of the ramp foot and 14 m to
  the side, 1.7 m up, with a 54° vertical field of view: `wall_side` uses it.
- **Scale.** The settled hang altitude 69.1 ft (21.06 m) with the car 1.6 m onto the straight gives R = 10.9 m
  (`TUNING.rampHang.hangOnLipM`). The HUD altitude lags 2–3 s while moving (63.5 → 69.1 ft over 9 s at a standstill),
  so the 30.7 ft at the 90° pause is a lower bound: the surface is 10.9 m high there.

Trade-offs against the HUD, documented rather than tuned away:

- *Launch altitude.* The straight overhang rises outward (sin 10° per metre), so its end is higher than the hang
  point and the launch car leaves it at 22.2 m (73 ft). The HUD peaks at 67.8 ft *after* the car has left; it lags
  like in run 1. `reference.leaveAltitudeM` stays the HUD value 20.7 m (acceptance ±15 %).
- *Altitude trace.* Because the sim has no HUD lag, its ramp_hang altitude RMS against the HUD rises to 2.1 m (9.8 %
  of the peak, limit 10 %), mostly on the lagged descent.
- *Landing.* R14 read the touchdown ≈ 13 m in front of the ramp foot by projecting through the old `wall_side`
  camera. The calibrated launch camera (≈ 54 m in front of the foot, 16 m to the side; the drop at 727.5 and 728 s)
  puts the car ≈ 33 m and ≈ 37–42 m out, 3–5 m up – both from its image position and from its apparent length. The
  sim keeps the shorter flight for now: it drives off the overhang end at ≈ 3.5 m/s and lands ≈ 17 m out.
- *Air budget.* From 22 m the 0.40 g landing burn would exceed the 165 kg regulated budget (173 kg); the burn now
  brakes at 0.50 g net (≈ 1.5 g specific; the 4 fps frames show 2.8–3.2 g peaks between the 1 fps samples).

In the launch the car speeds up as the wall steepens (1.4 g at the entry, cap 9 m/s), slows to ≈ 3.5 m/s on the
overhang and drives off its end at 5.8 s, rolls wheels-down and lands with the corner jets. As in the stream
(729.7–733 s) it then drives off out of its landing cloud at ≈ 6 m/s for 3.5 s and brakes to a stop.

**Broadcast cameras of the two wall stunts (R16).** A frame-by-frame review of both stunts in real time against the
stream (660–735 s) showed that the automatic director, not the physics, made them look wrong:

- Both stunts run on the same ramp, and the director chose its camera set from the car's position only, so the
  launch never used its own cameras: the landing camera calibrated in R15 was never shown. The director now knows
  the stunt being flown (`BroadcastDirector.stunt`, set by the session).
- The 5.5° long lens behind the ramp foot (`wall_rear`) had a zone that covered the whole ramp, so it held the entire
  10 s hang (the underside filling the frame) and the whole drop, half roll and landing of the launch (the car, then
  only its cloud). The stream uses it only while the car stands at the foot; it now gives up the car above 2.5 m.
  The high wide angle (`wall_wide`) looked onto the top of the overhang with the hanging car hidden underneath; it now
  gives up the car above 8 m (run-up, and a short insert on the lower wall on the way down). The climb and the hang
  stay on the locked-off wide shot (`wall_side`) like the stream, the launch cuts
  to the landing camera as the car drops off the overhang (stream 726 s) and keeps it through the rollout.
- The hang no longer has a landing camera (the stream has none; it caused cuts 1.2 s apart at the foot).
- The chase camera swung round to the front of the car whenever the reversing speed crossed 3 m/s on the way down
  the wall; it now stays behind a reversing car.

`tests/render/logic.test.ts` replays both recorded trajectories through the director.

The ramp's slab sides carry a lit red band with small white lamps every 0.6 m and a white edge, as in the close-up at
696 s and the drone replay; the steel tower behind the ramp and a lattice truss along the back of the arc and the
overhang are mid-grey as in the stream's wide shot, and a narrow stage flood far out in front lights the upper wall
and the down-facing overhang evenly like the stream.

The test suite also covers Monte Carlo robustness (mass ±10 %, inertia ±20 %, thrust and valve scatter), step-size
convergence at 240/480/960 Hz, emergency landing with a stuck valve, the drivable pyramids (every Giza pyramid
model, diagonal approaches, ridges) and momentum conservation when parts break off.

## Worlds and objects

- Real gravity and atmosphere per site (Earth, Moon, Mars, space); nozzle thrust and drag follow the ambient
  pressure and density.
- **Pyramids** (`src/shared/pyramid.ts`): each pyramid is fitted with a smooth frustum (with a debris apron at the
  foot and a rounded summit edge) as an outward-wound triangle mesh — a game simplification: the real stepped,
  weathered surface would not be drivable. Apron and edge follow each axis' own face angle (the queens' pyramids
  differ by up to 8°). The summit edge has a 12 m radius (capped by the platform half-width): over a 2.65 m
  wheelbase the floor sags L²/8R ≈ 7 cm, inside the 10 cm ride height, so the car does not ground on the edge
  when it arrives slowly or stops there; the collider edge lies up to ≈ 1.3 m inside the sharp frustum edge.
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
