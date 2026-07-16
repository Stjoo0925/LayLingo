import { describe, expect, it } from "vitest";
import { getBlockBounds, hasMeaningfulOverlap, joinBlocksByVisualLines, looksLikeTable, overlapRatio } from "./selection";
import type { PdfTextBlock } from "./types";

function block(id: string, text: string, x: number, y: number): PdfTextBlock {
  return {
    id,
    pageNumber: 1,
    originalText: text,
    translatedText: "",
    x,
    y,
    width: 40,
    height: 12,
    sourceBox: { x, y, width: 40, height: 12 },
    sizingMode: "auto",
    style: { fontFamily: "sans-serif", fontSize: 10, color: "#000000", fontWeight: 400, fontStyle: "normal", textAlign: "left", opacity: 1, rotation: 0 },
    status: "idle",
  };
}

describe("드래그 영역 텍스트 구성", () => {
  const blocks = [block("2", "world", 50, 10), block("3", "second line", 10, 30), block("1", "Hello", 10, 10)];

  it("PDF의 시각적 행과 좌우 순서를 보존한다", () => {
    expect(joinBlocksByVisualLines(blocks)).toBe("Hello world\nsecond line");
  });

  it("사용자 여백이 아닌 실제 텍스트 경계를 계산한다", () => {
    expect(getBlockBounds(blocks)).toEqual({ x: 10, y: 10, width: 80, height: 32 });
  });

  it("텍스트 영역의 절반 이상이 포함된 경우만 선택한다", () => {
    expect(overlapRatio({ x: 10, y: 10, width: 20, height: 12 }, blocks[2])).toBe(0.5);
    expect(overlapRatio({ x: 10, y: 10, width: 19, height: 12 }, blocks[2])).toBeLessThan(0.5);
  });
  it("표 셀 경계의 미세한 접촉은 겹침으로 판정하지 않는다", () => {
    expect(hasMeaningfulOverlap(
      { x: 10, y: 10, width: 40, height: 12 },
      { x: 49, y: 10, width: 40, height: 12 },
    )).toBe(false);
    expect(hasMeaningfulOverlap(
      { x: 10, y: 10, width: 50, height: 12 },
      { x: 50, y: 10, width: 40, height: 12 },
    )).toBe(true);
  });

  it("여러 행에 반복되는 열이 있으면 표 영역으로 판정한다", () => {
    const tableBlocks = [
      block("1", "항목", 10, 10), block("2", "값", 60, 10),
      block("3", "채널", 10, 25), block("4", "1698", 60, 25),
      block("5", "GPS", 10, 40), block("6", "L1", 60, 40),
    ];
    expect(looksLikeTable(tableBlocks)).toBe(true);
    expect(looksLikeTable(tableBlocks.slice(0, 3))).toBe(false);
  });
});
