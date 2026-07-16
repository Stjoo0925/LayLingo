import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractTextBlocks } from "./pdf";
import { getBlockBounds, hasMeaningfulOverlap, intersects, looksLikeTable, normalizeRect, overlapRatio } from "./selection";
import type { PdfTextBlock, TextStyle } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const initialScale = 1.35;
const dragThreshold = 6;

interface DragSelection {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

type GroupLayoutMode = "paragraph" | "cells";

export function App() {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(initialScale);
  const [blocks, setBlocks] = useState<PdfTextBlock[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedBlockIds, setDraggedBlockIds] = useState<string[]>([]);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [layoutPreviewOriginal, setLayoutPreviewOriginal] = useState<PdfTextBlock[] | null>(null);
  const [layoutPreviewMode, setLayoutPreviewMode] = useState<GroupLayoutMode | null>(null);
  const [historyCount, setHistoryCount] = useState(0);
  const [message, setMessage] = useState("PDF를 열어 번역을 시작하세요.");
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const foregroundBaseRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<PdfTextBlock[][]>([]);
  const dragSelectionRef = useRef<DragSelection | null>(null);
  const didDragRef = useRef(false);
  const suppressClickUntilRef = useRef(0);

  const pageBlocks = useMemo(
    () => blocks.filter((block) => block.pageNumber === pageNumber),
    [blocks, pageNumber],
  );
  const selected = blocks.find((block) => block.id === selectedId) ?? null;
  const draggedBlocks = pageBlocks.filter((block) => draggedBlockIds.includes(block.id));
  const draggedBounds = draggedBlocks.length > 0 ? getBlockBounds(draggedBlocks) : null;
  const isTableSelection = looksLikeTable(draggedBlocks);
  const draggedOverlapCount = draggedBlocks.filter((block) => !block.suppressed && hasOverlap(block)).length;

  useEffect(() => {
    if (!document || !canvasRef.current || !backgroundCanvasRef.current) return;
    let cancelled = false;

    void (async () => {
      const page = await document.getPage(pageNumber);
      if (cancelled || !canvasRef.current || !backgroundCanvasRef.current) return;
      const viewport = page.getViewport({ scale });
      const outputScale = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      const backgroundCanvas = backgroundCanvasRef.current;
      const context = canvas.getContext("2d");
      const backgroundContext = backgroundCanvas.getContext("2d");
      if (!context || !backgroundContext) return;

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      backgroundCanvas.width = canvas.width;
      backgroundCanvas.height = canvas.height;
      backgroundCanvas.style.width = canvas.style.width;
      backgroundCanvas.style.height = canvas.style.height;

      const operatorList = await page.getOperatorList();
      const textOperations = new Set<number>([
        pdfjs.OPS.showText,
        pdfjs.OPS.showSpacedText,
        pdfjs.OPS.nextLineShowText,
        pdfjs.OPS.nextLineSetSpacingShowText,
      ]);

      await page.render({
        canvasContext: backgroundContext,
        canvas: backgroundCanvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        operationsFilter: (index) => !textOperations.has(operatorList.fnArray[index]),
      }).promise;

      await page.render({
        canvasContext: context,
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise;

      const foregroundBase = window.document.createElement("canvas");
      foregroundBase.width = canvas.width;
      foregroundBase.height = canvas.height;
      foregroundBase.getContext("2d")?.drawImage(canvas, 0, 0);
      foregroundBaseRef.current = foregroundBase;

      const extracted = await extractTextBlocks(page, scale);
      if (cancelled) return;
      setBlocks((current) => {
        const manualRegions = current.filter((block) => block.pageNumber === pageNumber && block.id.startsWith("region-"));
        const otherPages = current.filter((block) => block.pageNumber !== pageNumber);
        const nextExtracted = extracted.map((next) => {
          const previous = current.find((block) => block.id === next.id);
          return previous
            ? { ...next, translatedText: previous.translatedText, style: previous.style, status: previous.status, mode: previous.mode, suppressed: previous.suppressed, sizingMode: previous.sizingMode, x: previous.sizingMode === "manual" ? previous.x : next.x, y: previous.sizingMode === "manual" ? previous.y : next.y, width: previous.sizingMode === "manual" ? previous.width : next.width, height: previous.sizingMode === "manual" ? previous.height : next.height }
            : next;
        });
        return [...otherPages, ...nextExtracted, ...manualRegions];
      });
      setMessage(`${pageNumber}페이지에서 ${extracted.length}개의 텍스트 영역을 찾았습니다.`);
    })().catch(() => setMessage("PDF 페이지를 표시하지 못했습니다."));

    return () => { cancelled = true; };
  }, [document, pageNumber, scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const foregroundBase = foregroundBaseRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !foregroundBase || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(foregroundBase, 0, 0);
    const pixelScale = canvas.width / Math.max(canvas.clientWidth, 1);
    for (const block of pageBlocks) {
      if (!block.translatedText) continue;
      const source = block.sourceBox;
      context.clearRect(
        (source.x - 1) * pixelScale,
        (source.y - 1) * pixelScale,
        (source.width + 2) * pixelScale,
        (source.height + 2) * pixelScale,
      );
    }
  }, [pageBlocks]);

  async function openPdf(file: File) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setMessage("PDF 파일만 열 수 있습니다.");
      return;
    }
    try {
      setMessage("PDF를 분석하고 있습니다…");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const nextDocument = await pdfjs.getDocument({ data: bytes }).promise;
      setDocument(nextDocument);
      setFileName(file.name);
      setPageNumber(1);
      setBlocks([]);
      setSelectedId(null);
      setDraggedBlockIds([]);
      setLayoutPreviewOriginal(null);
      setLayoutPreviewMode(null);
      historyRef.current = [];
      setHistoryCount(0);
    } catch {
      setMessage("PDF를 열지 못했습니다. 암호화되었거나 손상된 파일인지 확인하세요.");
    }
  }

  function saveHistory(snapshot: PdfTextBlock[]) {
    historyRef.current = [...historyRef.current.slice(-49), structuredClone(snapshot)];
    setHistoryCount(historyRef.current.length);
  }

  function updateBlocks(updater: (current: PdfTextBlock[]) => PdfTextBlock[], record = true) {
    setBlocks((current) => {
      if (record) saveHistory(current);
      return updater(current);
    });
  }

  function updateBlock(id: string, patch: Partial<PdfTextBlock>, record = true) {
    updateBlocks(
      (current) => current.map((block) => block.id === id ? { ...block, ...patch } : block),
      record,
    );
  }

  function updateStyle(patch: Partial<TextStyle>) {
    if (!selected) return;
    updateBlock(selected.id, { style: { ...selected.style, ...patch } });
  }

  function startResize(block: PdfTextBlock, direction: "left" | "right", event: React.PointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startClientX = event.clientX;
    const startX = block.x;
    const startWidth = block.width;
    setBlocks((current) => {
      saveHistory(current);
      return current;
    });

    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startClientX;
      if (direction === "right") {
        updateBlock(block.id, { width: Math.max(20, startWidth + delta), sizingMode: "manual" }, false);
      } else {
        const width = Math.max(20, startWidth - delta);
        updateBlock(block.id, { x: startX + startWidth - width, width, sizingMode: "manual" }, false);
      }
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  }

  function hasOverlap(block: PdfTextBlock) {
    if (!block.translatedText || block.suppressed) return false;
    return pageBlocks.some((other) => other.id !== block.id && hasMeaningfulOverlap(
      { x: block.x, y: block.y, width: block.width, height: block.height },
      other.sourceBox,
    ));
  }

  function measureTextLayout(block: PdfTextBlock, text: string, width: number, fontSize = block.style.fontSize) {
    const measureCanvas = window.document.createElement("canvas");
    const context = measureCanvas.getContext("2d");
    if (!context) return { width, height: block.height };
    context.font = `${block.style.fontStyle} ${block.style.fontWeight} ${fontSize}px ${block.style.fontFamily}`;
    const innerWidth = Math.max(1, width - 10);
    const visualLines = text.split("\n").reduce(
      (count, line) => count + Math.max(1, Math.ceil(context.measureText(line).width / innerWidth)),
      0,
    );
    return { width, height: Math.max(block.sourceBox.height, visualLines * fontSize * 1.25) };
  }

  function resolveOverlap(block: PdfTextBlock) {
    const rightNeighbors = pageBlocks.filter((other) => {
      if (other.id === block.id || other.sourceBox.x <= block.x) return false;
      const verticalOverlap = Math.min(block.y + block.height, other.sourceBox.y + other.sourceBox.height)
        - Math.max(block.y, other.sourceBox.y);
      return verticalOverlap > 2;
    });
    const rightEdge = Math.min(
      canvasRef.current?.clientWidth ?? block.x + block.width,
      ...rightNeighbors.map((other) => other.sourceBox.x - 3),
    );
    const width = Math.max(20, rightEdge - block.x);
    const minimumFontSize = Math.max(6, Math.round(block.style.fontSize * 0.7 * 2) / 2);
    let fontSize = block.style.fontSize;
    let layout = measureTextLayout(block, block.translatedText, width, fontSize);

    while (fontSize > minimumFontSize) {
      const candidate = { x: block.x, y: block.y, ...layout };
      const collides = pageBlocks.some((other) => other.id !== block.id && hasMeaningfulOverlap(candidate, other.sourceBox));
      if (!collides) break;
      fontSize = Math.max(minimumFontSize, fontSize - 0.5);
      layout = measureTextLayout(block, block.translatedText, width, fontSize);
    }

    updateBlock(block.id, {
      ...layout,
      sizingMode: "manual",
      style: { ...block.style, fontSize },
    });
  }

  function previewGroupLayout(mode: GroupLayoutMode) {
    const targets = draggedBlocks.filter((block) => block.translatedText);
    if (targets.length === 0) {
      setMessage("드래그 번역된 텍스트가 없습니다.");
      return;
    }

    const baseBlocks = layoutPreviewOriginal ?? blocks;
    const baseTargets = baseBlocks.filter((block) => draggedBlockIds.includes(block.id) && block.translatedText);
    if (!layoutPreviewOriginal) setLayoutPreviewOriginal(structuredClone(blocks));

    if (mode === "paragraph") {
      const ordered = [...baseTargets].sort((a, b) => a.y - b.y || a.x - b.x);
      const bounds = getBlockBounds(ordered);
      const primary = ordered[0];
      const commonFontSize = Math.min(...ordered.map((block) => block.style.fontSize));
      const combinedText = ordered.map((block) => block.translatedText.trim()).filter(Boolean).join(" ");
      const layout = measureTextLayout(primary, combinedText, bounds.width, commonFontSize);
      setBlocks(baseBlocks.map((block) => {
        const index = ordered.findIndex((target) => target.id === block.id);
        if (index < 0) return block;
        if (index > 0) return { ...block, suppressed: true, sizingMode: "manual" as const, style: { ...block.style, fontSize: commonFontSize } };
        return { ...block, translatedText: combinedText, suppressed: false, x: bounds.x, y: bounds.y, width: bounds.width, height: layout.height, sizingMode: "manual" as const, style: { ...block.style, fontSize: commonFontSize } };
      }));
      setLayoutPreviewMode(mode);
      setMessage("문단 재배치 미리보기입니다. 적용하거나 다른 방식을 선택하세요.");
      return;
    }

    const initialFontSize = Math.min(...baseTargets.map((block) => block.style.fontSize));
    const minimumFontSize = Math.max(6, Math.round(initialFontSize * 0.7 * 2) / 2);
    let commonFontSize = initialFontSize;
    let layouts = new Map<string, { width: number; height: number }>();

    const calculateLayouts = (fontSize: number) => new Map(baseTargets.map((block) => {
      const rightNeighbors = pageBlocks.filter((other) => {
        if (other.id === block.id || other.sourceBox.x <= block.x) return false;
        const verticalOverlap = Math.min(block.y + block.height, other.sourceBox.y + other.sourceBox.height)
          - Math.max(block.y, other.sourceBox.y);
        return verticalOverlap > 2;
      });
      const rightEdge = Math.min(
        canvasRef.current?.clientWidth ?? block.x + block.width,
        ...rightNeighbors.map((other) => other.sourceBox.x - 3),
      );
      const width = Math.max(20, rightEdge - block.x);
      return [block.id, measureTextLayout(block, block.translatedText, width, fontSize)];
    }));

    while (commonFontSize >= minimumFontSize) {
      layouts = calculateLayouts(commonFontSize);
      const collides = baseTargets.some((block) => {
        const layout = layouts.get(block.id);
        if (!layout) return false;
        const candidate = { x: block.x, y: block.y, ...layout };
        return pageBlocks.some((other) => other.id !== block.id && hasMeaningfulOverlap(candidate, other.sourceBox));
      });
      if (!collides || commonFontSize === minimumFontSize) break;
      commonFontSize = Math.max(minimumFontSize, commonFontSize - 0.5);
    }

    setBlocks(baseBlocks.map((block) => {
      const layout = layouts.get(block.id);
      if (!layout) return block;
      return {
        ...block,
        ...layout,
        suppressed: false,
        sizingMode: "manual" as const,
        style: { ...block.style, fontSize: commonFontSize },
      };
    }));
    setLayoutPreviewMode(mode);
    setSelectedId(null);
    setMessage(`원본 칸 유지 미리보기입니다. 공통 글꼴 ${commonFontSize}px을 적용했습니다.`);
  }

  function applyLayoutPreview() {
    if (!layoutPreviewOriginal) return;
    saveHistory(layoutPreviewOriginal);
    setLayoutPreviewOriginal(null);
    setLayoutPreviewMode(null);
    setMessage("선택 영역의 배치를 적용했습니다. 되돌리기로 복구할 수 있습니다.");
  }

  function cancelLayoutPreview() {
    if (layoutPreviewOriginal) setBlocks(layoutPreviewOriginal);
    setLayoutPreviewOriginal(null);
    setLayoutPreviewMode(null);
    setMessage("배치 미리보기를 취소했습니다.");
  }

  function startManualGroupEdit() {
    cancelLayoutPreview();
    const first = draggedBlocks.find((block) => block.translatedText);
    if (first) setSelectedId(first.id);
    setMessage("직접 조정 모드입니다. 텍스트 박스를 선택해 위치와 크기를 조정하세요.");
  }

  function undo() {
    if (layoutPreviewOriginal) {
      cancelLayoutPreview();
      return;
    }
    const previous = historyRef.current.at(-1);
    if (!previous) return;
    historyRef.current = historyRef.current.slice(0, -1);
    setBlocks(previous);
    setHistoryCount(historyRef.current.length);
    setSelectedId((current) => previous.some((block) => block.id === current) ? current : null);
    setMessage("이전 편집 상태로 되돌렸습니다.");
  }

  function fitBlockToText(block: PdfTextBlock, text: string): Pick<PdfTextBlock, "width" | "height"> {
    if (block.sizingMode === "manual") return { width: block.width, height: block.height };
    const measureCanvas = window.document.createElement("canvas");
    const context = measureCanvas.getContext("2d");
    if (!context) return { width: block.width, height: block.height };
    context.font = `${block.style.fontStyle} ${block.style.fontWeight} ${block.style.fontSize}px ${block.style.fontFamily}`;
    const measuredWidth = Math.max(...text.split("\n").map((line) => context.measureText(line).width + 10));
    const pageWidth = canvasRef.current?.clientWidth ?? block.x + measuredWidth;
    const availableWidth = Math.max(block.sourceBox.width, pageWidth - block.x);
    const width = Math.min(Math.max(block.sourceBox.width, measuredWidth), availableWidth);
    const visualLines = text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil((context.measureText(line).width + 10) / width)), 0);
    return { width, height: Math.max(block.sourceBox.height, visualLines * block.style.fontSize * 1.25) };
  }

  async function translateBlock(block: PdfTextBlock, recordUndo = true) {
    setSelectedId(block.id);
    setDraggedBlockIds([]);
    if (block.translatedText || block.status === "translating") return;
    if (recordUndo) {
      setBlocks((current) => {
        saveHistory(current);
        return current;
      });
    }
    updateBlock(block.id, { status: "translating" }, false);
    setMessage(`“${block.originalText}” 번역 중…`);
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: block.originalText, sourceLanguage: "auto", targetLanguage: "ko" }),
      });
      const result = await response.json() as { translatedText?: string; mode?: "demo" | "openai"; message?: string };
      if (!response.ok || !result.translatedText) throw new Error(result.message ?? "번역 결과가 없습니다.");
      updateBlock(block.id, { translatedText: result.translatedText, status: "translated", mode: result.mode, ...fitBlockToText(block, result.translatedText) }, false);
      setMessage(result.mode === "demo" ? "데모 번역입니다. 실제 번역은 서버에 API 키를 설정하세요." : "번역이 완료되었습니다.");
    } catch (error) {
      updateBlock(block.id, { status: "error" }, false);
      setMessage(error instanceof Error ? error.message : "번역에 실패했습니다.");
    }
  }

  async function translateBlocks(selectedBlocks: PdfTextBlock[]) {
    if (selectedBlocks.length === 0) return;
    setBlocks((current) => {
      saveHistory(current);
      return current.map((block) => selectedBlocks.some((selectedBlock) => selectedBlock.id === block.id)
        ? { ...block, status: "translating" as const }
        : block);
    });
    setMessage(`${selectedBlocks.length}개 문장을 문맥 묶음으로 번역 중…`);

    try {
      const response = await fetch("/api/translate/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedBlocks.map((block) => ({ id: block.id, text: block.originalText })),
          sourceLanguage: "auto",
          targetLanguage: "ko",
        }),
      });
      const result = await response.json() as {
        translations?: Array<{ id: string; translatedText: string }>;
        mode?: "demo" | "openai";
        message?: string;
      };
      if (!response.ok || !result.translations) throw new Error(result.message ?? "묶음 번역 결과가 없습니다.");

      const translations = new Map(result.translations.map((item) => [item.id, item.translatedText]));
      updateBlocks((current) => current.map((block) => {
        const translatedText = translations.get(block.id);
        if (!translatedText) return block;
        return { ...block, translatedText, status: "translated" as const, mode: result.mode, ...fitBlockToText(block, translatedText) };
      }), false);

      const missing = selectedBlocks.filter((block) => !translations.has(block.id));
      await Promise.all(missing.map((block) => translateBlock({ ...block, status: "idle" }, false)));
      setSelectedId(null);
      setMessage(missing.length > 0 ? `묶음 번역 후 누락된 ${missing.length}개 문장을 개별 재번역했습니다.` : `${selectedBlocks.length}개 문장 번역을 완료했습니다.`);
    } catch {
      await Promise.all(selectedBlocks.map((block) => translateBlock({ ...block, status: "idle" }, false)));
      setSelectedId(null);
      setMessage("묶음 요청 실패 후 문장별 재번역을 완료했습니다.");
    }
  }

  function translateCurrentPage() {
    if (layoutPreviewOriginal) cancelLayoutPreview();
    setDraggedBlockIds([]);
    const untranslatedBlocks = pageBlocks
      .filter((block) => !block.translatedText && block.status !== "translating")
      .sort((a, b) => a.y - b.y || a.x - b.x);

    if (untranslatedBlocks.length === 0) {
      setMessage("현재 페이지의 모든 텍스트가 이미 번역되었습니다.");
      return;
    }

    void translateBlocks(untranslatedBlocks);
  }

  function pointerPosition(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function startDragSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (layoutPreviewOriginal) cancelLayoutPreview();
    const point = pointerPosition(event);
    didDragRef.current = false;
    const nextSelection = { startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
    dragSelectionRef.current = nextSelection;
    setDragSelection(nextSelection);
  }

  function moveDragSelection(event: React.PointerEvent<HTMLDivElement>) {
    const currentSelection = dragSelectionRef.current;
    if (!currentSelection) return;
    const point = pointerPosition(event);
    const distance = Math.hypot(point.x - currentSelection.startX, point.y - currentSelection.startY);
    if (distance >= dragThreshold && !didDragRef.current) {
      didDragRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const nextSelection = { ...currentSelection, currentX: point.x, currentY: point.y };
    dragSelectionRef.current = nextSelection;
    setDragSelection(nextSelection);
  }

  function finishDragSelection(event: React.PointerEvent<HTMLDivElement>) {
    const currentSelection = dragSelectionRef.current;
    if (!currentSelection) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = pointerPosition(event);
    const selection = normalizeRect(currentSelection.startX, currentSelection.startY, point.x, point.y);
    dragSelectionRef.current = null;
    setDragSelection(null);
    const wasDrag = didDragRef.current;
    didDragRef.current = false;
    if (!wasDrag || selection.width < dragThreshold || selection.height < dragThreshold) return;
    suppressClickUntilRef.current = Date.now() + 250;

    const matched = pageBlocks
      .filter((block) => overlapRatio(selection, block) >= 0.5)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (matched.length === 0) {
      setMessage("드래그 영역에서 번역할 텍스트를 찾지 못했습니다.");
      return;
    }

    setSelectedId(null);
    setDraggedBlockIds(matched.map((block) => block.id));
    void translateBlocks(matched);
  }

  function cancelDragSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragSelectionRef.current = null;
    didDragRef.current = false;
    setDragSelection(null);
  }

  const selectionRect = dragSelection
    ? normalizeRect(dragSelection.startX, dragSelection.startY, dragSelection.currentX, dragSelection.currentY)
    : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><LogoIcon /><span>LayLingo</span><small>MVP</small></div>
        <div className="file-name" title={fileName}>{fileName || "문서를 열어주세요"}</div>
        <div className="topbar-actions">
          <button className="undo-button" type="button" disabled={historyCount === 0} onClick={undo}><UndoIcon /> 되돌리기</button>
          <label className="primary-button"><UploadIcon /> PDF 열기<input type="file" accept="application/pdf,.pdf" onChange={(event) => event.target.files?.[0] && void openPdf(event.target.files[0])} /></label>
        </div>
      </header>

      <main className="workspace">
        <aside className="page-panel" aria-label="페이지 탐색">
          <div className="panel-heading"><span>페이지</span><span>{document?.numPages ?? 0}</span></div>
          {document ? Array.from({ length: document.numPages }, (_, index) => (
            <button key={index} className={`page-chip ${pageNumber === index + 1 ? "active" : ""}`} onClick={() => { if (layoutPreviewOriginal) cancelLayoutPreview(); setPageNumber(index + 1); setSelectedId(null); setDraggedBlockIds([]); }}><span>{index + 1}</span><span>페이지</span></button>
          )) : <p className="empty-copy">페이지가 여기에 표시됩니다.</p>}
        </aside>

        <section className="document-area" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void openPdf(file); }}>
          <div className="canvas-toolbar">
            <span>{document ? `${pageNumber} / ${document.numPages} · 드래그해서 영역 번역` : "PDF 미리보기"}</span>
            <div className="canvas-actions">
              {document && <button className="page-translate-button" type="button" disabled={pageBlocks.length === 0 || pageBlocks.some((block) => block.status === "translating")} onClick={translateCurrentPage}>현재 페이지 전체 번역</button>}
              <div className="zoom-controls"><button aria-label="축소" onClick={() => setScale((value) => Math.max(.65, value - .15))}>−</button><span>{Math.round(scale * 100)}%</span><button aria-label="확대" onClick={() => setScale((value) => Math.min(2.4, value + .15))}>＋</button></div>
            </div>
          </div>
          {!document ? (
            <label className="drop-zone"><UploadLargeIcon /><strong>번역할 PDF를 놓으세요</strong><span>또는 클릭해서 파일을 선택하세요 · 텍스트형 PDF 지원</span><input type="file" accept="application/pdf,.pdf" onChange={(event) => event.target.files?.[0] && void openPdf(event.target.files[0])} /></label>
          ) : (
            <div className="page-stage">
              {draggedBounds && <div className="group-actionbar" style={{ left: Math.max(8, draggedBounds.x), top: Math.max(8, draggedBounds.y - 58) }} role="group" aria-label="선택 영역 배치">
                <div className="group-actionbar-status">
                  <strong>선택 영역 {draggedBlocks.length}개</strong>
                  <span>{layoutPreviewMode ? "미리보기 중" : isTableSelection ? `표 구조 감지 · ${draggedOverlapCount}개 겹침` : draggedOverlapCount > 0 ? `${draggedOverlapCount}개 겹침` : "본문 영역 감지"}</span>
                </div>
                {!layoutPreviewMode ? <>
                  <button className={!isTableSelection ? "recommended" : ""} type="button" disabled={draggedBlocks.some((block) => block.status === "translating")} onClick={() => previewGroupLayout("paragraph")}>문단으로 재배치{!isTableSelection && <small>권장</small>}</button>
                  <button className={isTableSelection ? "recommended" : ""} type="button" disabled={draggedBlocks.some((block) => block.status === "translating")} onClick={() => previewGroupLayout("cells")}>원본 칸 유지{isTableSelection && <small>권장</small>}</button>
                  <button type="button" onClick={startManualGroupEdit}>직접 조정</button>
                  <button className="quiet" type="button" onClick={() => setDraggedBlockIds([])}>선택 해제</button>
                </> : <>
                  <button className="apply" type="button" onClick={applyLayoutPreview}>미리보기 적용</button>
                  <button type="button" onClick={() => previewGroupLayout(layoutPreviewMode === "paragraph" ? "cells" : "paragraph")}>다른 방식 보기</button>
                  <button className="quiet" type="button" onClick={cancelLayoutPreview}>취소</button>
                </>}
              </div>}
              <canvas ref={backgroundCanvasRef} className="pdf-background-canvas" />
              <canvas ref={canvasRef} className="pdf-foreground-canvas" />
              <div className="text-layer" style={{ width: canvasRef.current?.style.width, height: canvasRef.current?.style.height }} onPointerDown={startDragSelection} onPointerMove={moveDragSelection} onPointerUp={finishDragSelection} onPointerCancel={cancelDragSelection}>
                {pageBlocks.filter((block) => block.translatedText).map((block) => <SourceMask key={`mask-${block.id}`} block={block} sourceCanvas={backgroundCanvasRef.current} originalCanvas={foregroundBaseRef.current} />)}
                {pageBlocks.map((block) => (
                  <div key={block.id} role="button" tabIndex={0} className={`text-hitbox ${selectedId === block.id ? "selected" : ""} ${draggedBlockIds.includes(block.id) ? "group-selected" : ""} ${block.status} ${hasOverlap(block) && !draggedBlockIds.includes(block.id) ? "overlap" : ""}`} style={{ left: block.x, top: block.y, width: block.width, height: Math.max(block.height, 16) }} title={`${block.originalText} 번역`} aria-label={`${block.originalText} 번역`} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void translateBlock(block); }} onClick={(event) => { if (Date.now() < suppressClickUntilRef.current) { event.preventDefault(); return; } void translateBlock(block); }}>
                    {block.translatedText && !block.suppressed && <span className="translated-overlay" style={{ fontFamily: block.style.fontFamily, fontSize: block.style.fontSize, color: block.style.color, fontWeight: block.style.fontWeight, fontStyle: block.style.fontStyle, textAlign: block.style.textAlign, opacity: block.style.opacity, transform: `rotate(${block.style.rotation}deg)` }}>{block.translatedText}</span>}
                    {selectedId === block.id && <><span className="resize-handle left" aria-label="왼쪽 너비 조절" onPointerDown={(event) => startResize(block, "left", event)} /><span className="resize-handle right" aria-label="오른쪽 너비 조절" onPointerDown={(event) => startResize(block, "right", event)} /></>}
                  </div>
                ))}
                {selectionRect && didDragRef.current && <div className="drag-selection" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }} />}
              </div>
            </div>
          )}
        </section>

        <aside className="property-panel" aria-label="번역 및 텍스트 속성">
          <div className="panel-heading"><span>텍스트 속성</span>{selected?.mode && <span className={`mode-badge ${selected.mode}`}>{selected.mode === "demo" ? "데모" : "AI"}</span>}</div>
          {!selected ? <div className="empty-inspector"><PointerIcon /><strong>텍스트를 선택하세요</strong><p>문장을 클릭하거나 여러 문장을 드래그해서 번역합니다.</p></div> : (
            <div className="form-stack">
              <label>원문<textarea value={selected.originalText} readOnly rows={3} /></label>
              <label>번역문<textarea value={selected.translatedText} rows={4} placeholder={selected.status === "translating" ? "번역 중…" : "번역 결과"} onChange={(event) => { const translatedText = event.target.value; updateBlock(selected.id, { translatedText, ...fitBlockToText(selected, translatedText) }); }} /></label>
              <div className="field-divider" />
              <div className="field-row compact-fields">
                <label>X 위치<input type="number" min="0" max="2000" step="1" value={Math.round(selected.x)} onChange={(event) => updateBlock(selected.id, { x: Math.max(0, Number(event.target.value)), sizingMode: "manual" })} /></label>
                <label>Y 위치<input type="number" min="0" max="2000" step="1" value={Math.round(selected.y)} onChange={(event) => updateBlock(selected.id, { y: Math.max(0, Number(event.target.value)), sizingMode: "manual" })} /></label>
              </div>
              <div className="field-row compact-fields">
                <label>너비<input type="number" min="20" max="2000" step="1" value={Math.round(selected.width)} onChange={(event) => updateBlock(selected.id, { width: Math.max(20, Number(event.target.value)), sizingMode: "manual" })} /></label>
                <label>높이<input type="number" min="8" max="2000" step="1" value={Math.round(selected.height)} onChange={(event) => updateBlock(selected.id, { height: Math.max(8, Number(event.target.value)), sizingMode: "manual" })} /></label>
              </div>
              {hasOverlap(selected) && <button className="resolve-button" type="button" onClick={() => resolveOverlap(selected)}>겹침 자동 해소</button>}
              <button className="fit-button" type="button" onClick={() => updateBlock(selected.id, { sizingMode: "auto", ...fitBlockToText({ ...selected, sizingMode: "auto" }, selected.translatedText) })}>내용에 맞춤</button>
              <label>폰트<select value={selected.style.fontFamily} onChange={(event) => updateStyle({ fontFamily: event.target.value })}><option value="Pretendard, Noto Sans KR, sans-serif">Pretendard</option><option value="Noto Sans KR, sans-serif">Noto Sans KR</option><option value="Noto Serif KR, serif">Noto Serif KR</option><option value="Arial, sans-serif">Arial</option></select></label>
              <div className="field-row"><label>크기<input type="number" min="6" max="72" step="0.5" value={selected.style.fontSize} onChange={(event) => updateStyle({ fontSize: Number(event.target.value) })} /></label><label>색상<span className="color-field"><input type="color" value={selected.style.color} onChange={(event) => updateStyle({ color: event.target.value })} /><code>{selected.style.color.toUpperCase()}</code></span></label></div>
              <label>굵기<select value={selected.style.fontWeight} onChange={(event) => updateStyle({ fontWeight: Number(event.target.value) as TextStyle["fontWeight"] })}><option value="100">Thin</option><option value="200">Extra Light</option><option value="300">Light</option><option value="400">Regular</option><option value="500">Medium</option><option value="600">Semi Bold</option><option value="700">Bold</option><option value="800">Extra Bold</option><option value="900">Black</option></select></label>
              <label>정렬<div className="segmented">{(["left", "center", "right"] as const).map((align) => <button key={align} className={selected.style.textAlign === align ? "active" : ""} onClick={() => updateStyle({ textAlign: align })}>{align === "left" ? "왼쪽" : align === "center" ? "가운데" : "오른쪽"}</button>)}</div></label>
              {selected.status === "error" && <button className="retry-button" onClick={() => { updateBlock(selected.id, { translatedText: "", status: "idle" }); void translateBlock({ ...selected, translatedText: "", status: "idle" }, false); }}>다시 번역</button>}
            </div>
          )}
        </aside>
      </main>
      <footer className="statusbar" aria-live="polite"><span className="status-dot" />{message}<span className="privacy-note">파일은 브라우저 안에서만 열립니다.</span></footer>
    </div>
  );
}

function LogoIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h9a5 5 0 0 1 5 5v11H10a5 5 0 0 1-5-5V4Z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>; }
function UploadIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v4h14v-4"/></svg>; }
function UploadLargeIcon() { return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 31V9m0 0-8 8m8-8 8 8M10 29v9h28v-9"/></svg>; }
function PointerIcon() { return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="m15 9 19 15-10 2 6 10-5 3-6-10-7 8 3-28Z"/></svg>; }
function UndoIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6"/></svg>; }

function SourceMask({ block, sourceCanvas, originalCanvas }: { block: PdfTextBlock; sourceCanvas: HTMLCanvasElement | null; originalCanvas: HTMLCanvasElement | null }) {
  const maskRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const mask = maskRef.current;
    if (!mask || !sourceCanvas || !originalCanvas) return;
    const padding = Math.max(4, Math.ceil(block.style.fontSize * 0.35));
    const pixelScale = sourceCanvas.width / Math.max(sourceCanvas.clientWidth, 1);
    const width = block.sourceBox.width + padding * 2;
    const height = block.sourceBox.height + padding * 2;
    mask.width = Math.ceil(width * pixelScale);
    mask.height = Math.ceil(height * pixelScale);
    mask.style.width = `${width}px`;
    mask.style.height = `${height}px`;
    const context = mask.getContext("2d", { willReadFrequently: true });
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    const originalContext = originalCanvas.getContext("2d", { willReadFrequently: true });
    if (!context || !sourceContext || !originalContext) return;

    const sourceX = Math.max(0, Math.floor((block.sourceBox.x - padding) * pixelScale));
    const sourceY = Math.max(0, Math.floor((block.sourceBox.y - padding) * pixelScale));
    const sampleWidth = Math.min(mask.width, sourceCanvas.width - sourceX);
    const sampleHeight = Math.min(mask.height, sourceCanvas.height - sourceY);

    try {
      const background = sourceContext.getImageData(sourceX, sourceY, sampleWidth, sampleHeight);
      const original = originalContext.getImageData(sourceX, sourceY, sampleWidth, sampleHeight);
      let difference = 0;
      for (let index = 0; index < background.data.length; index += 4) {
        difference += Math.abs(background.data[index] - original.data[index]);
        difference += Math.abs(background.data[index + 1] - original.data[index + 1]);
        difference += Math.abs(background.data[index + 2] - original.data[index + 2]);
      }
      const averageDifference = difference / Math.max((background.data.length / 4) * 3, 1);

      // 일반 텍스트가 정상 제거되었다면 PDF의 실제 도형·셀 배경을 그대로 보존한다.
      // 차이가 거의 없으면 윤곽선·이미지형 글자로 보고 경계 기반 복원을 사용한다.
      context.putImageData(averageDifference >= 1.5 ? background : restoreBackground(background), 0, 0);
    } catch {
      context.fillStyle = sampleBoundaryColor(sourceContext, sourceX, sourceY, sampleWidth, sampleHeight);
      context.fillRect(0, 0, mask.width, mask.height);
    }
  }, [block.sourceBox, block.style.fontSize, originalCanvas, sourceCanvas]);

  const padding = Math.max(4, Math.ceil(block.style.fontSize * 0.35));
  return <canvas ref={maskRef} className="source-mask" style={{ left: block.sourceBox.x - padding, top: block.sourceBox.y - padding }} aria-hidden="true" />;
}

