"use client";

import {
  ChangeEvent,
  DragEvent,
  Fragment,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Category = "PII" | "Financial" | "Identity" | "Network";
type Phase = "hero" | "review" | "done";
type Confidence = "high" | "review";
type Rect = { page: number; x: number; y: number; width: number; height: number };
type Finding = {
  id: string;
  label: string;
  detail: string;
  detector: string;
  kind: Category;
  confidence: Confidence;
  selected: boolean;
  manual?: boolean;
  rects: Rect[];
};
type VerificationResult = {
  passed: boolean;
  pageCount: number;
  extractedCharacters: number;
  checkedRegions: number;
  totalRegions: number;
};
type LocalInspection = {
  pdfType: "TextBased" | "Scanned" | "ImageBased" | "Mixed";
  pageCount: number;
  pagesNeedingOcr: number[];
  confidence: number;
  processingTimeMs: number;
  hasEncodingIssues: boolean;
  layout: { isComplex: boolean; pagesWithTables: number[]; pagesWithColumns: number[] };
  version: string;
};

const categoryMeta: Record<Category, { label: string; className: string }> = {
  PII: { label: "Personal", className: "meta-purple" },
  Financial: { label: "Financial", className: "meta-pink" },
  Identity: { label: "Identity", className: "meta-amber" },
  Network: { label: "Network", className: "meta-cyan" },
};

type DetectionRule = {
  kind: Category;
  label: string;
  expression: RegExp;
  confidence: Confidence;
  assess?: (value: string) => Confidence | false;
};

const digitsOnly = (value: string) => value.replace(/\D/g, "");
const normalizedValue = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const isLuhnValid = (value: string) => {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};
const isIbanValid = (value: string) => {
  const compact = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = [...rearranged].map((character) => /\d/.test(character) ? character : String(character.charCodeAt(0) - 55)).join("");
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
};
const isIpValid = (value: string) => value.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
const isPhoneLike = (value: string) => {
  const digits = digitsOnly(value);
  return digits.length >= 7 && digits.length <= 15 && !/^(\d)\1+$/.test(digits);
};

const rules: DetectionRule[] = [
  { kind: "PII", label: "Email address", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: "high" },
  { kind: "PII", label: "Phone number", expression: /(?<!\w)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)?\d{3,4}[ .-]\d{3,4}(?!\w)/g, confidence: "review", assess: (value) => isPhoneLike(value) ? "review" : false },
  { kind: "Financial", label: "IBAN", expression: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, confidence: "high", assess: (value) => isIbanValid(value) ? "high" : "review" },
  { kind: "Financial", label: "Payment card or long account number", expression: /\b(?:\d[ -]*?){13,19}\b/g, confidence: "review", assess: (value) => isLuhnValid(value) ? "high" : "review" },
  { kind: "Financial", label: "Indian bank routing code (IFSC)", expression: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, confidence: "high" },
  { kind: "Financial", label: "UPI payment address", expression: /\b[A-Z0-9._-]{2,}@(upi|okaxis|okhdfcbank|oksbi|ybl|paytm|ibl|axl)\b/gi, confidence: "high" },
  { kind: "Financial", label: "Account or transaction reference", expression: /\b(?:CUST|ACCT|ACC|CARD|UPI-PS|PAY|TRF|REF|POL)[-A-Z0-9/]{5,}\b/gi, confidence: "review" },
  { kind: "Identity", label: "PAN identity number", expression: /\b[A-Z]{5}\d{4}[A-Z]\b/g, confidence: "high" },
  { kind: "Identity", label: "Aadhaar-style identity number", expression: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, confidence: "review", assess: (value) => /^(\d)\1+$/.test(digitsOnly(value)) ? false : "review" },
  { kind: "Identity", label: "US Social Security number", expression: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g, confidence: "high" },
  { kind: "Network", label: "IP address", expression: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, confidence: "high", assess: (value) => isIpValid(value) ? "high" : false },
  { kind: "Network", label: "Web address", expression: /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, confidence: "high" },
];

let pdfModule: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;
const getPdf = async () => {
  pdfModule ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfModule;
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
  }
  return pdfjs;
};

const inspectLocally = (bytes: Uint8Array) => new Promise<LocalInspection>((resolve, reject) => {
  const worker = new Worker(new URL("./pdf-inspector.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  const timeout = window.setTimeout(() => {
    worker.terminate();
    reject(new Error("Local PDF inspection timed out"));
  }, 45_000);
  const finish = () => {
    window.clearTimeout(timeout);
    worker.terminate();
  };
  worker.onerror = (event) => {
    finish();
    reject(new Error(event.message || "Local PDF inspection failed"));
  };
  worker.onmessage = (event: MessageEvent<{
    id: string;
    ok: boolean;
    result?: Omit<LocalInspection, "version">;
    version?: string;
    error?: string;
  }>) => {
    if (event.data.id !== id) return;
    finish();
    if (!event.data.ok || !event.data.result) {
      reject(new Error(event.data.error || "Local PDF inspection failed"));
      return;
    }
    resolve({ ...event.data.result, version: event.data.version || "unknown" });
  };
  const transferable = bytes.slice().buffer as ArrayBuffer;
  worker.postMessage({ id, bytes: transferable }, [transferable]);
});

type PageSize = { width: number; height: number };
type DraftRect = { x: number; y: number; width: number; height: number };
type TextItem = { text: string; rect: Rect };
type TextLine = { page: number; text: string; items: TextItem[] };
type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const cloneFindings = (items: Finding[]) => items.map((item) => ({
  ...item,
  rects: item.rects.map((rect) => ({ ...rect })),
}));

const groupTextLines = (items: TextItem[]) => {
  const lines: Array<{ y: number; height: number; items: TextItem[] }> = [];
  for (const item of [...items].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.rect.y) <= Math.max(4, item.rect.height * .55));
    if (line) {
      line.items.push(item);
      line.y = Math.min(line.y, item.rect.y);
      line.height = Math.max(line.height, item.rect.height);
    } else {
      lines.push({ y: item.rect.y, height: item.rect.height, items: [item] });
    }
  }
  return lines
    .map((line) => ({ ...line, items: line.items.sort((a, b) => a.rect.x - b.rect.x) }))
    .sort((a, b) => a.y - b.y);
};

const textForLine = (items: TextItem[]) => items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
const rectsForTextRange = (items: TextItem[], start: number, length: number) => {
  const rects: Rect[] = [];
  let cursor = 0;
  const end = start + length;
  items.forEach((item, index) => {
    const itemStart = cursor;
    const itemEnd = itemStart + item.text.length;
    const overlapStart = Math.max(start, itemStart);
    const overlapEnd = Math.min(end, itemEnd);
    if (overlapEnd > overlapStart) {
      const leftRatio = (overlapStart - itemStart) / Math.max(item.text.length, 1);
      const rightRatio = (overlapEnd - itemStart) / Math.max(item.text.length, 1);
      rects.push({
        ...item.rect,
        x: item.rect.x + item.rect.width * leftRatio - 1,
        width: Math.max(item.rect.width * (rightRatio - leftRatio) + 2, 8),
      });
    }
    cursor = itemEnd + (index < items.length - 1 ? 1 : 0);
  });
  return rects;
};
const mergeRectsOnLine = (rects: Rect[]) => {
  if (!rects.length) return [];
  const page = rects[0].page;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return [{ page, x, y, width: right - x, height: bottom - y }];
};
const mergeRectsByVisualLine = (rects: Rect[]) => {
  const groups: Rect[][] = [];
  for (const rect of rects) {
    const group = groups.find((candidate) => candidate[0].page === rect.page && Math.abs(candidate[0].y - rect.y) <= Math.max(4, rect.height * .55));
    if (group) group.push(rect);
    else groups.push([rect]);
  }
  return groups.flatMap(mergeRectsOnLine);
};

