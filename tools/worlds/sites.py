"""asset pipeline Welten: Ortskonfiguration (Quellen, Kacheln, Spawn, Sonne, Wahrzeichen).

Koordinaten: center/spawn als (lat, lon) in Grad (planetozentrisch, Ost positiv).
Kachel 'near': Spielbereich (fein), 'far': Horizont (grob, größer), beide um 'center' (+ optional offset in m).
Sonne: Azimut von Nord über Ost, Elevation über Horizont (Grad).
"""
LROC = "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001"
SLDEM = {"url": "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/LolaKaguya_Topo/Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd.tif", "mode": "range", "scale": 0.5,
         "nodata": -32768, "credit": "NASA LRO LOLA / JAXA SELENE Kaguya TC, SLDEM2015 merge 59 m (USGS Astrogeology)", "license": "Public Domain (USGS)"}
LOLA_118 = {"url": "https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif", "mode": "range",
            "scale": 0.5, "credit": "NASA/GSFC LRO LOLA, USGS Astrogeology (LDEM 118 m, Mar 2014)", "license": "Public Domain (NASA/USGS)"}
MARS_BLEND = {"url": "https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif",
              "mode": "range", "nodata": -32768,
              "credit": "NASA/JPL/GSFC MGS MOLA, ESA/DLR/FU Berlin Mars Express HRSC; USGS Astrogeology Blended DEM 200 m v2",
              "license": "Public Domain (USGS)"}
LOLA_SP5 = {"url": "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif", "mode": "range",
            "credit": "NASA GSFC Planetary Geodesy Data Archive, LOLA 5 m/px DEM 87–90°S (Barker et al.)", "license": "Public Domain (NASA)"}
LOLA_SP20 = {"url": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF", "mode": "range",
             "credit": "NASA GSFC PGDA, LOLA 20 m/px DEM 80–90°S (Barker et al. 2021)", "license": "Public Domain (NASA)"}
COP30 = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{t}_DEM/Copernicus_DSM_COG_10_{t}_DEM.tif"
COP_CREDIT = {"credit": "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
              "license": "Copernicus DEM licence (frei, mit Namensnennung)"}

MOON_R = 1737400.0
MARS_R = 3396190.0
EARTH_R = 6371000.0

