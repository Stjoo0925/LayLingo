export type TextAlign = "left" | "center" | "right";
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  fontWeight: FontWeight;
  fontStyle: "normal" | "italic";
  textAlign: TextAlign;
  opacity: number;
  rotation: number;
}

export interface PdfTextBlock {
  id: string;
  pageNumber: number;
  originalText: string;
  translatedText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  sizingMode: "auto" | "manual";
  style: TextStyle;
  status: "idle" | "translating" | "translated" | "error";
  mode?: "demo" | "openai";
  suppressed?: boolean;
  displayText?: string;
  maskBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