const likelyName = /\b[A-Z][a-zÀ-ÿ'’-]{1,30}(?:\s+[A-Z][a-zÀ-ÿ'’-]{1,30}){1,3}\b/g;
const labelledName = /\b(?:account holder|client name|customer name|full name|beneficiary|recipient|payee)\s*:?\s+([A-Z][a-zÀ-ÿ'’-]{1,30}(?:\s+[A-Z][a-zÀ-ÿ'’-]{1,30}){1,3})/i;
const nameStopPhrases = /^(?:Private Client|Client Details|Transaction Activity|Statement Summary|Test Document|Northstar Bank|Residential Address)$/i;

const addressAnchor = /\b\d{1,6}[A-Za-z]?(?:\s*[-/]\s*\d{1,6})?\s+[A-Za-z0-9.'’ -]{2,80}\b(?:Avenue|Ave|Street|St|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Highway|Hwy|Way|Court|Ct|Place|Pl|Terrace|Close|Square)\b[,.]?/i;
const addressContinuation = /(?:\b[A-Z]{1,3}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b\d{5}(?:-\d{4})?\b|\b\d{6}\b|\b(?:apartment|apt|suite|unit|floor|city|state|province|county|postcode|postal|zip|india|united kingdom|uk|usa|canada|australia)\b|^[A-Za-zÀ-ÿ.'’, -]{3,55}$)/i;
const addressStop = /\b(?:transaction|date|description|amount|balance|statement|invoice|subtotal|total|iban|account|email|phone)\b/i;

const canvasToPngBytes = (canvas: HTMLCanvasElement) => new Promise<Uint8Array>((resolve, reject) => {
  canvas.toBlob(async (blob) => {
    if (!blob) {
      reject(new Error("The rendered page could not be encoded"));
      return;
    }
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, "image/png");
});

const darkRegionSamples = (context: CanvasRenderingContext2D, rect: Rect, width: number, height: number) => {
  const ratios = [.25, .5, .75];
  return ratios.every((xRatio) => ratios.every((yRatio) => {
    const x = Math.max(0, Math.min(width - 1, Math.round(rect.x + rect.width * xRatio)));
    const y = Math.max(0, Math.min(height - 1, Math.round(rect.y + rect.height * yRatio)));
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    return alpha > 220 && (red + green + blue) / 3 < 55;
  }));
};

const verifyRedactedPdf = async (bytes: Uint8Array, selectedRects: Rect[], expectedPages: number): Promise<VerificationResult> => {
  const pdfjs = await getPdf();
  const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
  const document = await loadingTask.promise;
  let extractedCharacters = 0;
  let checkedRegions = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      extractedCharacters += textContent.items.reduce((total, item) => total + ("str" in item ? item.str.trim().length : 0), 0);
      const pageRects = selectedRects.filter((rect) => rect.page === pageNumber);
      if (!pageRects.length) continue;
      const viewport = page.getViewport({ scale: 1 });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas unavailable during verification");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      checkedRegions += pageRects.filter((rect) => darkRegionSamples(context, rect, canvas.width, canvas.height)).length;
    }
  } finally {
    await loadingTask.destroy();
  }
  return {
    passed: document.numPages === expectedPages && extractedCharacters === 0 && checkedRegions === selectedRects.length,
    pageCount: document.numPages,
    extractedCharacters,
    checkedRegions,
    totalRegions: selectedRects.length,
  };
};

function PdfPageView({
  bytes,
  pageNumber,
  zoom,
  findings,
  activeFindingId,
  selectedFindingIds,
  drawing,
  previewRedactions,
  onActivate,
  onClearSelection,
  onSelectMany,
  onManualRect,
  onEditStart,
  onUpdateRect,
  onDeleteFinding,
  onConfirmFinding,
}: {
  bytes: Uint8Array;
  pageNumber: number;
  zoom: number;
  findings: Finding[];
  activeFindingId: string | null;
  selectedFindingIds: Set<string>;
  drawing: boolean;
  previewRedactions: boolean;
  onActivate: (id: string, additive: boolean) => void;
  onClearSelection: () => void;
  onSelectMany: (ids: string[], additive: boolean) => void;
  onManualRect: (rect: Rect) => void;
  onEditStart: () => void;
  onUpdateRect: (findingId: string, rectIndex: number, rect: Rect) => void;
  onDeleteFinding: (findingId: string) => void;
  onConfirmFinding: (findingId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const [pageSize, setPageSize] = useState<PageSize>({ width: 0, height: 0 });
  const [draft, setDraft] = useState<DraftRect | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<DraftRect | null>(null);
  const [renderError, setRenderError] = useState("");
  const editRef = useRef<{
    findingId: string;
    rectIndex: number;
    mode: "move" | ResizeDirection;
    clientX: number;
    clientY: number;
    original: Rect;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    let loadingTask: ReturnType<Awaited<ReturnType<typeof getPdf>>["getDocument"]> | undefined;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | undefined;

    const renderPage = async () => {
      try {
        setRenderError("");
        setPageSize({ width: 0, height: 0 });
        const pdfjs = await getPdf();
        loadingTask = pdfjs.getDocument({ data: bytes.slice() });
        const document = await loadingTask.promise;
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        if (!canvas || disposed) return;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        const completedTask = loadingTask;
        loadingTask = undefined;
        await completedTask.destroy();
      } catch (error) {
        if (!disposed && (error as { name?: string }).name !== "RenderingCancelledException") {
          console.error(error);
          setRenderError("This page could not be displayed.");
        }
      }
    };

    void renderPage();
    return () => {
      disposed = true;
      renderTask?.cancel();
      const unfinishedTask = loadingTask;
      loadingTask = undefined;
      void unfinishedTask?.destroy();
    };
  }, [bytes, pageNumber, zoom]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(pageSize.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(pageSize.height, event.clientY - bounds.top)),
    };
  };

  const beginDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".redaction-box, .redaction-box-actions")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    drawStartRef.current = point;
    setDraft({ ...point, width: 0, height: 0 });
  };

  const beginSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing || previewRedactions || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".redaction-box, .redaction-box-actions")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    selectionStartRef.current = point;
    setSelectionDraft({ ...point, width: 0, height: 0 });
    if (!event.metaKey && !event.ctrlKey) onClearSelection();
  };

  const beginOverlayInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".redaction-box, .redaction-box-actions")) return;
    if (previewRedactions) {
      if (!event.metaKey && !event.ctrlKey) onClearSelection();
      return;
    }
    if (drawing) beginDraw(event);
    else beginSelection(event);
  };

  const continueDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drawStartRef.current;
    if (!drawing || !start) return;
    const point = pointFromEvent(event);
    setDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const continueSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = selectionStartRef.current;
    if (drawing || !start) return;
    const point = pointFromEvent(event);
    setSelectionDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const continueOverlayInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing) continueDraw(event);
    else continueSelection(event);
  };

  const finishDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drawStartRef.current;
    if (!drawing || !start) return;
    const point = pointFromEvent(event);
    const finished = {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    };
    drawStartRef.current = null;
    setDraft(null);
    if (finished.width < 8 || finished.height < 8) return;
    onManualRect({
      page: pageNumber,
      x: finished.x / zoom,
      y: finished.y / zoom,
      width: finished.width / zoom,
      height: finished.height / zoom,
    });
  };

  const finishSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = selectionStartRef.current;
    if (drawing || !start) return;
    const point = pointFromEvent(event);
    const finished = {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    };
    selectionStartRef.current = null;
    setSelectionDraft(null);
    if (finished.width < 6 || finished.height < 6) return;
    const selectionRect = {
      page: pageNumber,
      x: finished.x / zoom,
      y: finished.y / zoom,
      width: finished.width / zoom,
      height: finished.height / zoom,
    };
    const selectedIds = pageRects.filter(({ rect }) => (
      rect.x < selectionRect.x + selectionRect.width
      && rect.x + rect.width > selectionRect.x
      && rect.y < selectionRect.y + selectionRect.height
      && rect.y + rect.height > selectionRect.y
    )).map(({ finding }) => finding.id);
    onSelectMany([...new Set(selectedIds)], event.metaKey || event.ctrlKey);
  };

  const finishOverlayInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing) finishDraw(event);
    else finishSelection(event);
  };

  const beginEdit = (event: ReactPointerEvent<HTMLButtonElement>, findingId: string, rectIndex: number, rect: Rect) => {
    if (previewRedactions || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onEditStart();
    onActivate(findingId, false);
    const requestedHandle = (event.target as HTMLElement).dataset.handle;
    editRef.current = {
      findingId,
      rectIndex,
      mode: requestedHandle && ["n", "ne", "e", "se", "s", "sw", "w", "nw"].includes(requestedHandle)
        ? requestedHandle as ResizeDirection
        : "move",
      clientX: event.clientX,
      clientY: event.clientY,
      original: { ...rect },
    };
  };

  const continueEdit = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const edit = editRef.current;
    if (!edit) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - edit.clientX) / zoom;
    const dy = (event.clientY - edit.clientY) / zoom;
    const maxWidth = pageSize.width / zoom;
    const maxHeight = pageSize.height / zoom;
    const next = { ...edit.original };
    if (edit.mode === "move") {
      next.x = Math.max(0, Math.min(maxWidth - edit.original.width, edit.original.x + dx));
      next.y = Math.max(0, Math.min(maxHeight - edit.original.height, edit.original.y + dy));
    } else {
      const minimum = 8 / zoom;
      const originalRight = edit.original.x + edit.original.width;
      const originalBottom = edit.original.y + edit.original.height;
      if (edit.mode.includes("e")) {
        next.width = Math.max(minimum, Math.min(maxWidth - edit.original.x, edit.original.width + dx));
      }
      if (edit.mode.includes("s")) {
        next.height = Math.max(minimum, Math.min(maxHeight - edit.original.y, edit.original.height + dy));
      }
      if (edit.mode.includes("w")) {
        next.x = Math.max(0, Math.min(originalRight - minimum, edit.original.x + dx));
        next.width = originalRight - next.x;
      }
      if (edit.mode.includes("n")) {
        next.y = Math.max(0, Math.min(originalBottom - minimum, edit.original.y + dy));
        next.height = originalBottom - next.y;
      }
    }
    onUpdateRect(edit.findingId, edit.rectIndex, next);
  };

  const pageRects = findings.flatMap((finding) =>
    finding.rects
      .map((rect, index) => ({ finding, rect, index }))
      .filter(({ rect }) => rect.page === pageNumber),
  );

  return <div
    className={`pdf-page-shell ${drawing ? "drawing" : ""} ${previewRedactions ? "preview-redactions" : ""}`}
    style={pageSize.width ? { width: pageSize.width, height: pageSize.height } : undefined}
  >
    <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
    {!pageSize.width && !renderError && <div className="page-loading">Rendering page {pageNumber}…</div>}
    {renderError && <div className="page-loading error">{renderError}</div>}
    {pageSize.width > 0 && <div
      className="pdf-overlay"
      onPointerDown={beginOverlayInteraction}
      onPointerMove={continueOverlayInteraction}
      onPointerUp={finishOverlayInteraction}
      onPointerCancel={() => { drawStartRef.current = null; selectionStartRef.current = null; setDraft(null); setSelectionDraft(null); }}
    >
      {pageRects.map(({ finding, rect, index }) => <Fragment key={`${finding.id}-${index}`}>
        <button
          type="button"
          className={`redaction-box ${finding.selected ? "will-redact" : "will-keep"} ${finding.manual ? "manual" : ""} ${activeFindingId === finding.id ? "active" : ""} ${selectedFindingIds.has(finding.id) ? "bulk-selected" : ""}`}
          style={{
            left: rect.x * zoom,
            top: rect.y * zoom,
            width: rect.width * zoom,
            height: rect.height * zoom,
          }}
          onPointerDown={(event) => beginEdit(event, finding.id, index, rect)}
          onPointerMove={continueEdit}
          onPointerUp={(event) => { event.stopPropagation(); editRef.current = null; }}
          onPointerCancel={() => { editRef.current = null; }}
          onClick={(event) => { event.stopPropagation(); onActivate(finding.id, event.metaKey || event.ctrlKey); }}
          title={`${finding.selected ? "Will redact" : "Will keep"}: ${finding.label}`}
          aria-label={`${finding.selected ? "Redact" : "Keep"} ${finding.label}`}
        >
          {(["n", "ne", "e", "se", "s", "sw", "w", "nw"] as ResizeDirection[]).map((direction) =>
            <span key={direction} className={`resize-handle handle-${direction}`} data-handle={direction} aria-hidden="true" />)}
        </button>
        {!previewRedactions && activeFindingId === finding.id && selectedFindingIds.size === 1 && <div
          className={`redaction-box-actions ${finding.manual ? "manual-actions" : "detected-actions"}`}
          style={{ left: (rect.x + rect.width) * zoom - (finding.manual ? 34 : 70), top: rect.y * zoom - 38 }}
        >
          {!finding.manual && <button
            type="button"
            className="box-action confirm-box-action"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onConfirmFinding(finding.id); }}
            aria-label="Confirm detected redaction"
            title="Confirm redaction"
          >✓</button>}
          <button
            type="button"
            className="box-action delete-box-action"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onDeleteFinding(finding.id); }}
            aria-label={finding.manual ? "Delete selected manual redaction" : "Delete detected redaction"}
            title="Delete redaction"
          ><span className="trash-icon" aria-hidden="true" /></button>
        </div>}
      </Fragment>)}
      {draft && <span className="redaction-draft" style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height }} />}
      {selectionDraft && <span className="selection-marquee" style={{ left: selectionDraft.x, top: selectionDraft.y, width: selectionDraft.width, height: selectionDraft.height }} />}
    </div>}
  </div>;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<Finding[][]>([]);
  const redoRef = useRef<Finding[][]>([]);
  const exportedPdfRef = useRef<Uint8Array | null>(null);
  const occurrenceRef = useRef(new Map<string, number>());
  const stageRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("hero");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [extractedLines, setExtractedLines] = useState<TextLine[]>([]);
  const [customTerms, setCustomTerms] = useState("");
  const [filter, setFilter] = useState<Category | "All">("All");
  const [message, setMessage] = useState("");
  const [scannedPdfDetected, setScannedPdfDetected] = useState(false);
  const [activePage, setActivePage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [drawing, setDrawing] = useState(false);
  const [previewRedactions, setPreviewRedactions] = useState(false);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(() => new Set());
  const [inspection, setInspection] = useState<LocalInspection | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const selectedCount = findings.filter((finding) => finding.selected).length;
  const bulkSelectionCount = selectedFindingIds.size;
  const reviewCount = findings.filter((finding) => finding.confidence === "review").length;
  const filteredFindings = useMemo(
    () => filter === "All" ? findings : findings.filter((finding) => finding.kind === filter),
    [filter, findings],
  );
  const usedCategories = useMemo(() => [...new Set(findings.map((finding) => finding.kind))], [findings]);

  const goToPage = (requestedPage: number, behavior: ScrollBehavior = "smooth") => {
    const page = Math.max(1, Math.min(pageCount, requestedPage));
    setActivePage(page);
    window.requestAnimationFrame(() => {
      const stage = stageRef.current;
      const entry = stage?.querySelector<HTMLElement>(`[data-page="${page}"]`);
      if (!stage || !entry) return;
      const stageBounds = stage.getBoundingClientRect();
      const entryBounds = entry.getBoundingClientRect();
      stage.scrollTo({ top: stage.scrollTop + entryBounds.top - stageBounds.top - 16, behavior });
    });
  };

  const updatePageFromScroll = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const stageBounds = stage.getBoundingClientRect();
    const focusLine = stageBounds.top + Math.min(stage.clientHeight * .35, 260);
    let closestPage = activePage;
    let closestDistance = Number.POSITIVE_INFINITY;
    stage.querySelectorAll<HTMLElement>("[data-page]").forEach((entry) => {
      const page = Number(entry.dataset.page);
      const bounds = entry.getBoundingClientRect();
      const distance = Math.abs(bounds.top - focusLine);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = page;
      }
    });
    if (closestPage !== activePage) {
      setActivePage(closestPage);
      setActiveFindingId(null);
    }
  };

  const checkpoint = () => {
    historyRef.current = [...historyRef.current.slice(-29), cloneFindings(findings)];
    redoRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  };

  const undo = () => {
    const previous = historyRef.current.at(-1);
    if (!previous) return;
    redoRef.current = [...redoRef.current.slice(-29), cloneFindings(findings)];
    historyRef.current = historyRef.current.slice(0, -1);
    setFindings(previous);
    setActiveFindingId(null);
    setSelectedFindingIds(new Set());
    setCanUndo(historyRef.current.length > 0);
    setCanRedo(true);
    setMessage("Last redaction edit undone.");
  };

  const redo = () => {
    const next = redoRef.current.at(-1);
    if (!next) return;
    historyRef.current = [...historyRef.current.slice(-29), cloneFindings(findings)];
    redoRef.current = redoRef.current.slice(0, -1);
    setFindings(next);
    setActiveFindingId(null);
    setSelectedFindingIds(new Set());
    setCanUndo(true);
    setCanRedo(redoRef.current.length > 0);
    setMessage("Last undone redaction edit restored.");
  };

  useEffect(() => {
    if (!activeFindingId) return;
    document.getElementById(`finding-${activeFindingId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeFindingId]);

  useEffect(() => {
    const handleEditorKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      const key = event.key.toLocaleLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      const wantsUndo = modifier && key === "z" && !event.shiftKey;
      const wantsRedo = modifier && ((key === "z" && event.shiftKey) || key === "y");
      if (wantsUndo) {
        const previous = historyRef.current.at(-1);
        if (!previous) return;
        event.preventDefault();
        redoRef.current = [...redoRef.current.slice(-29), cloneFindings(findings)];
        historyRef.current = historyRef.current.slice(0, -1);
        setFindings(previous);
        setActiveFindingId(null);
        setSelectedFindingIds(new Set());
        setCanUndo(historyRef.current.length > 0);
        setCanRedo(true);
        setMessage("Last redaction edit undone.");
        return;
      }
      if (wantsRedo) {
        const next = redoRef.current.at(-1);
        if (!next) return;
        event.preventDefault();
        historyRef.current = [...historyRef.current.slice(-29), cloneFindings(findings)];
        redoRef.current = redoRef.current.slice(0, -1);
        setFindings(next);
        setActiveFindingId(null);
        setSelectedFindingIds(new Set());
        setCanUndo(true);
        setCanRedo(redoRef.current.length > 0);
        setMessage("Last undone redaction edit restored.");
        return;
      }
      if (event.key === "Escape") {
        if (drawing) {
          setDrawing(false);
          setMessage("Drawing mode stopped.");
        } else {
          setActiveFindingId(null);
          setSelectedFindingIds(new Set());
        }
        return;
      }
      if ((event.key !== "Delete" && event.key !== "Backspace") || !selectedFindingIds.size) return;
      event.preventDefault();
      historyRef.current = [...historyRef.current.slice(-29), cloneFindings(findings)];
      redoRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
      setFindings((items) => items.filter((item) => !selectedFindingIds.has(item.id)));
      setActiveFindingId(null);
      setSelectedFindingIds(new Set());
      setMessage(`${selectedFindingIds.size} selected ${selectedFindingIds.size === 1 ? "box" : "boxes"} deleted.`);
    };
    window.addEventListener("keydown", handleEditorKeys);
    return () => window.removeEventListener("keydown", handleEditorKeys);
  }, [drawing, findings, selectedFindingIds]);

  useEffect(() => {
    if (!activeFindingId) return;
    const clearControlsOutsideFinding = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".redaction-box, .redaction-box-actions, .suggestion-card, .bulk-selection-toolbar")) return;
      setActiveFindingId(null);
      if (selectedFindingIds.size <= 1) setSelectedFindingIds(new Set());
    };
    window.addEventListener("pointerdown", clearControlsOutsideFinding, true);
    return () => window.removeEventListener("pointerdown", clearControlsOutsideFinding, true);
  }, [activeFindingId, selectedFindingIds.size]);

  const analyzeFile = async (file?: File) => {
    if (!file) return;
    setScannedPdfDetected(false);
    setMessage("");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setMessage("Please choose a PDF document.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setMessage("Please choose a PDF smaller than 50 MB for reliable local processing.");
      return;
    }
    setFileName(file.name);
    setFindings([]);
    setExtractedLines([]);
    setCustomTerms("");
    setActivePage(1);
    setZoom(1);
    setDrawing(false);
    setPreviewRedactions(false);
    setActiveFindingId(null);
    setSelectedFindingIds(new Set());
    setInspection(null);
    setVerification(null);
    exportedPdfRef.current = null;
    occurrenceRef.current.clear();
    historyRef.current = [];
    redoRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setAnalyzing(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setFileBytes(bytes);
      let inspectionPromise: Promise<LocalInspection | null> | null = null;
      const pdfjs = await getPdf();
      const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      const pdfDocument = await loadingTask.promise;
      setPageCount(pdfDocument.numPages);
      const found = new Map<string, Finding>();
      const documentLines: TextLine[] = [];
      const pagesWithoutText: number[] = [];
      let extractedCharacterCount = 0;
      const registerFinding = ({
        label,
        detector,
        kind,
        confidence,
        page,
        rects,
      }: {
        label: string;
        detector: string;
        kind: Category;
        confidence: Confidence;
        page: number;
        rects: Rect[];
      }) => {
        if (!rects.length || !normalizedValue(label)) return;
        const key = `${kind}:${detector}:${normalizedValue(label)}`;
        const existing = found.get(key);
        if (existing) {
          existing.rects.push(...rects);
          if (confidence === "high") existing.confidence = "high";
          return;
        }
        found.set(key, {
          id: crypto.randomUUID(),
          label,
          detail: `${detector} · Page ${page}`,
          detector,
          kind,
          confidence,
          selected: confidence === "high",
          rects,
        });
      };
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const pageItems: TextItem[] = [];
        for (const rawItem of content.items) {
          if (!("str" in rawItem) || !rawItem.str.trim()) continue;
          const item = rawItem as { str: string; transform: number[]; width: number; height: number };
          const transform = item.transform;
          const itemWidth = Math.max(item.width || 0, Math.abs(transform[0]) * item.str.length * 0.5);
          const itemHeight = Math.max(item.height || Math.abs(transform[3]), 10);
          const wholeRect: Rect = {
            page: pageNumber,
            x: transform[4] - 1,
            y: viewport.height - transform[5] - itemHeight - 1,
            width: Math.max(itemWidth + 2, 8),
            height: itemHeight + 2,
          };
          pageItems.push({ text: item.str, rect: wholeRect });
        }
        const pageCharacterCount = pageItems.reduce((total, item) => total + item.text.trim().length, 0);
        extractedCharacterCount += pageCharacterCount;
        if (pageCharacterCount === 0) pagesWithoutText.push(pageNumber);
        else if (!inspectionPromise) {
          inspectionPromise = inspectLocally(bytes).catch((error) => {
            console.warn("pdf-inspector was unavailable; continuing with PDF.js", error);
            return null;
          });
        }

        const lines = groupTextLines(pageItems);
        documentLines.push(...lines.map((line) => ({ page: pageNumber, text: textForLine(line.items), items: line.items })));
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          const lineText = textForLine(line.items);
          for (const rule of rules) {
            rule.expression.lastIndex = 0;
            for (const match of lineText.matchAll(rule.expression)) {
              const value = match[0];
              const confidence = rule.assess?.(value) ?? rule.confidence;
              if (!confidence) continue;
              registerFinding({
                label: value,
                detector: rule.label,
                kind: rule.kind,
                confidence,
                page: pageNumber,
                rects: mergeRectsOnLine(rectsForTextRange(line.items, match.index || 0, value.length)),
              });
            }
          }
          const labelledMatch = labelledName.exec(lineText);
          if (labelledMatch) {
            const name = labelledMatch[1];
            const nameStart = (labelledMatch.index || 0) + labelledMatch[0].lastIndexOf(name);
            registerFinding({
              label: name,
              detector: "Labelled person name",
              kind: "PII",
              confidence: "high",
              page: pageNumber,
              rects: mergeRectsOnLine(rectsForTextRange(line.items, nameStart, name.length)),
            });
          } else {
            likelyName.lastIndex = 0;
            for (const match of lineText.matchAll(likelyName)) {
              const name = match[0];
              if (nameStopPhrases.test(name)) continue;
              registerFinding({
                label: name,
                detector: "Possible person or organization name",
                kind: "PII",
                confidence: "review",
                page: pageNumber,
                rects: mergeRectsOnLine(rectsForTextRange(line.items, match.index || 0, name.length)),
              });
            }
          }

          const addressMatch = addressAnchor.exec(lineText);
          if (!addressMatch) continue;
          const addressStart = addressMatch.index || 0;
          const matchedEnd = addressStart + addressMatch[0].length;
          const inlineTail = lineText.slice(matchedEnd).trim();
          const includeInlineTail = inlineTail.length > 0 && inlineTail.length <= 100 && !addressStop.test(inlineTail) && addressContinuation.test(inlineTail);
          const firstAddressEnd = includeInlineTail ? lineText.length : matchedEnd;
          const addressLines = [line];
          let previous = line;
          for (let offset = 1; offset <= 3 && lineIndex + offset < lines.length; offset += 1) {
            const candidate = lines[lineIndex + offset];
            const candidateText = textForLine(candidate.items);
            const gap = candidate.y - (previous.y + previous.height);
            if (gap > Math.max(18, previous.height * 1.8) || addressStop.test(candidateText) || !addressContinuation.test(candidateText)) break;
            addressLines.push(candidate);
            previous = candidate;
          }
          const firstAddress = lineText.slice(addressStart, firstAddressEnd).trim();
          const continuationText = addressLines.slice(1).map((addressLine) => textForLine(addressLine.items));
          const value = [firstAddress, ...continuationText].join(", ");
          const addressRects = [
            ...mergeRectsOnLine(rectsForTextRange(line.items, addressStart, firstAddressEnd - addressStart)),
            ...addressLines.slice(1).flatMap((addressLine) => mergeRectsOnLine(addressLine.items.map((item) => ({ ...item.rect })))),
          ];
          registerFinding({
            label: value,
            detector: "Complete address",
            kind: "PII",
            confidence: "high",
            page: pageNumber,
            rects: addressRects,
          });
          lineIndex += addressLines.length - 1;
        }
      }
      if (extractedCharacterCount === 0) {
        await loadingTask.destroy();
        setFileBytes(null);
        setPageCount(0);
        setInspection(null);
        setScannedPdfDetected(true);
        setMessage("Scanned or image-only PDFs are not supported yet. Redactify needs selectable text to detect sensitive information safely.");
        return;
      }
      const localInspection = await (inspectionPromise ?? Promise.resolve(null));
      await loadingTask.destroy();
      const unsupportedPages = new Set([
        ...pagesWithoutText,
        ...(localInspection?.pagesNeedingOcr ?? []),
      ]);
      const inspectionDetectedScans = localInspection
        ? localInspection.pdfType === "Scanned" || localInspection.pdfType === "ImageBased" || localInspection.pdfType === "Mixed"
        : false;
      if (inspectionDetectedScans || unsupportedPages.size > 0) {
        setFileBytes(null);
        setPageCount(0);
        setInspection(null);
        setScannedPdfDetected(true);
        setMessage("Scanned or image-only PDFs are not supported yet. Redactify needs selectable text to detect sensitive information safely.");
        return;
      }
      setInspection(localInspection);
      setFindings([...found.values()]);
      setExtractedLines(documentLines);
      setMessage(found.size ? "Analysis complete. High-confidence matches are selected; uncertain matches are marked for review." : "No common sensitive patterns were found.");
      setPhase("review");
    } catch (error) {
      console.error(error);
      setFileBytes(null);
      setScannedPdfDetected(false);
      setMessage("This PDF could not be read. Try a standard, non-password-protected PDF.");
    } finally {
      setAnalyzing(false);
    }
  };

  const downloadPdfBytes = (bytes: Uint8Array) => {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName.replace(/\.pdf$/i, "") + "-redacted.pdf";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  };

  const createRedactedPdf = async () => {
    if (!fileBytes || !selectedCount) return;
    const selected = findings.filter((finding) => finding.selected);
    const selectedRects = selected.flatMap((finding) => finding.rects);
    setCreating(true);
    setVerification(null);
    setMessage("Creating and independently verifying a flattened PDF on your device…");
    try {
      const [{ PDFDocument }, pdfjs] = await Promise.all([import("pdf-lib"), getPdf()]);
      const loadingTask = pdfjs.getDocument({ data: fileBytes.slice() });
      const source = await loadingTask.promise;
      const output = await PDFDocument.create();
      const renderScale = 2;
      for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber += 1) {
        const page = await source.getPage(pageNumber);
        const pageSize = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        context.fillStyle = "#111018";
        selectedRects.filter((rect) => rect.page === pageNumber).forEach((rect) => {
          const safetyPadding = 1.5;
          context.fillRect(
            Math.max(0, (rect.x - safetyPadding) * renderScale),
            Math.max(0, (rect.y - safetyPadding) * renderScale),
            Math.min(pageSize.width - rect.x + safetyPadding, rect.width + safetyPadding * 2) * renderScale,
            Math.min(pageSize.height - rect.y + safetyPadding, rect.height + safetyPadding * 2) * renderScale,
          );
        });
        const pngBytes = await canvasToPngBytes(canvas);
        const image = await output.embedPng(pngBytes);
        output.addPage([pageSize.width, pageSize.height]).drawImage(image, {
          x: 0, y: 0, width: pageSize.width, height: pageSize.height,
        });
      }
      await loadingTask.destroy();
      const redactedBytes = Uint8Array.from(await output.save());
      const result = await verifyRedactedPdf(redactedBytes, selectedRects, pageCount);
      setVerification(result);
      if (!result.passed) {
        exportedPdfRef.current = null;
        setMessage("Safety verification did not pass, so no file was downloaded. Review the boxes and try again.");
        return;
      }
      exportedPdfRef.current = redactedBytes;
      downloadPdfBytes(redactedBytes);
      setMessage("Verified: the new PDF contains no extractable source text and every approved region is burned in.");
      setPhase("done");
    } catch (error) {
      console.error(error);
      setMessage("The redacted PDF could not be created. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const downloadLastExport = () => {
    if (exportedPdfRef.current) downloadPdfBytes(exportedPdfRef.current);
  };

  const reset = () => {
    setPhase("hero"); setFileName(""); setFileBytes(null); setPageCount(0);
    setFindings([]); setExtractedLines([]); setCustomTerms(""); setFilter("All"); setMessage(""); setActivePage(1);
    setScannedPdfDetected(false);
    setZoom(1); setDrawing(false); setPreviewRedactions(false); setActiveFindingId(null); setSelectedFindingIds(new Set());
    setInspection(null); setVerification(null);
    exportedPdfRef.current = null;
    occurrenceRef.current.clear();
    historyRef.current = [];
    redoRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
  };
  const toggle = (id: string, selected: boolean) => { checkpoint(); setFindings((items) => items.map((item) => item.id === id ? { ...item, selected } : item)); };
  const acceptAll = () => { checkpoint(); setFindings((items) => items.map((item) => ({ ...item, selected: true }))); };
  const rejectAll = () => { checkpoint(); setFindings((items) => items.map((item) => ({ ...item, selected: false }))); };
  const activateFinding = (id: string, additive: boolean) => {
    if (!additive) {
      setSelectedFindingIds(new Set([id]));
      setActiveFindingId(id);
      return;
    }
    setSelectedFindingIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setActiveFindingId(next.size === 1 ? [...next][0] : null);
      return next;
    });
  };
  const clearFindingSelection = () => {
    setActiveFindingId(null);
    setSelectedFindingIds(new Set());
  };
  const selectManyFindings = (ids: string[], additive: boolean) => {
    setSelectedFindingIds((current) => {
      const next = additive ? new Set(current) : new Set<string>();
      ids.forEach((id) => next.add(id));
      setActiveFindingId(next.size === 1 ? [...next][0] : null);
      return next;
    });
    if (ids.length) setMessage(`${ids.length} ${ids.length === 1 ? "box" : "boxes"} selected. Approve or delete them together.`);
  };
  const approveSelectedFindings = () => {
    if (!selectedFindingIds.size) return;
    checkpoint();
    setFindings((items) => items.map((item) => selectedFindingIds.has(item.id) ? { ...item, selected: true } : item));
    setMessage(`${selectedFindingIds.size} selected ${selectedFindingIds.size === 1 ? "box is" : "boxes are"} approved for redaction.`);
  };
  const deleteSelectedFindings = () => {
    if (!selectedFindingIds.size) return;
    const count = selectedFindingIds.size;
    checkpoint();
    setFindings((items) => items.filter((item) => !selectedFindingIds.has(item.id)));
    clearFindingSelection();
    setMessage(`${count} selected ${count === 1 ? "box" : "boxes"} deleted.`);
  };
  const showFinding = (finding: Finding) => {
    occurrenceRef.current.set(finding.id, 0);
    const page = finding.rects[0]?.page;
    if (page) goToPage(page);
    activateFinding(finding.id, false);
  };
  const showNextOccurrence = (finding: Finding) => {
    const current = occurrenceRef.current.get(finding.id) ?? 0;
    const next = (current + 1) % finding.rects.length;
    occurrenceRef.current.set(finding.id, next);
    const page = finding.rects[next]?.page;
    if (page) goToPage(page);
    activateFinding(finding.id, false);
    setMessage(`Showing occurrence ${next + 1} of ${finding.rects.length}.`);
  };
  const selectSimilar = (finding: Finding) => {
    checkpoint();
    const matching = findings.filter((item) => !item.manual && item.detector === finding.detector);
    setFindings((items) => items.map((item) => item.manual || item.detector !== finding.detector ? item : { ...item, selected: true }));
    setMessage(`${matching.length} ${finding.detector.toLowerCase()} ${matching.length === 1 ? "finding" : "findings"} selected.`);
  };
  const findAndRedactCustomText = () => {
    const terms = [...new Set(customTerms.split(/\r?\n/).map((term) => term.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 50);
    if (!terms.length) {
      setMessage("Enter at least one word, number, or sentence to find.");
      return;
    }
    const customFindings: Finding[] = [];
    const pageItems = new Map<number, TextItem[]>();
    extractedLines.forEach((line) => pageItems.set(line.page, [
      ...(pageItems.get(line.page) || []),
      ...line.items.map((item) => ({ ...item, text: item.text.replace(/\s+/g, " ") })),
    ]));
    for (const term of terms) {
      const rects: Rect[] = [];
      const needle = term.toLocaleLowerCase();
      for (const items of pageItems.values()) {
        const haystack = items.map((item) => item.text).join(" ").toLocaleLowerCase();
        let start = 0;
        while (start <= haystack.length - needle.length) {
          const matchIndex = haystack.indexOf(needle, start);
          if (matchIndex < 0) break;
          rects.push(...mergeRectsByVisualLine(rectsForTextRange(items, matchIndex, term.length)));
          start = matchIndex + Math.max(needle.length, 1);
        }
      }
      if (rects.length) {
        customFindings.push({
          id: crypto.randomUUID(),
          label: term,
          detail: `Custom exact text · Page ${rects[0].page}`,
          detector: "Custom exact text",
          kind: "PII",
          confidence: "high",
          selected: true,
          rects,
        });
      }
    }
    if (!customFindings.length) {
      setMessage("None of the entered text was found in this PDF's readable text layer.");
      return;
    }
    checkpoint();
    const replacedKeys = new Set(customFindings.map((finding) => normalizedValue(finding.label)));
    setFindings((items) => [
      ...items.filter((item) => item.detector !== "Custom exact text" || !replacedKeys.has(normalizedValue(item.label))),
      ...customFindings,
    ]);
    setFilter("All");
    const ids = new Set(customFindings.map((finding) => finding.id));
    setSelectedFindingIds(ids);
    setActiveFindingId(ids.size === 1 ? [...ids][0] : null);
    const occurrenceCount = customFindings.reduce((total, finding) => total + finding.rects.length, 0);
    setMessage(`${occurrenceCount} ${occurrenceCount === 1 ? "occurrence" : "occurrences"} found and selected for redaction.`);
  };
  const addManualRect = (rect: Rect) => {
    checkpoint();
    const id = crypto.randomUUID();
    setFindings((items) => [...items, {
      id,
      label: "Manual redaction",
      detail: `Manual selection · Page ${rect.page}`,
      detector: "Manual selection",
      kind: "PII",
      confidence: "high",
      selected: true,
      manual: true,
      rects: [rect],
    }]);
    setFilter("All");
    activateFinding(id, false);
    setMessage(`Manual redaction added to page ${rect.page}. Draw another box or press Esc when finished.`);
  };
  const removeFinding = (id: string) => {
    checkpoint();
    setFindings((items) => items.filter((item) => item.id !== id));
    setSelectedFindingIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (activeFindingId === id) setActiveFindingId(null);
  };
  const updateRect = (findingId: string, rectIndex: number, rect: Rect) => {
    setFindings((items) => items.map((item) => item.id !== findingId ? item : {
      ...item,
      rects: item.rects.map((current, index) => index === rectIndex ? rect : current),
    }));
  };
  const mergeFindingRects = (id: string) => {
    const finding = findings.find((item) => item.id === id);
    if (!finding || finding.rects.length < 2) return;
    checkpoint();
    const byPage = new Map<number, Rect[]>();
    finding.rects.forEach((rect) => byPage.set(rect.page, [...(byPage.get(rect.page) || []), rect]));
    const merged = [...byPage.entries()].map(([page, rects]) => {
      const x = Math.min(...rects.map((rect) => rect.x));
      const y = Math.min(...rects.map((rect) => rect.y));
      const right = Math.max(...rects.map((rect) => rect.x + rect.width));
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
      return { page, x, y, width: right - x, height: bottom - y };
    });
    setFindings((items) => items.map((item) => item.id === id ? { ...item, rects: merged } : item));
    setMessage("The selected redaction boxes were merged into one editable area per page.");
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false); analyzeFile(event.dataTransfer.files[0]);
  };
  const loadSamplePdf = async () => {
    if (analyzing) return;
    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const sample = await PDFDocument.create();
      const regular = await sample.embedFont(StandardFonts.Helvetica);
      const bold = await sample.embedFont(StandardFonts.HelveticaBold);
      const drawPage = (title: string, lines: string[]) => {
        const page = sample.addPage([612, 792]);
        page.drawText("REDACTIFY SAMPLE — FICTIONAL DATA", { x: 54, y: 738, size: 10, font: bold, color: rgb(.42, .3, 1) });
        page.drawText(title, { x: 54, y: 694, size: 22, font: bold, color: rgb(.09, .06, .23) });
        lines.forEach((line, index) => page.drawText(line, { x: 54, y: 642 - index * 34, size: 12, font: regular, color: rgb(.16, .14, .26) }));
      };
      drawPage("Customer profile", [
        "Account holder: Aarav Mehta",
        "Residential address: 42 Fictional Avenue, Flat 7B, Mumbai 400001, India",
        "Email address: aarav.mehta@example.test",
        "Telephone: +91 98765 43210",
        "IBAN: GB82 WEST 1234 5698 7654 32",
        "Client reference: CUST-7842-9016",
      ]);
      drawPage("Account activity", [
        "Account holder: Aarav Mehta",
        "Transfer recipient: Priya Sharma",
        "Payment reference: UPI-PS-1207-94",
        "Service IP address: 203.0.113.42",
        "Support email: private-banking@example.test",
        "This sample contains fictional information for product testing only.",
      ]);
      const bytes = await sample.save();
      const file = new File([bytes.slice().buffer as ArrayBuffer], "redactify-sample.pdf", { type: "application/pdf" });
      await analyzeFile(file);
    } catch (error) {
      console.error(error);
      setMessage("The sample document could not be created. Please choose a text-based PDF instead.");
    }
  };
  const focusUploader = () => {
    setPhase("hero");
    requestAnimationFrame(() => document.getElementById("quick-upload")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  const phaseIndex = phase === "hero" ? 0 : phase === "review" ? 1 : 2;

  return <main className="app-shell">
    <nav className="top-nav">
      <button className="brand-button" onClick={() => setPhase("hero")} aria-label="Redactify home"><span className="brand-icon"><i /><i /><i /></span><strong>Redactify</strong></button>
      <div className="progress-dots" aria-label={`Step ${phaseIndex + 1} of 3`}>{[0, 1, 2].map((step) => <span key={step} className={step === phaseIndex ? "active" : step < phaseIndex ? "complete" : ""} />)}</div>
      <button className="nav-action" onClick={focusUploader}>Redact a PDF</button>
    </nav>

    {phase === "hero" && <section className="hero-screen">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" /><div className="ambient ambient-three" />
      <div className="hero-layout">
        <div className="hero-intro">
          <div className="engine-badge"><span /> LOCAL PRIVACY SCANNER</div>
          <h1><span>Redact sensitive details.</span><em>Keep files on your device.</em></h1>
          <p className="hero-copy">Find names, addresses, account details, and other sensitive text. Review every suggestion before creating a permanently redacted copy.</p>
          <div className="hero-actions"><button className="primary-button" onClick={focusUploader}>Choose your PDF <b>→</b></button><a className="secondary-button" href="#privacy-story">How privacy works</a></div>
          <div className="hero-assurances"><span>✓ No account</span><span>✓ No document upload</span><span>✓ You approve every redaction</span></div>
        </div>
        <div className="hero-uploader" id="quick-upload">
          <div className="uploader-heading"><span>START HERE</span><strong>{analyzing ? "Reading your document…" : "Redact a PDF now"}</strong><p>{analyzing ? "Local detection is running in this browser." : "Drop a searchable, text-based PDF or select one from your device."}</p></div>
          <div className={`upload-card compact-upload ${dragging ? "dragging" : ""} ${analyzing ? "analyzing" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => !analyzing && inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !analyzing) inputRef.current?.click(); }}>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { const nextFile = event.target.files?.[0]; event.target.value = ""; void analyzeFile(nextFile); }} />
            <div className="upload-orb"><span>{analyzing ? "✦" : "↑"}</span></div>
            <div className="upload-copy"><strong>{analyzing ? fileName : dragging ? "Release to analyse" : "Drag & drop your PDF"}</strong><small>{analyzing ? "Your file has not left this browser" : "or click to browse files"}</small></div>
            {analyzing && <div className="analysis-track"><i /></div>}
          </div>
          <div className="upload-options"><button type="button" onClick={() => void loadSamplePdf()} disabled={analyzing}>Try with a sample PDF</button><span>Maximum file size: 50 MB</span></div>
          <div className="format-notice"><span aria-hidden="true">i</span><p><strong>Text-based PDFs only.</strong> Scanned or image-only PDFs are not supported yet.</p></div>
          {scannedPdfDetected ? <div className="scanned-pdf-notice" role="alert">
            <span aria-hidden="true">!</span>
            <div><strong>Scanned PDFs aren’t supported yet</strong><p>{message} Try exporting it as a searchable, text-based PDF and upload it again.</p></div>
            <button type="button" onClick={() => { setScannedPdfDetected(false); setMessage(""); inputRef.current?.click(); }}>Choose another PDF</button>
          </div> : message && <div className="inline-message" role="status">{message}</div>}
        </div>
      </div>
      <div className="privacy-story" id="privacy-story"><article><b>01 — OPEN LOCALLY</b><h2>Your PDF stays in browser memory</h2><p>Redactify does not send the document to our server or create a stored server copy.</p></article><article><b>02 — REVIEW YOURSELF</b><h2>Nothing disappears without approval</h2><p>Inspect, adjust, keep, or remove every suggested redaction before exporting.</p></article><article><b>03 — LEAVE CLEANLY</b><h2>Refreshing clears the workspace</h2><p>The working document lives only in the current browser session. The exported copy downloads directly to your device.</p></article></div>
    </section>}

    {phase === "review" && <section className="review-screen">
      <div className="review-grid">
        <div className="document-panel">
          <div className="panel-label"><span>LIVE PDF REVIEW</span><i /></div>
          <div className="viewer-toolbar" aria-label="PDF viewer controls">
            <div className="page-controls">
              <button type="button" onClick={() => { goToPage(activePage - 1); setActiveFindingId(null); }} disabled={activePage <= 1} aria-label="Previous page">←</button>
              <span>Page <strong>{activePage}</strong> of {pageCount}</span>
              <button type="button" onClick={() => { goToPage(activePage + 1); setActiveFindingId(null); }} disabled={activePage >= pageCount} aria-label="Next page">→</button>
            </div>
            <div className="zoom-controls">
              <button type="button" onClick={() => setZoom((value) => Math.max(.65, Number((value - .15).toFixed(2))))} disabled={zoom <= .65} aria-label="Zoom out">−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => setZoom((value) => Math.min(1.75, Number((value + .15).toFixed(2))))} disabled={zoom >= 1.75} aria-label="Zoom in">+</button>
            </div>
            <button type="button" className={`preview-button ${previewRedactions ? "active" : ""}`} onClick={() => { setPreviewRedactions((value) => !value); setDrawing(false); clearFindingSelection(); }} aria-pressed={previewRedactions}>
              {previewRedactions ? "Exit preview" : "Preview redactions"}
            </button>
            <button type="button" className={`draw-button ${drawing ? "active" : ""}`} onClick={() => { setDrawing(true); setPreviewRedactions(false); }} aria-pressed={drawing} disabled={drawing}>
              {drawing ? "Drawing mode on" : "+ Draw redaction"}
            </button>
            {drawing && <button type="button" className="stop-drawing-button" onClick={() => { setDrawing(false); setMessage("Drawing mode stopped."); }}>
              Stop drawing <kbd>Esc</kbd>
            </button>}
          </div>
          {drawing && <div className="draw-help" role="status">Draw as many boxes as you need. Press Esc or “Stop drawing” when you are finished.</div>}
          {bulkSelectionCount > 1 && <div className="bulk-selection-toolbar" role="toolbar" aria-label="Selected redaction boxes">
            <strong>{bulkSelectionCount} {bulkSelectionCount === 1 ? "box" : "boxes"} selected</strong>
            <span>Drag around boxes or use ⌘/Ctrl-click to add more.</span>
            <button type="button" className="bulk-approve" onClick={approveSelectedFindings}>✓ Approve selected</button>
            <button type="button" className="bulk-delete" onClick={deleteSelectedFindings}><span className="trash-icon" aria-hidden="true" /> Delete selected</button>
            <button type="button" onClick={clearFindingSelection}>Clear</button>
          </div>}
          {inspection && <div className={`inspection-strip ${inspection.pagesNeedingOcr.length ? "needs-ocr" : "ready"}`}>
            <span>LOCAL RUST/WASM INSPECTOR</span>
            <strong>{inspection.pdfType.replace(/([a-z])([A-Z])/g, "$1 $2")}</strong>
            <small>{inspection.pagesNeedingOcr.length
              ? `Manual review needed for ${inspection.pagesNeedingOcr.map((page) => `p.${page}`).join(", ")}`
              : `All ${inspection.pageCount} pages contain extractable text`}</small>
            {inspection.layout.isComplex && <small>Complex layout detected</small>}
          </div>}
          <div className="pdf-stage" ref={stageRef} onScroll={updatePageFromScroll}>
            {fileBytes && Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => <div
              className="pdf-page-entry"
              key={`${pageNumber}-${zoom}`}
              data-page={pageNumber}
            >
              <div className="pdf-page-number">Page {pageNumber}</div>
              <PdfPageView
                bytes={fileBytes}
                pageNumber={pageNumber}
                zoom={zoom}
                findings={findings}
                activeFindingId={activeFindingId}
                selectedFindingIds={selectedFindingIds}
                drawing={drawing}
                previewRedactions={previewRedactions}
                onActivate={activateFinding}
                onClearSelection={clearFindingSelection}
                onSelectMany={selectManyFindings}
                onManualRect={addManualRect}
                onEditStart={checkpoint}
                onUpdateRect={updateRect}
                onDeleteFinding={removeFinding}
                onConfirmFinding={(id) => toggle(id, true)}
              />
            </div>)}
          </div>
          <div className="viewer-legend"><span><i className="legend-redact" /> Will redact</span><span><i className="legend-keep" /> Will keep</span><span><i className="legend-manual" /> Manual</span><span className="selection-hint">Drag to multi-select · ⌘/Ctrl-click to add boxes · Delete key to remove</span></div>
          <div className="privacy-card"><span>⌁</span><div><strong>This view is local.</strong><p>The PDF page, your manual boxes, PDF.js extraction, and pdf-inspector WASM analysis remain in this browser tab.</p></div></div>
        </div>
        <aside className="suggestions-panel">
          <div className="review-sidebar-toolbar">
            <div className="file-summary"><span className="file-icon">PDF</span><div><strong>{fileName}</strong><small>{findings.length} findings · {pageCount} {pageCount === 1 ? "page" : "pages"}</small></div></div>
            <div className="decision-summary"><span>{selectedCount} selected</span><i /><span>{findings.length - selectedCount} kept</span></div>
            {reviewCount > 0 && <div className="review-alert"><strong>{reviewCount} uncertain</strong><span>Check these suggestions before export.</span></div>}
            <div className="sidebar-actions">
              <button className="mini-button history-button" onClick={undo} disabled={!canUndo} title="Undo (Command/Ctrl + Z)">↶ Undo <kbd>⌘/Ctrl Z</kbd></button>
              <button className="mini-button history-button" onClick={redo} disabled={!canRedo} title="Redo (Command + Shift + Z or Ctrl + Y)">↷ Redo <kbd>⇧⌘Z/Ctrl Y</kbd></button>
              <button className="mini-button accept" onClick={acceptAll}>Redact all</button>
              <button className="mini-button" onClick={rejectAll}>Keep all</button>
            </div>
            <button className="primary-button compact sidebar-export" onClick={createRedactedPdf} disabled={!selectedCount || creating}>{creating ? "Creating…" : "Apply & export"} <b>→</b></button>
          </div>
          <section className="exact-text-panel">
            <div><strong>Find exact text</strong><span>Local search</span></div>
            <p>Enter one word, number, or sentence per line. Every exact match will be selected for redaction.</p>
            <textarea
              value={customTerms}
              onChange={(event) => setCustomTerms(event.target.value)}
              onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") findAndRedactCustomText(); }}
              placeholder={"Aarav Mehta\nGB82 WEST 1234 5698 7654 32\nConfidential project name"}
              maxLength={2000}
              rows={3}
              aria-label="Text to find and redact"
            />
            <button type="button" onClick={findAndRedactCustomText} disabled={!customTerms.trim() || !extractedLines.length}>Find & redact all matches</button>
            <small>Case-insensitive · Up to 50 lines · ⌘/Ctrl + Enter</small>
          </section>
          <div className="suggestion-head">
            <div className="panel-label"><span><b /> REVIEW FINDINGS</span></div>
            <div className="filter-row"><button className={filter === "All" ? "active" : ""} onClick={() => setFilter("All")}>All</button>{usedCategories.map((kind) => <button key={kind} className={filter === kind ? `active ${categoryMeta[kind].className}` : ""} onClick={() => setFilter(kind)}>{categoryMeta[kind].label}</button>)}</div>
          </div>
          <div className="suggestion-list">
            {filteredFindings.map((finding, index) => <article
              id={`finding-${finding.id}`}
              className={`suggestion-card ${finding.selected ? "selected" : "kept"} ${activeFindingId === finding.id ? "active" : ""} ${selectedFindingIds.has(finding.id) ? "bulk-active" : ""}`}
              key={finding.id}
              style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) activateFinding(finding.id, true);
                else showFinding(finding);
              }}
            >
              <div className="suggestion-meta"><span className={categoryMeta[finding.kind].className}>{finding.manual ? "MANUAL" : finding.detail.split(" · ")[0].toUpperCase()}</span><small>p.{finding.rects[0]?.page}{finding.rects.length > 1 ? ` · ${finding.rects.length} matches` : ""}</small><span className={`confidence-badge ${finding.confidence}`}>{finding.confidence === "high" ? "VALIDATED" : "CHECK"}</span><button type="button" className="locate-button" onClick={(event) => { event.stopPropagation(); showFinding(finding); }}>Jump to match</button></div>
              <code>{finding.label}</code>
              <p>{finding.manual ? "Drawn by you on the real PDF page." : finding.confidence === "high" ? "Pattern and format checks passed locally." : "Possible sensitive data — confirm this suggestion before redacting."} Drag the box to move it; drag any edge or corner to resize it.</p>
              <div className="choice-row">
                <button className={finding.selected ? "active-redact" : ""} onClick={(event) => { event.stopPropagation(); toggle(finding.id, true); }}>✓ Redact</button>
                <button className={!finding.selected ? "active-keep" : ""} onClick={(event) => { event.stopPropagation(); toggle(finding.id, false); }}>× Keep</button>
                {!finding.manual && <button onClick={(event) => { event.stopPropagation(); selectSimilar(finding); }}>Select similar</button>}
                {finding.rects.length > 1 && <button onClick={(event) => { event.stopPropagation(); showNextOccurrence(finding); }}>Next match</button>}
                {finding.rects.length > 1 && <button onClick={(event) => { event.stopPropagation(); mergeFindingRects(finding.id); }}>Merge boxes</button>}
                <button className="remove-finding" aria-label={`Remove ${finding.label}`} onClick={(event) => { event.stopPropagation(); removeFinding(finding.id); }}>Delete</button>
              </div>
            </article>)}
            {!filteredFindings.length && <div className="no-suggestions"><strong>No findings here.</strong><span>Use “Draw redaction” to mark anything you want to remove manually.</span></div>}
          </div>
          <div className="review-progress"><small>REVIEW PROGRESS</small><div className="progress-bar">{findings.map((finding) => <i key={finding.id} className={finding.selected ? "selected" : "kept"} />)}</div><p><span>{selectedCount} selected</span><span>{findings.length - selectedCount} kept</span></p></div>
        </aside>
      </div>
      {message && <div className="review-message" role="status">{message}</div>}
    </section>}

    {phase === "done" && <section className="done-screen"><div className="done-glow" /><div className="done-check">✓</div><div className="section-kicker success-kicker">LOCAL EXPORT VERIFIED</div><h1>Redaction complete.</h1><p>{selectedCount} sensitive {selectedCount === 1 ? "item was" : "items were"} burned into a rebuilt PDF and verified before download.</p>{verification && <div className="verification-card"><div><span>✓</span><strong>Post-export safety check passed</strong></div><ul><li><b>{verification.pageCount}</b> pages rebuilt from pixels</li><li><b>{verification.extractedCharacters}</b> extractable source characters remain</li><li><b>{verification.checkedRegions}/{verification.totalRegions}</b> approved regions verified dark</li></ul><small>The exported copy is intentionally image-based and is no longer searchable.</small></div>}<div className="done-actions"><button className="primary-button success-button" onClick={downloadLastExport}>↓ Download again</button><button className="secondary-button" onClick={reset}>Process another document</button></div><div className="stat-grid"><article><strong>{selectedCount}</strong><small>ITEMS REDACTED</small></article><article><strong>{findings.length}</strong><small>ITEMS REVIEWED</small></article><article><strong>{pageCount}</strong><small>PAGES VERIFIED</small></article></div><div className="done-note">The original PDF was not modified or uploaded. Verification also ran only in this browser.</div></section>}
  </main>;
}
