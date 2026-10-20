# Worlds — terrain, textures, landmarks

Generated reproducibly with `tools/worlds/` (see `docs/RENDERING.md`). One folder per site with
`meta.json` (extent, height range, spawn, sun, sources, landmarks), heightmaps (16-bit PNG),
`albedo.jpg`, `normal.png`, `splat.png` and landmark GLBs. Shared files in `_shared/` (rocks, detail textures).

## Sources and licences

| Data | Source | Licence |
|---|---|---|
| Lunar close-range tiles (DTM 2 m/px) | NASA/GSFC/Arizona State University, LRO LROC NAC DTMs (PDS, `pds.lroc.im-ldi.com`) | public domain (NASA) |
| Lunar albedo | LROC NAC high-sun mosaics / DTM orthoimages (PDS) | public domain (NASA) |
| South pole (Shackleton) | NASA GSFC Planetary Geodesy Data Archive (pgda.gsfc.nasa.gov), LOLA DEMs 5 m (87–90° S) and 20 m (80–90° S), Barker et al. | public domain (NASA) |
| Lunar horizon | SLDEM2015 (LRO LOLA + SELENE Kaguya TC, 59 m), USGS Astrogeology; fallback LOLA LDEM 118 m | public domain (NASA/USGS/JAXA data release) |
| Mars | MRO HiRISE DTMs / orthoimages (University of Arizona, USGS Astrogeology), HRSC/MOLA blend | public domain (NASA/JPL/UArizona) |
| Earth (elevation) | Copernicus DEM GLO-30, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA | Copernicus DEM licence (free, attribution) |
| Detail textures `_shared/detail/`, rock, pyramid and Sphinx textures | Poly Haven (rock_ground, gray_rocks, coast_sand_01, rock_boulder_dry, red_laterite_soil_stones, rock_face_03, dry_riverbed_rock, large_sandstone_blocks_01, grass_ground) | CC0 1.0 |
| LM foil, grass and similar textures | generated procedurally (tools/worlds/blender) | project |
| Solar disc `space_sun/sun_disk_1024.png` | NASA/SDO and the HMI science team (HMI continuum quick-look, 18 Oct 2026) | NASA image use policy (free, attribution requested) |
| Star map `space_sun/` | NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020 | NASA image use policy (free, attribution requested) |

Where the data came from: Copernicus DEM via the official AWS Open Data bucket `copernicus-dem-30m` (a
distribution partner of the Copernicus programme); USGS mosaics (SLDEM2015, Mars blend, Mars 2020/MSL mosaics)
via the USGS S3 mirror `asc-pds-services` (redirect target of planetarymaps.usgs.gov); LROC products via the
NASA PDS Cloud (`pds.mcp.nasa.gov`, redirect target of pds.lroc.im-ldi.com).

The exact origin of every file is listed in each site's `meta.json` → `sources`.
Downloads: `tools/worlds/downloads/` (not versioned), fetched on 18 Oct 2026 with curl / HTTP range requests.
