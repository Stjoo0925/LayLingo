import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { OPS, Util } from "pdfjs-dist";
import { colorFromArgs, inferFontWeight } from "./pdfStyle";
import type { PdfTextBlock } from "./types";

interface PaintStyle {
  color: string;
  fontName?: string;
}

async function extractPaintStyles(page: PDFPageProxy): Promise<PaintStyle[]> {
  const operatorList = await page.getOperatorList();
  const styles: PaintStyle[] = [];
  const stack: PaintStyle[] = [];
  let current: PaintStyle = { color: "#000000" };
  const textOperations = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (operation === OPS.save) stack.push({ ...current });
    else if (operation === OPS.restore) current = stack.pop() ?? current;
    else if (operation === OPS.setFont) current = { ...current, fontName: String(args[0]) };
    else if (operation === OPS.setFillRGBColor) {
      current = { ...current, color: colorFromArgs(args, "rgb") ?? current.color };
    } else if (operation === OPS.setFillGray) {
      current = { ...current, color: colorFromArgs(args, "gray") ?? current.color };
    } else if (operation === OPS.setFillCMYKColor) {
      current = { ...current, color: colorFromArgs(args, "cmyk") ?? current.color };
    } else if (textOperations.has(operation)) {
      styles.push({ ...current });
    }
  }
  return styles;
}

export async function extractTextBlocks(page: PDFPageProxy, scale: number): Promise<PdfTextBlock[]> {
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent();
  const paintStyles = await extractPaintStyles(page);
  let paintIndex = 0;

  return content.items.flatMap((item, index) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const textItem = item as TextItem;
    const transform = Util.transform(viewport.transform, textItem.transform);
    const sourceFontFamily = content.styles[textItem.fontName]?.fontFamily ?? "sans-serif";
    const normalizedFontName = `${sourceFontFamily} ${textItem.fontName}`.toLowerCase();
    const matchingPaintIndex = paintStyles.findIndex((style, index) => index >= paintIndex && (!style.fontName || style.fontName === textItem.fontName));
    const paintStyle = paintStyles[matchingPaintIndex >= 0 ? matchingPaintIndex : paintIndex];
    paintIndex = Math.max(paintIndex + 1, matchingPaintIndex + 1);
    let font: any = null;
    try {
      font = (page.commonObjs as any).get(textItem.fontName);
    } catch {
      font = null;
    }
    const fontHeight = Math.max(Math.hypot(transform[2], transform[3]), 8);
    const width = Math.max(textItem.width * scale, 8);
    const x = transform[4];
    const y = transform[5] - fontHeight;

    return [{
      id: `${page.pageNumber}-${index}`,
      pageNumber: page.pageNumber,
      originalText: textItem.str,
      translatedText: "",
      x,
      y,
      width,
      height: fontHeight * 1.2,
      sourceBox: { x, y, width, height: fontHeight * 1.2 },
      sizingMode: "auto" as const,
      style: {
        fontFamily: `${sourceFontFamily}, Pretendard, Noto Sans KR, sans-serif`,
        fontSize: Math.max(Math.round(fontHeight), 8),
        color: paintStyle?.color ?? "#000000",
        fontWeight: inferFontWeight(normalizedFontName, font),
        fontStyle: normalizedFontName.includes("italic") || normalizedFontName.includes("oblique") ? "italic" : "normal",
        textAlign: "left",
        opacity: 1,
        rotation: Math.atan2(transform[1], transform[0]) * 180 / Math.PI,
      },
      status: "idle" as const,
    }];
  });
}
