# Roadster Flight Test

*A free, unofficial browser simulation of the 2nd-generation Tesla Roadster prototype with its cold-gas
thrusters and fan-suction system. Real-time physics (Rapier + a custom thermodynamic and GNC stack), WebGPU
rendering with a WebGL2 fallback, no backend. The game UI is in German.*

Kostenlose Browser-Simulation des Tesla Roadster (2. Generation), wie er am 15.10.2026 auf dem
SpaceX-Testgelände in McGregor, Texas, gezeigt wurde: Druckluftdüsen, Lüfter-Ansaugsystem, kurze Flüge.

> **Inoffizielles Fan-Projekt.** Keine Verbindung zu Tesla, Inc. oder SpaceX. „Tesla“, „Roadster“ und
> zugehörige Namen sind Marken ihrer Inhaber und werden nur beschreibend verwendet. Alle Fahrzeugmodelle sind
> eigene, per Skript erzeugte Nachbildungen ohne Logos.

## Was drin ist

- **Auto-Modus:** Der Autopilot fliegt die fünf Stunts aus dem Livestream nach – Kopfüber-Rampe,
  Rampen-Absprung, Kickflip über den Semi, 0–60 mph in 0,81 s, Bodenstart-Flip. Physikalisch und
  ausschließlich über Fahr- und Ventilbefehle; der Ergebnisbildschirm vergleicht die Telemetrie mit den
  HUD-Werten aus dem Stream.
- **Manueller Modus:** frei fahren und fliegen mit drei Assistenzstufen (ASSIST, STABILIZED, RAW).
- **Zehn Orte:** McGregor-Testgelände, Stonehenge und das Gizeh-Plateau auf der Erde; Tranquility Base,
  Hadley-Rille und Shackleton-Krater auf dem Mond; Jezero, Gale und Valles Marineris auf dem Mars – mit echter
  Schwerkraft, Atmosphäre und Geländedaten von NASA, USGS und Copernicus. Dazu die Sonne: Roadster 1 mit Starman
  und der „Sonnensturz“.
- **Physik zum Anfassen:** Die Pyramiden von Gizeh lassen sich mit angesaugtem Lüfter hinauffahren.
  Mondlandefähren, Rover und die Steine von Stonehenge kann man umfahren; sie brechen bei genug Aufprallenergie.
  Roadster 1 lässt sich rammen, ein Panel zeigt die neue Sonnenumlaufbahn. Auf Mond, Mars und in Gizeh wirbeln die
  Räder Staub auf und hinterlassen Spuren, die Düsen blasen den Boden frei.

## Starten

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Produktions-Build und Webpaket (statische Seite, kein Backend):

```bash
npm run build        # Ausgabe in dist/
npm run package      # release/roadster-flight-test-<datum>-<commit>.zip inkl. Lizenzen und LIESMICH.txt
```

Die Seite läuft auf jedem statischen Hoster (GitHub Pages, Cloudflare Pages, eigener Webserver), auch in einem
Unterordner. Für WebGPU muss sie über HTTPS ausgeliefert werden; ohne WebGPU schaltet sie automatisch auf WebGL2
mit reduzierten Effekten. Ein Workflow für GitHub Pages liegt in `.github/workflows/pages.yml`.

**Browser:** Automatisiert getestet mit Chromium unter macOS (Apple M1 Pro) mit WebGPU und mit dem
WebGL2-Fallback. Empfohlen ist ein Desktop mit dedizierter oder Apple-Silicon-GPU. Datenmenge: einmalig
≈ 18 MB (Programm und Auto), dazu je Welt 17–51 MB.

URL-Parameter: `?q=low|medium|high|ultra` (Grafik), `?stunt=<id>` (direkt in einen Stunt), `?nomenu`, `?webgl`.

## Steuerung

Standardbelegung, im Spiel unter „Hilfe & Steuerung“ änderbar.

| Aktion | Tastatur | Gamepad |
|---|---|---|
| Gas / Bremse / Lenken | W / S / A, D | RT / LT / linker Stick |
| Hubdüsen | Leertaste | A |
| Heckdüsen (Boost) | Umschalt | X |
| Nicken / Rollen / Gieren | K, I / Q, E / J, L | rechter Stick / LB, RB |
| Lüfter · Aero · Kompressor · Assistenz | F · V · R · N | Steuerkreuz |
| Kamera · Zeitlupe · Fotomodus | C · T · F2 | Y · R3 |
| Pause · Neustart · Menü · Hilfe | P · Rücktaste · Esc · F1 | Menü · Ansicht |
| Sonnensturz starten / Zeitraffer | Enter / Bild↑, Bild↓ | – |

## Tests

```bash
npm run typecheck
npm test             # Vitest: Physik, Tank/Düsen/Ventile, GNC, Stunts inkl. Monte Carlo und Schrittweiten-Konvergenz, Welten, UI-Logik
npm run test:e2e     # Playwright gegen den Produktions-Build: Menü, 5 Stunts in Echtzeit, Freispiel, WebGL2, alle Welten, Ladezeiten
```

Die E2E-Tests brauchen einen Browser mit GPU (Playwright startet Chromium mit WebGPU); die CI führt deshalb nur
Typprüfung und Vitest aus.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/shared/` | Verträge: Typen, Parameterregister `roadster.ts` (mit Herkunftsangabe je Wert), Strecke, Welten, Referenzwerte aus dem Stream |
| `src/sim/core/` | Simulationskern: Rapier-Welt, Drucklufttank (Abel–Noble, Energiebilanz), Regler, Düsen, Ventile, bewegliche Objekte |
| `src/sim/vehicle/` | Federung, Reifen (Pacejka), Bodenarten (Bekker/Wong), Lüfter-Ansaugung, Aerodynamik |
| `src/sim/gnc/`, `src/sim/stunts/` | Schubverteilung (hierarchische QP), SO(3)-Lageregelung, Landeleitung, Autopilot, Stunt-Automaten |
| `src/render/` | WebGPU/TSL-Renderer, Volumenwolken, Düsenstrahlen, Partikel, Kameras; `src/render/worlds/` Gelände, Himmel, Sonne |
| `src/ui/`, `src/input/`, `src/audio/` | HUD im Stream-Stil, Menüs, Eingabe (Tastatur/Gamepad), prozedurales Audio |
| `src/game/` | Spielschleife, Sessions, Weltenwechsel, Sonnensturz, Umlaufbahn von Roadster 1 |
| `tools/` | Blender-Skripte für alle Modelle, Weltdaten-Pipeline, GNC-Werkzeuge (Monte Carlo, Sweeps), Webpaket |

Technische Hintergründe: [docs/PHYSICS.md](docs/PHYSICS.md) (Fahrzeug, Antrieb, Regelung, Validierung) und
[docs/RENDERING.md](docs/RENDERING.md) (Grafik, Welten, Asset-Pipeline). Bekannte Grenzen:
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

## Lizenz

Code, eigene Modelle, Texturen und Dokumentation stehen unter der [MIT-Lizenz](LICENSE).
Fremddaten (NASA, USGS, Copernicus, Poly Haven) und die Bibliotheken three.js und Rapier behalten ihre eigenen
Lizenzen – Übersicht und Namensnennungen in [NOTICE.md](NOTICE.md).
