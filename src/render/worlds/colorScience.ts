// Black-body colour and visible luminance (Planck × CIE 1931 2° observer, Wyman–Sloan–Shirley 2013
// analytic fits) → linear sRGB. Used for sun/light colour temperatures and the heat glow of the car.
// Pure (Vitest).

const g = (x: number, mu: number, s1: number, s2: number) => {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};
/** CIE 1931 colour-matching functions at wavelength λ (nm). */
export function cie1931(l: number): [number, number, number] {
  const x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

/** Planck spectral radiance B(λ, T) in W·sr⁻¹·m⁻³ (λ in nm). */
export function planck(lNm: number, T: number): number {
  const h = 6.62607015e-34, c = 2.99792458e8, k = 1.380649e-23;
  const l = lNm * 1e-9;
  return (2 * h * c * c) / (l ** 5) / Math.expm1((h * c) / (l * k * T));
}

/** CIE XYZ of a black body at T (unnormalised; Y ∝ luminance, units cd/m² /683 per W). */
export function blackbodyXYZ(T: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const b = planck(l, T);
    const [x, y, z] = cie1931(l);
    X += b * x; Y += b * y; Z += b * z;
  }
  const d = 5e-9;
  return [X * d, Y * d, Z * d];
}

export function xyzToLinearSRGB(X: number, Y: number, Z: number): [number, number, number] {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ];
}

/**
 * Chromaticity of a black body at T as linear sRGB, normalised to luminance 1 (Rec.709 Y),
 * out-of-gamut negatives clipped. 6500 K ≈ white.
 */
export function blackbodyRGB(T: number): [number, number, number] {
  const [X, Y, Z] = blackbodyXYZ(Math.max(500, T));
  const [r, gg, b] = xyzToLinearSRGB(X / Y, 1, Z / Y).map((v) => Math.max(0, v)) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  return [r / lum, gg / lum, b / lum];
}

/** Luminance of a black body surface (cd/m²): 683 lm/W × ∫B·ȳ. */
export function blackbodyLuminance(T: number): number {
  if (T < 400) return 0;
  return 683 * blackbodyXYZ(T)[1];
}
