import type { PdfTextBlock } from "./types";

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeRect(startX: number, startY: number, endX: number, endY: number): SelectionRect {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function intersects(rect: SelectionRect, block: Pick<PdfTextBlock, "x" | "y" | "width" | "height">) {
  return rect.x < block.x + block.width
    && rect.x + rect.width > block.x
    && rect.y < block.y + block.height
    && rect.y + rect.height > block.y;
}

export function hasMeaningfulOverlap(
  first: SelectionRect,
  second: SelectionRect,
  edgeTolerance = 2,
  minimumRatio = 0.08,
) {
  const overlapWidth = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const overlapHeight = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  if (overlapWidth <= edgeTolerance || overlapHeight <= edgeTolerance) return false;

  const overlapArea = overlapWidth * overlapHeight;
  const smallerArea = Math.max(1, Math.min(first.width * first.height, second.width * second.height));
  return overlapArea / smallerArea >= minimumRatio;
}

export function overlapRatio(rect: SelectionRect, block: PdfTextBlock) {
  const overlapWidth = Math.max(0, Math.min(rect.x + rect.width, block.x + block.width) - Math.max(rect.x, block.x));
  const overlapHeight = Math.max(0, Math.min(rect.y + rect.height, block.y + block.height) - Math.max(rect.y, block.y));
  return (overlapWidth * overlapHeight) / Math.max(block.width * block.height, 1);
}

export function getBlockBounds(blocks: PdfTextBlock[]): SelectionRect {
  const left = Math.min(...blocks.map((block) => block.x));
  const top = Math.min(...blocks.map((block) => block.y));
  const right = Math.max(...blocks.map((block) => block.x + block.width));
  const bottom = Math.max(...blocks.map((block) => block.y + block.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function looksLikeTable(blocks: PdfTextBlock[]) {
  if (blocks.length < 6) return false;
  const rows: Array<{ centerY: number; height: number; blocks: PdfTextBlock[] }> = [];

  for (const block of [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const centerY = block.y + block.height / 2;
    const row = rows.find((candidate) => Math.abs(candidate.centerY - centerY) <= Math.max(candidate.height, block.height) * 0.65);
    if (row) {
      row.blocks.push(block);
      row.height = Math.max(row.height, block.height);
      row.centerY = row.blocks.reduce((sum, item) => sum + item.y + item.height / 2, 0) / row.blocks.length;
    } else {
      rows.push({ centerY, height: block.height, blocks: [block] });
    }
  }

  const repeatedRows = rows.filter((row) => row.blocks.length >= 2).length;
  return repeatedRows >= 2 && repeatedRows / rows.length >= 0.3;
}

export function joinBlocksByVisualLines(blocks: PdfTextBlock[]) {
  const lines: Array<{ y: number; height: number; blocks: PdfTextBlock[] }> = [];

  for (const block of [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((candidate) => Math.abs(candidate.y - block.y) <= Math.max(candidate.height, block.height) * 0.55);
    if (line) {
      line.blocks.push(block);
      line.height = Math.max(line.height, block.height);
    } else {
      lines.push({ y: block.y, height: block.height, blocks: [block] });
    }
  }

  return lines
    .sort((a, b) => a.y - b.y)
    .map((line) => line.blocks.sort((a, b) => a.x - b.x).map((block) => block.originalText).join(" "))
    .join("\n");
}
