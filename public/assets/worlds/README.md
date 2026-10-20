# Welten — Gelände, Texturen, Wahrzeichen

Erzeugt reproduzierbar mit `tools/worlds/` (siehe `docs/RENDERING.md`). Je Ort ein Ordner mit
`meta.json` (Ausdehnung, Höhenbereich, Spawn, Sonne, Quellen, Wahrzeichen), Heightmaps (16-Bit-PNG),
`albedo.jpg`, `normal.png`, `splat.png` und Wahrzeichen-GLBs. Gemeinsames in `_shared/` (Felsen, Detailtexturen).

## Quellen und Lizenzen

| Daten | Quelle | Lizenz |
|---|---|---|
| Mond-Nahkacheln (DTM 2 m/px) | NASA/GSFC/Arizona State University, LRO LROC NAC DTMs (PDS, `pds.lroc.im-ldi.com`) | gemeinfrei (NASA) |
| Mond-Albedo | LROC NAC Hochsonnen-Mosaike / DTM-Orthobilder (PDS) | gemeinfrei (NASA) |
| Südpol (Shackleton) | NASA GSFC Planetary Geodesy Data Archive (pgda.gsfc.nasa.gov), LOLA-DEMs 5 m (87–90° S) und 20 m (80–90° S), Barker et al. | gemeinfrei (NASA) |
| Mond-Horizont | SLDEM2015 (LRO LOLA + SELENE Kaguya TC, 59 m), USGS Astrogeology; Ersatz LOLA LDEM 118 m | gemeinfrei (NASA/USGS/JAXA-Datenfreigabe) |
| Mars | MRO HiRISE DTMs / Orthobilder (University of Arizona, USGS Astrogeology), HRSC/MOLA-Blend | gemeinfrei (NASA/JPL/UArizona) |
| Erde (Höhen) | Copernicus DEM GLO-30, © DLR e.V. 2010-2014 und © Airbus Defence and Space GmbH 2014-2018, bereitgestellt unter COPERNICUS durch die Europäische Union und ESA | Copernicus-DEM-Lizenz (frei, Namensnennung) |
| Detailtexturen `_shared/detail/`, Felsen-, Pyramiden- und Sphinx-Texturen | Poly Haven (rock_ground, gray_rocks, coast_sand_01, rock_boulder_dry, red_laterite_soil_stones, rock_face_03, dry_riverbed_rock, large_sandstone_blocks_01, grass_ground) | CC0 1.0 |
| LM-Folien-, Gras- u. ä. Texturen | prozedural erzeugt (tools/worlds/blender) | Projekt |
| Sonnenscheibe `space_sun/sun_disk_1024.png` | NASA/SDO and the HMI science team (HMI-Kontinuum Quick-Look 18.10.2026) | NASA-Bildnutzungsrichtlinie (frei, Namensnennung erbeten) |
| Sternenhimmel `space_sun/` | NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020 | NASA-Bildnutzungsrichtlinie (frei, Namensnennung erbeten) |

Bezugswege: Copernicus DEM über den offiziellen AWS-Open-Data-Bucket `copernicus-dem-30m` (Verteilpartner des
Copernicus-Programms); USGS-Mosaike (SLDEM2015, Mars-Blend, Mars-2020-/MSL-Mosaike) über den USGS-S3-Spiegel
`asc-pds-services` (Ziel der Umleitung von planetarymaps.usgs.gov); LROC-Produkte über die NASA PDS Cloud
(`pds.mcp.nasa.gov`, Ziel der Umleitung von pds.lroc.im-ldi.com).

Die genaue Herkunft jeder Datei steht in `meta.json` → `sources` des jeweiligen Ortes.
Downloads: `tools/worlds/downloads/` (nicht versioniert), am 18.10.2026 per curl / HTTP-Range geladen.