function restoreBackground(source: ImageData) {
  const boundaryPixels: Array<[number, number, number]> = [];
  const lastX = Math.max(source.width - 1, 0);
  const lastY = Math.max(source.height - 1, 0);
  const addPixel = (x: number, y: number) => {
    const index = (y * source.width + x) * 4;
    boundaryPixels.push([source.data[index], source.data[index + 1], source.data[index + 2]]);
  };

  for (let x = 0; x < source.width; x += 1) {
    addPixel(x, 0);
    if (lastY > 0) addPixel(x, lastY);
  }
  for (let y = 1; y < lastY; y += 1) {
    addPixel(0, y);
    if (lastX > 0) addPixel(lastX, y);
  }

  const buckets = new Map<string, { count: number; sum: [number, number, number] }>();
  for (const pixel of boundaryPixels) {
    const key = pixel.map((channel) => Math.round(channel / 16)).join(":");
    const bucket = buckets.get(key) ?? { count: 0, sum: [0, 0, 0] };
    bucket.count += 1;
    bucket.sum[0] += pixel[0];
    bucket.sum[1] += pixel[1];
    bucket.sum[2] += pixel[2];
    buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];

  if (dominant && dominant.count / Math.max(boundaryPixels.length, 1) >= 0.55) {
    const output = new ImageData(source.width, source.height);
    const color = dominant.sum.map((value) => Math.round(value / dominant.count));
    for (let index = 0; index < output.data.length; index += 4) {
      output.data[index] = color[0];
      output.data[index + 1] = color[1];
      output.data[index + 2] = color[2];
      output.data[index + 3] = 255;
    }
    return output;
  }

  return inpaintFromBoundary(source);
}

