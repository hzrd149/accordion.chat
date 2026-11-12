export type DaisyThemeInput = {
  background: string;
  text: string;
  primary: string;
};

export type DaisyThemeVariables = Record<string, string>;

const HEX = /^#[0-9a-f]{6}$/;

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

export function isDaisyThemeHex(value: string): boolean {
  return HEX.test(value);
}

function assertHex(value: string, name: string) {
  if (!isDaisyThemeHex(value)) throw new Error(`${name} must be a lowercase #rrggbb color`);
}

function hexToRgb(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function componentToHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hn = h / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, hn + 1 / 3) * 255,
    g: hueToRgb(p, q, hn) * 255,
    b: hueToRgb(p, q, hn - 1 / 3) * 255,
  };
}

function shiftLightness(hex: string, amount: number): string {
  const hsl = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb({ ...hsl, l: Math.max(0, Math.min(1, hsl.l + amount)) }));
}

function mix(a: string, b: string, weight: number): string {
  const ar = hexToRgb(a);
  const br = hexToRgb(b);
  return rgbToHex({
    r: ar.r * (1 - weight) + br.r * weight,
    g: ar.g * (1 - weight) + br.g * weight,
    b: ar.b * (1 - weight) + br.b * weight,
  });
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const [rs, gs, bs] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastContent(hex: string): string {
  return luminance(hex) > 0.5 ? "#111827" : "#ffffff";
}

export function isDarkDaisyTheme(input: DaisyThemeInput): boolean {
  assertHex(input.background, "background");
  return luminance(input.background) < 0.2;
}

export function buildDaisyTheme(input: DaisyThemeInput): DaisyThemeVariables {
  assertHex(input.background, "background");
  assertHex(input.text, "text");
  assertHex(input.primary, "primary");

  const dark = isDarkDaisyTheme(input);
  const base200 = shiftLightness(input.background, dark ? 0.05 : -0.04);
  const base300 = shiftLightness(input.background, dark ? 0.1 : -0.08);
  const neutral = mix(input.background, input.text, dark ? 0.18 : 0.12);
  const secondary = mix(input.background, input.primary, dark ? 0.26 : 0.18);
  const accent = mix(input.primary, input.text, 0.22);

  return {
    "color-scheme": dark ? "dark" : "light",
    "--color-base-100": input.background,
    "--color-base-200": base200,
    "--color-base-300": base300,
    "--color-base-content": input.text,
    "--color-primary": input.primary,
    "--color-primary-content": contrastContent(input.primary),
    "--color-secondary": secondary,
    "--color-secondary-content": input.text,
    "--color-accent": accent,
    "--color-accent-content": contrastContent(accent),
    "--color-neutral": neutral,
    "--color-neutral-content": contrastContent(neutral),
    "--color-info": dark ? "#38bdf8" : "#0284c7",
    "--color-info-content": dark ? "#082f49" : "#ffffff",
    "--color-success": dark ? "#22c55e" : "#16a34a",
    "--color-success-content": dark ? "#052e16" : "#ffffff",
    "--color-warning": dark ? "#facc15" : "#d97706",
    "--color-warning-content": dark ? "#422006" : "#ffffff",
    "--color-error": dark ? "#f87171" : "#dc2626",
    "--color-error-content": dark ? "#450a0a" : "#ffffff",
    "--radius-selector": "1rem",
    "--radius-field": "0.5rem",
    "--radius-box": "0.75rem",
    "--size-selector": "0.25rem",
    "--size-field": "0.25rem",
    "--border": "1px",
    "--depth": "1",
    "--noise": "0",
  };
}
