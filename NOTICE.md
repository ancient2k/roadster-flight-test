# Third-party notices

The project's own code, models, procedural textures and documentation are MIT-licensed (see `LICENSE`).
The following third-party material is included or bundled under its own terms.

## Libraries (bundled into the build)

| Library | Version | License |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | 0.186.1 | MIT |
| [Rapier](https://github.com/dimforge/rapier.js) (`@dimforge/rapier3d-compat`) | 0.21.0 | Apache-2.0 |

`npm run package` copies their full license texts into `THIRD_PARTY_LICENSES/` of the web package.

## Terrain, imagery and models

| Data | Source | Terms |
|---|---|---|
| Earth heights (Stonehenge, Giza) | Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved | Copernicus DEM licence: free use and redistribution with this attribution |
| Moon heights and albedo | NASA/GSFC/Arizona State University (LRO LROC NAC DTMs and mosaics); NASA GSFC PGDA (LOLA DEMs, Barker et al.); USGS Astrogeology (SLDEM2015: LRO LOLA + JAXA SELENE Kaguya TC; LOLA LDEM) | Public domain (NASA/USGS) |
| Mars heights and albedo | NASA/JPL/University of Arizona/USGS (MRO HiRISE DTMs and orthomosaics, MSL Gale mosaics); NASA/JPL/GSFC MGS MOLA and ESA/DLR/FU Berlin Mars Express HRSC (USGS blended DEM) | Public domain (USGS) |
| Curiosity and Perseverance rover models | NASA/JPL-Caltech, [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) | NASA media guidelines (no copyright) |
| Sun disk | NASA/SDO and the HMI science team | NASA media guidelines, credit requested |
| Star map | NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020; Gaia DR2: ESA/Gaia/DPAC | NASA media guidelines, credit requested; Gaia data: ESA/Gaia/DPAC, [CC BY-SA 3.0 IGO](https://creativecommons.org/licenses/by-sa/3.0/igo/) |
| Ground, rock, concrete and vegetation textures; barrier model | [Poly Haven](https://polyhaven.com) | CC0 1.0 |

Per-file provenance: `public/assets/worlds/*/meta.json` (`sources`), `public/assets/worlds/README.md`,
`public/assets/env/README.md`, `public/assets/env-models/README.md`.

Use of NASA material does not imply endorsement by NASA.

## Trademarks

"Tesla", "Roadster", "Model S/3/Y", "Cybertruck", "Semi", "SpaceX", "Falcon Heavy" and "Starman" are
trademarks or names of their respective owners and are used only to describe what this fan simulation depicts.
The project is not affiliated with, sponsored or endorsed by Tesla, Inc. or SpaceX. All vehicle models are
original script-built approximations without logos or lettering.
