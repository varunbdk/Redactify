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
type Phase = "hero" | "upload" | "review" | "done";
type Rect = { page: number; x: number; y: number; width: number; height: number };
type Finding = {
  id: string;
  label: string;
  detail: string;
  kind: Category;
  selected: boolean;
  manual?: boolean;
  rects: Rect[];
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

const rules: Array<{ kind: Category; label: string; expression: RegExp }> = [
  { kind: "PII", label: "Email address", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: "PII", label: "Phone number", expression: /(?<!\w)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)?\d{3,4}[ .-]\d{3,4}(?!\w)/g },
  { kind: "PII", label: "Possible name", expression: /\b[A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]{1,30}){1,3}\b/g },
  { kind: "PII", label: "Street address", expression: /\b\d{1,5}\s+[A-Za-z0-9.' -]{2,55}(?:Avenue|Street|Road|Lane|Drive|Boulevard|Highway)\b/gi },
  { kind: "Financial", label: "Card or account number", expression: /\b(?:\d[ -]*?){13,19}\b/g },
  { kind: "Financial", label: "IBAN", expression: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g },
  { kind: "Identity", label: "PAN-style identity number", expression: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: "Identity", label: "Aadhaar-style identity number", expression: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: "Network", label: "IP address", expression: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: "Network", label: "Web address", expression: /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi },
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

const addressAnchor = /\b\d{1,6}[A-Za-z]?(?:\s*[-/]\s*\d{1,6})?\s+[A-Za-z0-9.'’ -]{2,80}\b(?:Avenue|Ave|Street|St|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Highway|Hwy|Way|Court|Ct|Place|Pl|Terrace|Close|Square)\b[,.]?/i;
const addressContinuation = /(?:\b[A-Z]{1,3}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b\d{5}(?:-\d{4})?\b|\b\d{6}\b|\b(?:apartment|apt|suite|unit|floor|city|state|province|county|postcode|postal|zip|india|united kingdom|uk|usa|canada|australia)\b|^[A-Za-zÀ-ÿ.'’, -]{3,55}$)/i;
const addressStop = /\b(?:transaction|date|description|amount|balance|statement|invoice|subtotal|total|iban|account|email|phone)\b/i;

function PdfPageView({
  bytes,
  pageNumber,
  zoom,
  findings,
  activeFindingId,
  drawing,
  onActivate,
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
  drawing: boolean;
  onActivate: (id: string) => void;
  onManualRect: (rect: Rect) => void;
  onEditStart: () => void;
  onUpdateRect: (findingId: string, rectIndex: number, rect: Rect) => void;
  onDeleteFinding: (findingId: string) => void;
  onConfirmFinding: (findingId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const [pageSize, setPageSize] = useState<PageSize>({ width: 0, height: 0 });
  const [draft, setDraft] = useState<DraftRect | null>(null);
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

  const beginEdit = (event: ReactPointerEvent<HTMLButtonElement>, findingId: string, rectIndex: number, rect: Rect) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onEditStart();
    onActivate(findingId);
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
    let next = { ...edit.original };
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
    className={`pdf-page-shell ${drawing ? "drawing" : ""}`}
    style={pageSize.width ? { width: pageSize.width, height: pageSize.height } : undefined}
  >
    <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
    {!pageSize.width && !renderError && <div className="page-loading">Rendering page {pageNumber}…</div>}
    {renderError && <div className="page-loading error">{renderError}</div>}
    {pageSize.width > 0 && <div
      className="pdf-overlay"
      onPointerDown={beginDraw}
      onPointerMove={continueDraw}
      onPointerUp={finishDraw}
      onPointerCancel={() => { drawStartRef.current = null; setDraft(null); }}
    >
      {pageRects.map(({ finding, rect, index }) => <Fragment key={`${finding.id}-${index}`}>
        <button
          type="button"
          className={`redaction-box ${finding.selected ? "will-redact" : "will-keep"} ${finding.manual ? "manual" : ""} ${activeFindingId === finding.id ? "active" : ""}`}
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
          onClick={() => onActivate(finding.id)}
          title={`${finding.selected ? "Will redact" : "Will keep"}: ${finding.label}`}
          aria-label={`${finding.selected ? "Redact" : "Keep"} ${finding.label}`}
        >
          {(["n", "ne", "e", "se", "s", "sw", "w", "nw"] as ResizeDirection[]).map((direction) =>
            <span key={direction} className={`resize-handle handle-${direction}`} data-handle={direction} aria-hidden="true" />)}
        </button>
        {activeFindingId === finding.id && <div
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
    </div>}
  </div>;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<Finding[][]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageEntryRefs = useRef(new Map<number, HTMLDivElement>());
  const [phase, setPhase] = useState<Phase>("hero");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [filter, setFilter] = useState<Category | "All">("All");
  const [message, setMessage] = useState("");
  const [activePage, setActivePage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [drawing, setDrawing] = useState(false);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<LocalInspection | null>(null);

  const selectedCount = findings.filter((finding) => finding.selected).length;
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
      const entry = pageEntryRefs.current.get(page);
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
    pageEntryRefs.current.forEach((entry, page) => {
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
  };

  const undo = () => {
    const previous = historyRef.current.at(-1);
    if (!previous) return;
    historyRef.current = historyRef.current.slice(0, -1);
    setFindings(previous);
    setMessage("Last redaction edit undone.");
  };

  useEffect(() => {
    if (!activeFindingId) return;
    document.getElementById(`finding-${activeFindingId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeFindingId]);

  useEffect(() => {
    if (!drawing) return;
    const stopDrawingWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDrawing(false);
      setMessage("Drawing mode stopped.");
    };
    window.addEventListener("keydown", stopDrawingWithEscape);
    return () => window.removeEventListener("keydown", stopDrawingWithEscape);
  }, [drawing]);

  const analyzeFile = async (file?: File) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setMessage("Please choose a PDF document.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setMessage("Please choose a PDF smaller than 50 MB for reliable local processing.");
      return;
    }
    setPhase("upload");
    setFileName(file.name);
    setFindings([]);
    setMessage("");
    setActivePage(1);
    setZoom(1);
    setDrawing(false);
    setActiveFindingId(null);
    setInspection(null);
    historyRef.current = [];
    setAnalyzing(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setFileBytes(bytes);
      const inspectionPromise = inspectLocally(bytes).catch((error) => {
        console.warn("pdf-inspector was unavailable; continuing with PDF.js", error);
        return null;
      });
      const pdfjs = await getPdf();
      const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      const pdfDocument = await loadingTask.promise;
      setPageCount(pdfDocument.numPages);
      const found = new Map<string, Finding>();
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
          for (const rule of rules.filter((candidate) => candidate.label !== "Street address")) {
            rule.expression.lastIndex = 0;
            for (const match of item.str.matchAll(rule.expression)) {
              const value = match[0];
              const key = `${rule.kind}:${value.toLowerCase()}`;
              const leftRatio = (match.index || 0) / Math.max(item.str.length, 1);
              const rightRatio = ((match.index || 0) + value.length) / Math.max(item.str.length, 1);
              const rect: Rect = {
                page: pageNumber,
                x: transform[4] + itemWidth * leftRatio - 1,
                y: viewport.height - transform[5] - itemHeight - 1,
                width: Math.max(itemWidth * (rightRatio - leftRatio) + 2, 8),
                height: itemHeight + 2,
              };
              const existing = found.get(key);
              if (existing) existing.rects.push(rect);
              else found.set(key, {
                id: crypto.randomUUID(), label: value,
                detail: `${rule.label} · Page ${pageNumber}`,
                kind: rule.kind, selected: true, rects: [rect],
              });
            }
          }
        }

        const lines = groupTextLines(pageItems);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          const lineText = line.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
          if (!addressAnchor.test(lineText)) continue;
          const addressLines = [line];
          let previous = line;
          for (let offset = 1; offset <= 3 && lineIndex + offset < lines.length; offset += 1) {
            const candidate = lines[lineIndex + offset];
            const candidateText = candidate.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
            const gap = candidate.y - (previous.y + previous.height);
            if (gap > Math.max(18, previous.height * 1.8) || addressStop.test(candidateText) || !addressContinuation.test(candidateText)) break;
            addressLines.push(candidate);
            previous = candidate;
          }
          const value = addressLines.map((addressLine) => addressLine.items.map((item) => item.text).join(" ").trim()).join(", ");
          const key = `PII:address:${pageNumber}:${lineIndex}`;
          found.set(key, {
            id: crypto.randomUUID(),
            label: value,
            detail: `Complete address · Page ${pageNumber}`,
            kind: "PII",
            selected: true,
            rects: addressLines.flatMap((addressLine) => addressLine.items.map((item) => ({ ...item.rect }))),
          });
          lineIndex += addressLines.length - 1;
        }
      }
      const localInspection = await inspectionPromise;
      setInspection(localInspection);
      await loadingTask.destroy();
      setFindings([...found.values()]);
      if (localInspection?.pagesNeedingOcr.length) {
        setMessage(`Local analysis complete. ${localInspection.pagesNeedingOcr.length} ${localInspection.pagesNeedingOcr.length === 1 ? "page needs" : "pages need"} OCR before all content can be checked.`);
      } else {
        setMessage(found.size ? "Analysis complete. Your document never left this browser." : "No common sensitive patterns were found.");
      }
      setPhase("review");
    } catch (error) {
      console.error(error);
      setFileBytes(null);
      setMessage("This PDF could not be read. Try a standard, non-password-protected PDF.");
    } finally {
      setAnalyzing(false);
    }
  };

  const createRedactedPdf = async () => {
    if (!fileBytes || !selectedCount) return;
    const selected = findings.filter((finding) => finding.selected);
    setCreating(true);
    setMessage("Creating a flattened redacted PDF on your device…");
    try {
      const [{ PDFDocument }, pdfjs] = await Promise.all([import("pdf-lib"), getPdf()]);
      const loadingTask = pdfjs.getDocument({ data: fileBytes.slice() });
      const source = await loadingTask.promise;
      const output = await PDFDocument.create();
      const scale = 1.7;
      for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber += 1) {
        const page = await source.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        context.fillStyle = "#111018";
        selected.flatMap((finding) => finding.rects).filter((rect) => rect.page === pageNumber).forEach((rect) => {
          context.fillRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
        });
        const pngBytes = new Uint8Array(await (await fetch(canvas.toDataURL("image/png"))).arrayBuffer());
        const image = await output.embedPng(pngBytes);
        output.addPage([viewport.width / scale, viewport.height / scale]).drawImage(image, {
          x: 0, y: 0, width: viewport.width / scale, height: viewport.height / scale,
        });
      }
      await loadingTask.destroy();
      const redactedBytes = Uint8Array.from(await output.save());
      const blob = new Blob([redactedBytes.buffer], { type: "application/pdf" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = fileName.replace(/\.pdf$/i, "") + "-redacted.pdf";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      setMessage("Your flattened redacted PDF was downloaded locally.");
      setPhase("done");
    } catch (error) {
      console.error(error);
      setMessage("The redacted PDF could not be created. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const reset = () => {
    setPhase("upload"); setFileName(""); setFileBytes(null); setPageCount(0);
    setFindings([]); setFilter("All"); setMessage(""); setActivePage(1);
    setZoom(1); setDrawing(false); setActiveFindingId(null);
    setInspection(null);
    historyRef.current = [];
  };
  const toggle = (id: string, selected: boolean) => { checkpoint(); setFindings((items) => items.map((item) => item.id === id ? { ...item, selected } : item)); };
  const acceptAll = () => { checkpoint(); setFindings((items) => items.map((item) => ({ ...item, selected: true }))); };
  const rejectAll = () => { checkpoint(); setFindings((items) => items.map((item) => ({ ...item, selected: false }))); };
  const showFinding = (finding: Finding) => {
    const page = finding.rects[0]?.page;
    if (page) goToPage(page);
    setActiveFindingId(finding.id);
  };
  const addManualRect = (rect: Rect) => {
    checkpoint();
    const id = crypto.randomUUID();
    setFindings((items) => [...items, {
      id,
      label: "Manual redaction",
      detail: `Manual selection · Page ${rect.page}`,
      kind: "PII",
      selected: true,
      manual: true,
      rects: [rect],
    }]);
    setFilter("All");
    setActiveFindingId(id);
    setMessage(`Manual redaction added to page ${rect.page}. Draw another box or press Esc when finished.`);
  };
  const removeFinding = (id: string) => {
    checkpoint();
    setFindings((items) => items.filter((item) => item.id !== id));
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
  const phaseIndex = phase === "hero" ? 0 : phase === "upload" ? 1 : phase === "review" ? 2 : 3;

  return <main className="app-shell">
    <nav className="top-nav">
      <button className="brand-button" onClick={() => setPhase("hero")} aria-label="Redactify home"><span className="brand-icon"><i /><i /><i /></span><strong>Redactify</strong></button>
      <div className="progress-dots" aria-label={`Step ${phaseIndex + 1} of 4`}>{[0, 1, 2, 3].map((step) => <span key={step} className={step === phaseIndex ? "active" : step < phaseIndex ? "complete" : ""} />)}</div>
      <button className="nav-action" onClick={() => setPhase("upload")}>Try it locally</button>
    </nav>

    {phase === "hero" && <section className="hero-screen">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" /><div className="ambient ambient-three" />
      <div className="engine-badge"><span /> ON-DEVICE REDACTION ENGINE</div>
      <h1><span>Redact with</span><em>surgical precision.</em></h1>
      <p className="hero-copy">Open any PDF. Redactify surfaces sensitive details on your device and lets you decide exactly what disappears.</p>
      <div className="hero-actions"><button className="primary-button" onClick={() => setPhase("upload")}>Start redacting <b>→</b></button><a className="secondary-button" href="#privacy-story">See how it works</a></div>
      <div className="trust-pills"><span>✓ Files stay on device</span><span>✓ No account required</span><span>✓ Review every suggestion</span><span>✓ Flattened PDF export</span></div>
      <div className="mock-window" aria-hidden="true">
        <div className="window-bar"><span className="traffic"><i /><i /><i /></span><small>confidential_document.pdf</small></div>
        <div className="mock-body"><div className="mock-line title" /><div className="mock-line short" /><div className="mock-line redacted medium" /><div className="mock-line long" /><div className="mock-line redacted long" /><div className="mock-line medium" /><div className="mock-line redacted short" /></div>
        <div className="floating-detection"><small>LOCAL MATCH</small><strong>Sensitive identifier</strong><code>•••• •••• 9012</code><span><i>Redact</i><i>Keep</i></span></div>
      </div>
      <div className="privacy-story" id="privacy-story"><article><b>01</b><h2>Read locally</h2><p>The file stays in browser memory. There is no document upload or server copy.</p></article><article><b>02</b><h2>Review clearly</h2><p>Filter suggestions, inspect each match, and keep the final decision in your hands.</p></article><article><b>03</b><h2>Export safely</h2><p>Approved regions are flattened into a new PDF and downloaded directly.</p></article></div>
    </section>}

    {phase === "upload" && <section className="upload-screen">
      <div className="ambient upload-ambient" />
      <div className="section-kicker">LOCAL WORKSPACE</div>
      <h1>{analyzing ? "Reading your document." : "Drop your document."}</h1>
      <p>{analyzing ? "Finding common sensitive patterns without sending the file anywhere." : "PDF files up to 50 MB. Everything is processed in this browser."}</p>
      <div className={`upload-card ${dragging ? "dragging" : ""} ${analyzing ? "analyzing" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => !analyzing && inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !analyzing) inputRef.current?.click(); }}>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => analyzeFile(event.target.files?.[0])} />
        <div className="upload-orb"><span>{analyzing ? "✦" : "↑"}</span></div>
        <strong>{analyzing ? fileName : dragging ? "Release to analyze" : "Drag & drop your PDF here"}</strong>
        <small>{analyzing ? "On-device analysis in progress…" : "or click to browse files"}</small>
        {analyzing && <div className="analysis-track"><i /></div>}
      </div>
      {message && <div className="inline-message" role="status">{message}</div>}
      <div className="local-facts"><span>◈ No uploads</span><span>◈ No server storage</span><span>◈ Local PDF export</span></div>
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
            <button type="button" className={`draw-button ${drawing ? "active" : ""}`} onClick={() => setDrawing(true)} aria-pressed={drawing} disabled={drawing}>
              {drawing ? "Drawing mode on" : "+ Draw redaction"}
            </button>
            {drawing && <button type="button" className="stop-drawing-button" onClick={() => { setDrawing(false); setMessage("Drawing mode stopped."); }}>
              Stop drawing <kbd>Esc</kbd>
            </button>}
          </div>
          {drawing && <div className="draw-help" role="status">Draw as many boxes as you need. Press Esc or “Stop drawing” when you are finished.</div>}
          {inspection && <div className={`inspection-strip ${inspection.pagesNeedingOcr.length ? "needs-ocr" : "ready"}`}>
            <span>LOCAL RUST/WASM INSPECTOR</span>
            <strong>{inspection.pdfType.replace(/([a-z])([A-Z])/g, "$1 $2")}</strong>
            <small>{inspection.pagesNeedingOcr.length
              ? `OCR recommended for ${inspection.pagesNeedingOcr.map((page) => `p.${page}`).join(", ")}`
              : `All ${inspection.pageCount} pages contain extractable text`}</small>
            {inspection.layout.isComplex && <small>Complex layout detected</small>}
          </div>}
          <div className="pdf-stage" ref={stageRef} onScroll={updatePageFromScroll}>
            {fileBytes && Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => <div
              className="pdf-page-entry"
              key={`${pageNumber}-${zoom}`}
              data-page={pageNumber}
              ref={(node) => { if (node) pageEntryRefs.current.set(pageNumber, node); else pageEntryRefs.current.delete(pageNumber); }}
            >
              <div className="pdf-page-number">Page {pageNumber}</div>
              <PdfPageView
                bytes={fileBytes}
                pageNumber={pageNumber}
                zoom={zoom}
                findings={findings}
                activeFindingId={activeFindingId}
                drawing={drawing}
                onActivate={setActiveFindingId}
                onManualRect={addManualRect}
                onEditStart={checkpoint}
                onUpdateRect={updateRect}
                onDeleteFinding={removeFinding}
                onConfirmFinding={(id) => toggle(id, true)}
              />
            </div>)}
          </div>
          <div className="viewer-legend"><span><i className="legend-redact" /> Will redact</span><span><i className="legend-keep" /> Will keep</span><span><i className="legend-manual" /> Manual</span></div>
          <div className="privacy-card"><span>⌁</span><div><strong>This view is local.</strong><p>The PDF page, your manual boxes, PDF.js extraction, and pdf-inspector WASM analysis remain in this browser tab.</p></div></div>
        </div>
        <aside className="suggestions-panel">
          <div className="review-sidebar-toolbar">
            <div className="file-summary"><span className="file-icon">PDF</span><div><strong>{fileName}</strong><small>{findings.length} findings · {pageCount} {pageCount === 1 ? "page" : "pages"}</small></div></div>
            <div className="decision-summary"><span>{selectedCount} selected</span><i /><span>{findings.length - selectedCount} kept</span></div>
            <div className="sidebar-actions">
              <button className="mini-button" onClick={undo} disabled={!historyRef.current.length}>↶ Undo</button>
              <button className="mini-button accept" onClick={acceptAll}>Redact all</button>
              <button className="mini-button" onClick={rejectAll}>Keep all</button>
            </div>
            <button className="primary-button compact sidebar-export" onClick={createRedactedPdf} disabled={!selectedCount || creating}>{creating ? "Creating…" : "Apply & export"} <b>→</b></button>
          </div>
          <div className="suggestion-head">
            <div className="panel-label"><span><b /> REVIEW FINDINGS</span></div>
            <div className="filter-row"><button className={filter === "All" ? "active" : ""} onClick={() => setFilter("All")}>All</button>{usedCategories.map((kind) => <button key={kind} className={filter === kind ? `active ${categoryMeta[kind].className}` : ""} onClick={() => setFilter(kind)}>{categoryMeta[kind].label}</button>)}</div>
          </div>
          <div className="suggestion-list">
            {filteredFindings.map((finding, index) => <article
              id={`finding-${finding.id}`}
              className={`suggestion-card ${finding.selected ? "selected" : "kept"} ${activeFindingId === finding.id ? "active" : ""}`}
              key={finding.id}
              style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}
              onClick={() => showFinding(finding)}
            >
              <div className="suggestion-meta"><span className={categoryMeta[finding.kind].className}>{finding.manual ? "MANUAL" : finding.detail.split(" · ")[0].toUpperCase()}</span><small>p.{finding.rects[0]?.page}{finding.rects.length > 1 ? ` · ${finding.rects.length} matches` : ""}</small><button type="button" className="locate-button" onClick={() => showFinding(finding)}>View</button></div>
              <code>{finding.label}</code>
              <p>{finding.manual ? "Drawn by you on the real PDF page." : "Detected locally from the PDF text layer."} Drag the box to move it; drag any edge or corner to resize it.</p>
              <div className="choice-row">
                <button className={finding.selected ? "active-redact" : ""} onClick={(event) => { event.stopPropagation(); toggle(finding.id, true); }}>✓ Redact</button>
                <button className={!finding.selected ? "active-keep" : ""} onClick={(event) => { event.stopPropagation(); toggle(finding.id, false); }}>× Keep</button>
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

    {phase === "done" && <section className="done-screen"><div className="done-glow" /><div className="done-check">✓</div><div className="section-kicker success-kicker">LOCAL EXPORT COMPLETE</div><h1>Redaction complete.</h1><p>{selectedCount} sensitive {selectedCount === 1 ? "item was" : "items were"} flattened into a new PDF and downloaded to your device.</p><div className="done-actions"><button className="primary-button success-button" onClick={createRedactedPdf}>↓ Download again</button><button className="secondary-button" onClick={reset}>Process another document</button></div><div className="stat-grid"><article><strong>{selectedCount}</strong><small>ITEMS REDACTED</small></article><article><strong>{findings.length}</strong><small>ITEMS REVIEWED</small></article><article><strong>{pageCount}</strong><small>PAGES SCANNED</small></article></div><div className="done-note">The original PDF was not modified or uploaded.</div></section>}
  </main>;
}
