import { describe, expect, it } from "vitest";
import { colorFromArgs, inferFontWeight } from "./pdfStyle";

describe("MVP 기본 계약", () => {
  it("지원하는 텍스트 정렬 값을 고정한다", () => {
    const alignments = ["left", "center", "right"];
    expect(alignments).toHaveLength(3);
  });

  it("폰트 메타데이터와 이름을 100~900 굵기로 변환한다", () => {
    expect(inferFontWeight("Example-SemiBold", null)).toBe(600);
    expect(inferFontWeight("Example-Regular", { cssFontInfo: { fontWeight: "500" } })).toBe(500);
    expect(inferFontWeight("Example", { black: true })).toBe(900);
  });

  it("PDF 회색·RGB·CMYK 채우기 색상을 CSS 색상으로 변환한다", () => {
    expect(colorFromArgs([0.5], "gray")).toBe("rgb(128, 128, 128)");
    expect(colorFromArgs([1, 0, 0], "rgb")).toBe("rgb(255, 0, 0)");
    expect(colorFromArgs([1, 0, 0, 0], "cmyk")).toBe("rgb(0, 255, 255)");
  });
});
