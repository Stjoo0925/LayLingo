import type { FontWeight } from "./types";

export function inferFontWeight(name: string, font: any): FontWeight {
  const cssWeight = Number.parseInt(String(font?.cssFontInfo?.fontWeight ?? ""), 10);
  if (Number.isFinite(cssWeight) && cssWeight >= 100 && cssWeight <= 900) {
    return (Math.round(cssWeight / 100) * 100) as FontWeight;
  }
  const normalized = `${font?.name ?? ""} ${font?.fallbackName ?? ""} ${name}`.toLowerCase().replace(/[\s_-]+/g, "");
  if (font?.black || /black|heavy|extrabold|ultrabold/.test(normalized)) return 900;
  if (/demibold|semibold/.test(normalized)) return 600;
  if (font?.bold || /bold/.test(normalized)) return 700;
  if (/medium/.test(normalized)) return 500;
  if (/extralight|ultralight|thin/.test(normalized)) return 200;
  if (/light/.test(normalized)) return 300;
  return 400;
}

export function colorFromArgs(args: unknown[], colorSpace: "gray" | "rgb" | "cmyk"): string | null {
  if (typeof args[0] === "string") return args[0];
  const values = args.filter((value): value is number => typeof value === "number");
  if (colorSpace === "gray" && values.length >= 1) {
    const gray = Math.round(Math.max(0, Math.min(1, values[0])) * 255);
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  if (colorSpace === "cmyk" && values.length >= 4) {
    const [cyan, magenta, yellow, black] = values.map((value) => Math.max(0, Math.min(1, value)));
    const red = Math.round((1 - Math.min(1, cyan + black)) * 255);
    const green = Math.round((1 - Math.min(1, magenta + black)) * 255);
    const blue = Math.round((1 - Math.min(1, yellow + black)) * 255);
    return `rgb(${red}, ${green}, ${blue})`;
  }
  if (colorSpace === "rgb" && values.length >= 3) {
    const rgb = values.slice(0, 3).map((value) => Math.round(value <= 1 ? Math.max(0, value) * 255 : value));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }
  return null;
}