function inpaintFromBoundary(source: ImageData) {
  const output = new ImageData(source.width, source.height);
  const lastX = Math.max(source.width - 1, 0);
  const lastY = Math.max(source.height - 1, 0);

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const targetIndex = (y * source.width + x) * 4;
      const leftIndex = (y * source.width) * 4;
      const rightIndex = (y * source.width + lastX) * 4;
      const topIndex = x * 4;
      const bottomIndex = (lastY * source.width + x) * 4;
      const horizontalRatio = lastX === 0 ? 0 : x / lastX;
      const verticalRatio = lastY === 0 ? 0 : y / lastY;

      for (let channel = 0; channel < 3; channel += 1) {
        const horizontal = source.data[leftIndex + channel] * (1 - horizontalRatio) + source.data[rightIndex + channel] * horizontalRatio;
        const vertical = source.data[topIndex + channel] * (1 - verticalRatio) + source.data[bottomIndex + channel] * verticalRatio;
        output.data[targetIndex + channel] = Math.round((horizontal + vertical) / 2);
      }
      output.data[targetIndex + 3] = 255;
    }
  }
  return output;
}

function sampleBoundaryColor(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  try {
    const samples = [
      context.getImageData(x, y, 1, 1).data,
      context.getImageData(Math.max(x + width - 1, x), y, 1, 1).data,
      context.getImageData(x, Math.max(y + height - 1, y), 1, 1).data,
      context.getImageData(Math.max(x + width - 1, x), Math.max(y + height - 1, y), 1, 1).data,
    ];
    const color = [0, 1, 2].map((channel) => Math.round(samples.reduce((sum, sample) => sum + sample[channel], 0) / samples.length));
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  } catch {
    return "#ffffff";
  }
}
