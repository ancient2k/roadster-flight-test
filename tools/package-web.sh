#!/usr/bin/env bash
# Builds the static site and packs it for any web server: release/roadster-flight-test-<date>-<commit>.zip.
# Leaves out source maps and the superseded car models (roadster_v*.glb, only kept in the repo for history);
# adds the licence texts of the bundled libraries, LIESMICH.txt and an optional Apache .htaccess.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=release
NAME="roadster-flight-test-$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
STAGE="$OUT/$NAME"
rm -rf "$STAGE" "$OUT/$NAME.zip"
mkdir -p "$OUT"
npx tsc --noEmit
npx vite build --outDir "$STAGE" --emptyOutDir --sourcemap false
rm -f "$STAGE"/assets/car/roadster_v*.glb
find "$STAGE" -name '*.map' -delete

# third-party licences of everything bundled into the JS (npm "dependencies")
LIC="$STAGE/THIRD_PARTY_LICENSES"
mkdir -p "$LIC"
for dep in $(node -p "Object.keys(require('./package.json').dependencies).join(' ')"); do
  f=$(ls node_modules/$dep/LICENSE* 2>/dev/null | head -1 || true)
  [ -n "$f" ] || { echo "Lizenztext fehlt: $dep" >&2; exit 1; }
  ver=$(node -p "require('./node_modules/$dep/package.json').version")
  { echo "$dep $ver"; echo; cat "$f"; } > "$LIC/$(echo "$dep" | tr '/@' '__').txt"
done

cp tools/release/LIESMICH.txt "$STAGE/LIESMICH.txt"
cp tools/release/htaccess "$STAGE/.htaccess"

(cd "$OUT" && zip -qr -X "$NAME.zip" "$NAME")
du -sh "$STAGE" "$OUT/$NAME.zip"
echo "$OUT/$NAME.zip"