SITES = {
    # ------------------------------------------------------------------ Mond
    "moon_tranquility": {
        "body": "moon", "name": "Tranquility Base (Apollo 11)", "R": MOON_R,
        "description": "Mare Tranquillitatis, Landestelle Apollo 11 (20.7.1969). LM-Abstiegsstufe steht noch dort; "
                       "West Crater (Little West) ~60 m östlich, großes West-Krater ~400 m westlich.",
        # Kachelmitte = Mitte des NAC-DTM-Streifens in Ost-West (4,2 km breit), Spawn = LM
        "center": (0.67409, 23.4419),
        "spawn": {"latlon": (0.67310, 23.47298), "compassDeg": 0.0, "note": "30 m südlich der LM-Abstiegsstufe, Blick nach Norden"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [{
                "url": f"{LROC}/DATA/SDP/NAC_DTM/APOLLO11/NAC_DTM_APOLLO11.TIF", "mode": "full",
                "credit": "NASA/GSFC/Arizona State University, LROC NAC DTM Apollo 11 (2 m/px)", "license": "Public Domain (NASA)"}]},
            "far": {"size": 40000.0, "n": 1025, "height": [SLDEM, LOLA_118]},
        },
        "albedo": {"n": 2048, "source": {
            "url": f"{LROC}/EXTRAS/BROWSE/NAC_ROI/APOLLO11HIA/NAC_ROI_APOLLO11HIA_E010N0234.TIF", "mode": "range",
            "credit": "NASA/GSFC/Arizona State University, LROC NAC high-Sun mosaic Apollo 11 (1,3 m/px)", "license": "Public Domain (NASA)"},
            "meanAlbedo": 0.11, "relStd": 0.16, "tint": (1.0, 0.96, 0.9),
            "note": "Hochsonnen-NAC-Mosaik (kaum Schatten) -> echte Albedo inkl. heller Abgas-Zone um das LM. Lineare Mittel-Albedo 0,11 (Mare)."},
        "sun": {"azimuthDeg": 89.0, "elevationDeg": 10.8, "note": "Sonnenstand bei der Landung 20.7.1969 (Morgen, Sonne im Osten)",
                "illuminanceLux": 131000, "colorTempK": 5800},
        "rockSlopeDeg": 22,
        "detailTextures": {"fine": "regolith", "rock": "regolith_rocky", "dark": "regolith"},
        "landmarks": [{"file": "apollo_lm_descent.glb", "latlon": (0.67409, 23.47298), "compassDeg": 270.0, "note": "Abstiegsstufe Eagle, Vorderseite (+Z, Leiter) nach Westen"}],
        "rocks": {"file": "../_shared/rocks_moon.glb", "density": "dünn (Mare): ~1 Block > 0,5 m pro 200 m², Kraterränder dichter"},
        "license": "NASA-Daten gemeinfrei",
    },
    "moon_hadley": {
        "body": "moon", "name": "Hadley Rille (Apollo 15)", "R": MOON_R,
        "description": "Landestelle Apollo 15 (30.7.1971) zwischen Hadley-Rille (~1,5 km westlich, ~300 m tief) und "
                       "den Apenninen; Mons Hadley (~4,5 km hoch) im Nordosten, Hadley Delta im Süden (Horizontkachel).",
        "center": (26.120, 3.600),
        "spawn": {"latlon": (26.13092, 3.63400), "compassDeg": 0.0, "note": "40 m südlich der LM-Abstiegsstufe Falcon"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [{
                "url": f"{LROC}/DATA/SDP/NAC_DTM/APOLLO15/NAC_DTM_APOLLO15.TIF", "mode": "full",
                "credit": "NASA/GSFC/Arizona State University, LROC NAC DTM Apollo 15 (2 m/px)", "license": "Public Domain (NASA)"}]},
            "far": {"size": 80000.0, "n": 1025, "height": [SLDEM, LOLA_118]},
        },
        "albedo": {"n": 2048, "source": {
            "url": f"{LROC}/EXTRAS/BROWSE/NAC_ROI/APOLLO15HIA/NAC_ROI_APOLLO15HIA_E259N0036.TIF", "mode": "range",
            "credit": "NASA/GSFC/Arizona State University, LROC NAC high-Sun mosaic Apollo 15 (0,67 m/px)", "license": "Public Domain (NASA)"},
            "meanAlbedo": 0.12, "relStd": 0.2, "tint": (1.0, 0.965, 0.91),
            "note": "Hochsonnen-NAC-Mosaik; Albedo der Apenninen-Ausläufer heller als die Mare-Ebene."},
        "sun": {"azimuthDeg": 96.0, "elevationDeg": 12.0, "note": "Morgen, Sonne im Osten (Landung 30.7.1971)",
                "illuminanceLux": 131000, "colorTempK": 5800},
        "rockSlopeDeg": 20,
        "detailTextures": {"fine": "regolith", "rock": "regolith_rocky", "dark": "regolith"},
        "landmarks": [{"file": "apollo_lm_descent.glb", "latlon": (26.13224, 3.63400), "compassDeg": 270.0,
                       "note": "Abstiegsstufe Falcon; Rover (LRV) ~90 m östlich ist im GLB enthalten"}],
        "rocks": {"file": "../_shared/rocks_moon.glb", "density": "Rillenrand und Hänge: dicht, Ebene: dünn"},
        "license": "NASA-Daten gemeinfrei",
    },
    "moon_shackleton": {
        "body": "moon", "name": "Shackleton-Kraterrand (Südpol)", "R": MOON_R,
        "description": "Rand des Shackleton-Kraters (Ø 21 km, 4 km tief) am lunaren Südpol, Artemis-Kandidat. "
                       "Sonne streift den Horizont (< 2°), Kraterinneres in ewigem Schatten.",
        "center": (-89.742, 199.74),
        "spawn": {"latlon": (-89.741932, 201.05802), "compassDeg": 270.0, "note": "Auf dem Kraterkamm, Blick nach Westen 1,6 km hinab in den dauerhaft dunklen Krater"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [
                {"url": f"{LROC}/DATA/SDP/NAC_DTM/ESALL_SR12/NAC_DTM_ESALL_SR12.TIF", "mode": "full",
                 "credit": "NASA/GSFC/ASU/DLR, LROC NAC DTM Shackleton Rim SR12 (2 m/px)", "license": "Public Domain (NASA)"},
                LOLA_SP5]},
            "far": {"size": 60000.0, "n": 1025, "height": [LOLA_SP20]},
        },
        "albedo": {"n": 2048, "base": (0.115, 0.11, 0.105), "rock": (0.14, 0.135, 0.13), "rockSlope": 18,
                   "note": "Prozedural (am Pol gibt es keine schattenfreien Bilder); Hochland-Albedo ~0,11–0,14."},
        "sun": {"azimuthDeg": 60.0, "elevationDeg": 1.5, "note": "Streifendes Licht, max. Sonnenhöhe am Pol ~1,5°",
                "illuminanceLux": 131000, "colorTempK": 5800},
        "rockSlopeDeg": 16,
        "detailTextures": {"fine": "regolith", "rock": "regolith_rocky", "dark": "regolith"},
        "landmarks": [],
        "rocks": {"file": "../_shared/rocks_moon.glb", "density": "Hochland: mäßig, Kraterhang dicht"},
        "license": "NASA-Daten gemeinfrei",
    },
    # ------------------------------------------------------------------ Mars
    "mars_jezero": {
        "body": "mars", "name": "Jezero-Krater (Perseverance)", "R": MARS_R,
        "description": "Kraterboden am Landeplatz Octavia E. Butler (18.2.2021); westlich das Flussdelta, Kraterrand (Ø 45 km) am Horizont.",
        "center": (18.4447, 77.4508),
        "spawn": {"latlon": (18.4447, 77.4508), "compassDeg": 270.0, "note": "Landeplatz Perseverance, Blick nach Westen zum Delta"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [{
                "url": "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif",
                "mode": "range", "credit": "NASA/JPL/UArizona/USGS, Mars 2020 TRN HiRISE DTM-Mosaik 1 m (Fergason et al. 2020)",
                "license": "Public Domain (USGS)"}]},
            "far": {"size": 60000.0, "n": 1025, "height": [MARS_BLEND]},
        },
        "albedo": {"n": 2048, "source": {
            "url": "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120.tif",
            "mode": "range", "credit": "NASA/JPL/UArizona/USGS, Mars 2020 TRN HiRISE Orthomosaik 25 cm", "license": "Public Domain (USGS)"},
            "meanAlbedo": 0.17, "relStd": 0.25, "tint": (1.0, 0.62, 0.40),
            "note": "HiRISE RED (graustufig) mit Mars-Farbton eingefärbt; mittlere Albedo 0,17 (Kraterboden)."},
        "sun": {"azimuthDeg": 255.0, "elevationDeg": 32.0, "note": "Nachmittag (Landung ~15:40 LMST)",
                "illuminanceLux": 55000, "colorTempK": 5200},
        "rockSlopeDeg": 20,
        "detailTextures": {"fine": "mars_soil", "rock": "mars_rock", "dark": "mars_soil"},
        "landmarks": [{"file": "perseverance.glb", "latlon": (18.4447, 77.450264), "compassDeg": 270.0,
                       "note": "Perseverance (vereinfacht), Fahrtrichtung West"}],
        "rocks": {"file": "../_shared/rocks_mars.glb", "density": "Kraterboden: verstreut (Séítah-Blöcke)"},
        "landmarksNote": "Perseverance als Schauobjekt 30 m westlich des Landeplatzes (heute real ~kilometerweit entfernt am Deltarand)",
        "license": "NASA/USGS-Daten gemeinfrei",
    },
    "mars_gale": {
        "body": "mars", "name": "Gale-Krater / Mount Sharp (Curiosity)", "R": MARS_R,
        "description": "Bradbury Landing (6.8.2012) auf Aeolis Palus; Mount Sharp (Aeolis Mons, 5,5 km) im Südosten.",
        "center": (-4.5895, 137.4417),
        "spawn": {"latlon": (-4.5895, 137.4417), "compassDeg": 150.0, "note": "Bradbury Landing, Blick auf Mount Sharp"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [{
                "url": "https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif", "mode": "range",
                "credit": "NASA/JPL/UArizona/USGS, MSL Gale Merged DEM 1 m (Calef & Parker 2016)", "license": "Public Domain (USGS)"}]},
            "far": {"size": 80000.0, "n": 1025, "height": [MARS_BLEND]},
        },
        "albedo": {"n": 2048, "source": {
            "url": "https://planetarymaps.usgs.gov/mosaic/MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif", "mode": "range",
            "credit": "NASA/JPL/UArizona/USGS, MSL Gale Merged Orthophoto 25 cm", "license": "Public Domain (USGS)"},
            "meanAlbedo": 0.19, "relStd": 0.22, "tint": (1.0, 0.64, 0.42),
            "note": "HiRISE-Orthomosaik (graustufig) mit Mars-Farbton."},
        "sun": {"azimuthDeg": 250.0, "elevationDeg": 35.0, "note": "Nachmittag", "illuminanceLux": 55000, "colorTempK": 5200},
        "rockSlopeDeg": 20,
        "detailTextures": {"fine": "mars_soil", "rock": "mars_layered", "dark": "mars_soil"},
        "landmarks": [],
        "rocks": {"file": "../_shared/rocks_mars.glb", "density": "mäßig, auf Aeolis Palus verstreut"},
        "license": "NASA/USGS-Daten gemeinfrei",
    },
    "mars_valles": {
        "body": "mars", "name": "Valles Marineris (Coprates Chasma)", "R": MARS_R,
        "description": "Talboden von Coprates Chasma; die Steilwände ragen 6–8 km auf (Horizontkachel 120 km).",
        "center": (-13.4856, -61.40),
        "spawn": {"latlon": (-13.4856, -61.40), "compassDeg": 180.0, "note": "Wandfuß am Südrand von Coprates Chasma, Blick auf die Südwand"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [MARS_BLEND],
                     "smoothM": 0.0, "detail": {"amplitudeM": 0.7, "maxWavelengthM": 120.0, "beta": 2.6}},
            "far": {"size": 120000.0, "n": 1025, "height": [MARS_BLEND]},
        },
        "albedo": {"n": 2048, "base": (0.30, 0.17, 0.10), "rock": (0.24, 0.14, 0.09), "rockSlope": 14,
                   "note": "Prozedural (Staub/Fels), da kein HiRISE-DTM am gewählten Punkt; Höhen 200 m + Feinstruktur."},
        "sun": {"azimuthDeg": 110.0, "elevationDeg": 25.0, "note": "Vormittag, Licht streift die Südwand",
                "illuminanceLux": 55000, "colorTempK": 5200},
        "rockSlopeDeg": 16,
        "detailTextures": {"fine": "mars_soil", "rock": "mars_layered", "dark": "mars_rock"},
        "landmarks": [],
        "rocks": {"file": "../_shared/rocks_mars.glb", "density": "Schuttfächer am Wandfuß: dicht"},
        "license": "NASA/USGS-Daten gemeinfrei",
    },
    # ------------------------------------------------------------------ Erde
    "earth_stonehenge": {
        "body": "earth", "name": "Stonehenge", "R": EARTH_R,
        "description": "Salisbury Plain, Wiltshire: Kreidegrasland, Steinkreis (Sarsen-Kreis, Trilithen, Blausteine), "
                       "Heel Stone an der Sonnwendachse (Azimut 49,9°).",
        "center": (51.178882, -1.826215),
        "spawn": {"latlon": (51.17790, -1.82790), "compassDeg": 45.0, "note": "Südwestlich des Kreises, Blick über die Steine zum Heel Stone"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [{"url": COP30.format(t="N51_00_W002_00"), "mode": "full", **COP_CREDIT}],
                     "smoothM": 15.0, "detail": {"amplitudeM": 0.08, "maxWavelengthM": 15.0, "beta": 2.4},
                     "flatten": [{"latlon": (51.178882, -1.826215), "radius": 90.0, "margin": 40.0}]},
            "far": {"size": 30000.0, "n": 1025, "height": [{"url": COP30.format(t="N51_00_W002_00"), "mode": "full", **COP_CREDIT}]},
        },
        "albedo": {"n": 2048, "base": (0.14, 0.19, 0.07), "rock": (0.17, 0.19, 0.09), "rockSlope": 20,
                   "note": "Prozedural (Kreidegrasland, sommerlich)."},
        "sun": {"azimuthDeg": 50.0, "elevationDeg": 6.0, "note": "Sommersonnenwende, kurz nach Sonnenaufgang über dem Heel Stone",
                "illuminanceLux": 20000, "colorTempK": 3800},
        "rockSlopeDeg": 25,
        "detailTextures": {"fine": "grass_chalk", "rock": "limestone", "dark": "grass_chalk"},
        "landmarks": [{"file": "stonehenge.glb", "latlon": (51.178882, -1.826215), "compassDeg": 180.0,
                       "note": "Steinkreis; lokale +Z (Modell) = Süden, Heel Stone bei Azimut 49,9°"}],
        "rocks": {},
        "license": "Copernicus DEM: Namensnennung (siehe sources)",
    },
    # ------------------------------------------------------------------ Erde
    "earth_giza": {
        "body": "earth", "name": "Gizeh-Plateau", "R": EARTH_R,
        "description": "Pyramiden von Cheops, Chephren, Mykerinos und Sphinx. Wüstenplateau ~60 m ü. NN, Niltal im Osten.",
        "center": (29.9745, 31.1300),
        "spawn": {"latlon": (29.9700, 31.1230), "compassDeg": 45.0, "note": "Panorama-Punkt in der Wüste südwestlich, Blick nach NO auf die drei Pyramiden"},
        "tiles": {
            "near": {"size": 4000.0, "n": 2049, "height": [{"url": COP30.format(t="N29_00_E031_00"), "mode": "full", **COP_CREDIT}],
                     "smoothM": 18.0, "detail": {"amplitudeM": 0.18, "maxWavelengthM": 25.0, "beta": 2.4},
                     # Pyramiden + Sphinx-Gehege aus dem DSM entfernen (werden als GLB gesetzt)
                     "flatten": [{"latlon": (29.97917, 31.13417), "half": (118, 118), "margin": 25},
                                 {"latlon": (29.97611, 31.13083), "half": (110, 110), "margin": 25},
                                 {"latlon": (29.97250, 31.12806), "half": (54, 54), "margin": 25},
                                 {"latlon": (29.97528, 31.13759), "half": (50, 40), "margin": 15}]},
            "far": {"size": 30000.0, "n": 1025, "height": [{"url": COP30.format(t=t), "mode": "full", **COP_CREDIT}
                                                            for t in ("N29_00_E031_00", "N30_00_E031_00", "N29_00_E030_00", "N30_00_E030_00")]},
        },
        "albedo": {"n": 2048, "base": (0.60, 0.50, 0.36), "rock": (0.64, 0.57, 0.46), "rockSlope": 10,
                   "note": "Prozedural (Sand/Kalkstein) aus Hangneigung + Rauschen; Detailtexturen sand/limestone."},
        "sun": {"azimuthDeg": 255.0, "elevationDeg": 22.0, "note": "Spätnachmittag (goldenes Licht, lange Schatten nach Osten)",
                "illuminanceLux": 60000, "colorTempK": 4300},
        "rockSlopeDeg": 14,
        "detailTextures": {"fine": "sand", "rock": "limestone", "dark": "sand"},
        "landmarks": [
            {"file": "giza_khufu.glb", "latlon": (29.97917, 31.13417), "compassDeg": -0.06, "note": "Cheops: Basis 230,34 m, heute 138,5 m"},
            {"file": "giza_khafre.glb", "latlon": (29.97611, 31.13083), "compassDeg": -0.1, "note": "Chephren: Basis 215,25 m, heute 136,4 m"},
            {"file": "giza_menkaure.glb", "latlon": (29.97250, 31.12806), "compassDeg": 0.2, "note": "Mykerinos: 102,2 x 104,6 m, heute 61 m"},
            {"file": "giza_sphinx.glb", "latlon": (29.97528, 31.13759), "compassDeg": 90.0, "note": "Sphinx blickt nach Osten; Gehege ~5 m tiefer"},
        ],
        "rocks": {"file": "../_shared/rocks_desert.glb", "density": "Kalksteinbrocken an Hängen und um die Pyramiden"},
        "license": "Copernicus DEM: Namensnennung (siehe sources)",
    },
}
