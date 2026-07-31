"use client";

import { ChangeEvent, DragEvent, useRef, useState } from "react";

type Finding = { label: string; detail: string; kind: "PII" | "Financial" | "Confidential"; selected: boolean };

const initialFindings: Finding[] = [
  { label: "jane.wilson@northstar.com", detail: "Email address · Page 1", kind: "PII", selected: true },
  { label: "+1 (415) 555-0198", detail: "Phone number · Page 1", kind: "PII", selected: true },
  { label: "ACCT-7842-9016", detail: "Account reference · Page 2", kind: "Financial", selected: true },
  { label: "Project Aurora", detail: "Internal project name · Page 3", kind: "Confidential", selected: false },
];

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [findings, setFindings] = useState(initialFindings);
  const [done, setDone] = useState(false);

  const selectFile = (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    setAnalyzing(true);
    setDone(false);
    window.setTimeout(() => setAnalyzing(false), 900);
  };
  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    selectFile(event.dataTransfer.files[0]);
  };
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => selectFile(event.target.files?.[0]);
  const toggle = (index: number) => setFindings((items) => items.map((item, i) => i === index ? { ...item, selected: !item.selected } : item));
  const count = findings.filter((item) => item.selected).length;

  return (
    <main>
      <nav className="nav"><a className="brand" href="#top"><span className="brand-mark">R</span>Redactify</a><div className="nav-links"><a href="#how">How it works</a><a href="#security">Security</a><button className="text-button">Sign in</button></div></nav>

      <section className="hero" id="top">
        <div className="eyebrow"><span /> PRIVATE BY DESIGN</div>
        <h1>Redact sensitive details<br /><em>with confidence.</em></h1>
        <p>Upload a PDF, let Redactify identify what needs protecting, then approve every permanent redaction before it happens.</p>
      </section>

      <section className="workspace" aria-label="PDF redaction workspace">
        <div className="upload-pane">
          <div className="step-label">01 — DOCUMENT</div>
          <input ref={inputRef} onChange={onFileChange} accept="application/pdf,.pdf" type="file" hidden />
          <button className={`dropzone ${fileName ? "has-file" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <span className="upload-icon">↥</span>
            {fileName ? <><strong>{fileName}</strong><small>{analyzing ? "Scanning document for sensitive information…" : "Ready for review"}</small></> : <><strong>Drop your PDF here</strong><small>or click to browse files</small></>}
          </button>
          <div className="trust-row"><span>⌁</span><p><b>Your document stays private.</b><br />Files are encrypted in transit and deleted after your session.</p></div>
        </div>

        <div className="review-pane">
          <div className="review-top"><div><div className="step-label">02 — REVIEW SUGGESTIONS</div><h2>{analyzing ? "Reading your document…" : "Found 4 items to review"}</h2></div><div className="ai-badge"><span>✦</span> AI ANALYSIS</div></div>
          <div className="finding-list">
            {findings.map((finding, index) => <button className={`finding ${finding.selected ? "checked" : ""}`} key={finding.label} onClick={() => toggle(index)} aria-pressed={finding.selected}>
              <span className="check">{finding.selected ? "✓" : ""}</span><span className="finding-copy"><b>{finding.label}</b><small>{finding.detail}</small></span><span className={`tag ${finding.kind.toLowerCase()}`}>{finding.kind}</span>
            </button>)}
          </div>
          <div className="review-footer"><p><b>{count} items selected</b> for permanent redaction</p><button className="redact-button" onClick={() => setDone(true)} disabled={!count}>{done ? "Redacted — download ready" : `Permanently redact ${count} items`} <span>→</span></button></div>
          {done && <div className="success" role="status">Your redacted PDF is ready. The selected information has been permanently removed.</div>}
        </div>
      </section>

      <section className="how" id="how"><div><div className="eyebrow"><span /> SIMPLE, DELIBERATE, SECURE</div><h2>Protection should never be a guessing game.</h2></div><div className="steps"><article><span>01</span><h3>Upload</h3><p>Drag in any PDF — contracts, reports, statements, and more.</p></article><article><span>02</span><h3>Review</h3><p>Our AI flags sensitive information. You stay in control of every choice.</p></article><article><span>03</span><h3>Redact</h3><p>Approve once and create a clean, permanently redacted copy.</p></article></div></section>
      <footer id="security"><span className="brand"><span className="brand-mark">R</span>Redactify</span><p>Built for privacy-minded teams.</p><span>© 2026</span></footer>
    </main>
  );
}
