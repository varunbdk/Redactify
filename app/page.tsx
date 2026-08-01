"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type Category = "PII" | "Financial" | "Identity" | "Network";
type Phase = "hero" | "upload" | "review" | "done";
type Rect = { page: number; x: number; y: number; width: number; height: number };
type Finding = { id: string; label: string; detail: string; kind: Category; selected: boolean; rects: Rect[] };

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

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
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

  const selectedCount = findings.filter((finding) => finding.selected).length;
  const filteredFindings = useMemo(
    () => filter === "All" ? findings : findings.filter((finding) => finding.kind === filter),
    [filter, findings],
  );
  const usedCategories = useMemo(() => [...new Set(findings.map((finding) => finding.kind))], [findings]);

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
    setAnalyzing(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setFileBytes(bytes);
      const pdfjs = await getPdf();
      const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      const pdfDocument = await loadingTask.promise;
      setPageCount(pdfDocument.numPages);
      const found = new Map<string, Finding>();
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        for (const rawItem of content.items) {
          if (!("str" in rawItem) || !rawItem.str.trim()) continue;
          const item = rawItem as { str: string; transform: number[]; width: number; height: number };
          for (const rule of rules) {
            rule.expression.lastIndex = 0;
            for (const match of item.str.matchAll(rule.expression)) {
              const value = match[0];
              const key = `${rule.kind}:${value.toLowerCase()}`;
              const transform = item.transform;
              const itemWidth = Math.max(item.width || 0, Math.abs(transform[0]) * item.str.length * 0.5);
              const leftRatio = (match.index || 0) / Math.max(item.str.length, 1);
              const rightRatio = ((match.index || 0) + value.length) / Math.max(item.str.length, 1);
              const rect: Rect = {
                page: pageNumber,
                x: transform[4] + itemWidth * leftRatio - 1,
                y: viewport.height - transform[5] - Math.max(item.height || Math.abs(transform[3]), 9) - 1,
                width: Math.max(itemWidth * (rightRatio - leftRatio) + 2, 8),
                height: Math.max(item.height || Math.abs(transform[3]), 10) + 2,
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
      }
      await loadingTask.destroy();
      setFindings([...found.values()]);
      setMessage(found.size ? "Analysis complete. Your document never left this browser." : "No common sensitive patterns were found.");
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
      const blob = new Blob([await output.save()], { type: "application/pdf" });
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
    setFindings([]); setFilter("All"); setMessage("");
  };
  const toggle = (id: string, selected: boolean) => setFindings((items) => items.map((item) => item.id === id ? { ...item, selected } : item));
  const acceptAll = () => setFindings((items) => items.map((item) => ({ ...item, selected: true })));
  const rejectAll = () => setFindings((items) => items.map((item) => ({ ...item, selected: false })));
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
      <header className="review-toolbar"><div className="file-summary"><span className="file-icon">PDF</span><div><strong>{fileName}</strong><small>{findings.length} suggestions · {pageCount} {pageCount === 1 ? "page" : "pages"}</small></div></div><div className="toolbar-spacer" /><div className="decision-summary"><span>{selectedCount} selected</span><i /> <span>{findings.length - selectedCount} kept</span></div><button className="mini-button accept" onClick={acceptAll}>Redact all</button><button className="mini-button" onClick={rejectAll}>Keep all</button><button className="primary-button compact" onClick={createRedactedPdf} disabled={!selectedCount || creating}>{creating ? "Creating…" : "Apply & export"} <b>→</b></button></header>
      <div className="review-grid">
        <div className="document-panel"><div className="panel-label"><span>FINDING MAP</span><i /></div><div className="paper"><div className="paper-head"><span>REDACTIFY LOCAL REVIEW</span><small>{pageCount} pages</small></div><h2>{fileName}</h2><p className="paper-intro">Detected regions are mapped below. Purple marks will be permanently covered; grey marks will remain visible.</p>{findings.slice(0, 10).map((finding) => <div className="paper-row" key={finding.id}><span className={`paper-mark ${finding.selected ? "will-redact" : "will-keep"}`} style={{ width: `${Math.min(88, Math.max(34, finding.label.length * 3.2))}%` }} /><small>p.{finding.rects[0]?.page}</small></div>)}{findings.length > 10 && <div className="paper-more">+ {findings.length - 10} additional suggestions</div>}</div><div className="privacy-card"><span>⌁</span><div><strong>This view is local.</strong><p>The document and extracted text remain in this browser tab.</p></div></div></div>
        <aside className="suggestions-panel"><div className="suggestion-head"><div className="panel-label"><span><b /> LOCAL SUGGESTIONS</span></div><div className="filter-row"><button className={filter === "All" ? "active" : ""} onClick={() => setFilter("All")}>All</button>{usedCategories.map((kind) => <button key={kind} className={filter === kind ? `active ${categoryMeta[kind].className}` : ""} onClick={() => setFilter(kind)}>{categoryMeta[kind].label}</button>)}</div></div><div className="suggestion-list">{filteredFindings.map((finding, index) => <article className={`suggestion-card ${finding.selected ? "selected" : "kept"}`} key={finding.id} style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}><div className="suggestion-meta"><span className={categoryMeta[finding.kind].className}>{finding.detail.split(" · ")[0].toUpperCase()}</span><small>p.{finding.rects[0]?.page}{finding.rects.length > 1 ? ` · ${finding.rects.length} matches` : ""}</small></div><code>{finding.label}</code><p>Detected locally from the PDF text layer.</p><div className="choice-row"><button className={finding.selected ? "active-redact" : ""} onClick={() => toggle(finding.id, true)}>✓ Redact</button><button className={!finding.selected ? "active-keep" : ""} onClick={() => toggle(finding.id, false)}>× Keep</button></div></article>)}{!filteredFindings.length && <div className="no-suggestions">No suggestions in this filter.</div>}</div><div className="review-progress"><small>REVIEW PROGRESS</small><div className="progress-bar">{findings.map((finding) => <i key={finding.id} className={finding.selected ? "selected" : "kept"} />)}</div><p><span>{selectedCount} selected</span><span>{findings.length - selectedCount} kept</span></p></div></aside>
      </div>
      {message && <div className="review-message" role="status">{message}</div>}
    </section>}

    {phase === "done" && <section className="done-screen"><div className="done-glow" /><div className="done-check">✓</div><div className="section-kicker success-kicker">LOCAL EXPORT COMPLETE</div><h1>Redaction complete.</h1><p>{selectedCount} sensitive {selectedCount === 1 ? "item was" : "items were"} flattened into a new PDF and downloaded to your device.</p><div className="done-actions"><button className="primary-button success-button" onClick={createRedactedPdf}>↓ Download again</button><button className="secondary-button" onClick={reset}>Process another document</button></div><div className="stat-grid"><article><strong>{selectedCount}</strong><small>ITEMS REDACTED</small></article><article><strong>{findings.length}</strong><small>ITEMS REVIEWED</small></article><article><strong>{pageCount}</strong><small>PAGES SCANNED</small></article></div><div className="done-note">The original PDF was not modified or uploaded.</div></section>}
  </main>;
}
