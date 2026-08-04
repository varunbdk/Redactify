import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Redactify product and local-processing promise", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Redactify — Local PDF redaction<\/title>/i);
  assert.match(html, /Redact with/);
  assert.match(html, /surgical precision/);
  assert.match(html, /Files stay on device/);
  assert.match(html, /There is no document upload or server copy/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("includes real-page review and manual-redaction capabilities", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /function PdfPageView/);
  assert.match(page, /page\.render\(/);
  assert.match(page, /LIVE PDF REVIEW/);
  assert.match(page, /Draw redaction/);
  assert.match(page, /onManualRect=\{addManualRect\}/);
  assert.match(page, /Manual redaction/);
  assert.match(page, /Apply & export/);
  assert.match(page, /verifyRedactedPdf/);
  assert.match(page, /Post-export safety check passed/);
  assert.match(page, /no extractable source text/);
  assert.match(page, /canvasToPngBytes/);
  assert.match(page, /Select similar/);
  assert.match(page, /Next match/);
  assert.match(page, /Find exact text/);
  assert.match(page, /findAndRedactCustomText/);
  assert.match(page, /Custom exact text/);
  assert.match(page, /Preview redactions/);
  assert.match(page, /previewRedactions/);
  assert.match(page, /onSelectMany/);
  assert.match(page, /selectedFindingIds/);
  assert.match(page, /Approve selected/);
  assert.match(page, /Delete selected/);
  assert.match(page, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(page, /event\.key !== "Delete" && event\.key !== "Backspace"/);
  assert.match(page, /clearControlsOutsideFinding/);
  assert.match(page, /confidence === "high"/);
  assert.match(page, /isLuhnValid/);
  assert.match(page, /isIbanValid/);
  assert.match(page, /isIpValid/);
  assert.match(page, /Indian bank routing code \(IFSC\)/);
  assert.match(page, /UPI payment address/);
  assert.match(page, /Complete address/);
  assert.match(page, /Labelled person name/);
  assert.match(page, /Manual review needed/);
  assert.match(page, /Scanned PDFs aren’t supported yet/);
  assert.match(page, /scannedPdfDetected/);
  assert.match(page, /extractedCharacterCount/);
  assert.match(page, /pagesWithoutText/);
  assert.match(page, /Choose another PDF/);
  assert.match(page, /↶ Undo/);
  assert.match(page, /↷ Redo/);
  assert.match(page, /redoRef/);
  assert.match(page, /const redo =/);
  assert.match(page, /wantsUndo/);
  assert.match(page, /wantsRedo/);
  assert.match(page, /key === "y"/);
  assert.match(page, /⇧⌘Z\/Ctrl Y/);
  assert.match(page, /Merge boxes/);
  assert.match(page, /onUpdateRect=\{updateRect\}/);
  assert.match(page, /onDeleteFinding=\{removeFinding\}/);
  assert.match(page, /onConfirmFinding=\{\(id\) => toggle\(id, true\)\}/);
  assert.match(page, /Delete selected manual redaction/);
  assert.match(page, /Confirm detected redaction/);
  assert.match(page, /Stop drawing/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /Draw another box or press Esc/);
  assert.match(page, /closest\("\.redaction-box, \.redaction-box-actions"\)/);
  assert.match(page, /const beginEdit[\s\S]{0,350}if \(previewRedactions \|\| event\.button !== 0\) return;/);
  assert.match(page, /className="pdf-page-entry"/);
  assert.match(page, /onScroll=\{updatePageFromScroll\}/);
  assert.match(page, /left: draft\.x, top: draft\.y/);
  assert.doesNotMatch(page, /<header className="review-toolbar">/);
  assert.match(page, /Complete address/);
  assert.match(css, /\.pdf-page-shell/);
  assert.match(css, /\.pdf-overlay/);
  assert.match(css, /\.redaction-box/);
  assert.match(css, /\.resize-handle/);
  assert.match(css, /\.handle-n/);
  assert.match(css, /\.handle-w/);
  assert.match(css, /\.redaction-box-actions/);
  assert.match(css, /\.confirm-box-action/);
  assert.match(css, /\.delete-box-action:hover/);
  assert.match(css, /\.trash-icon/);
  assert.match(css, /\.stop-drawing-button/);
  assert.match(css, /\.pdf-page-shell\.drawing \.redaction-box\.manual \{ pointer-events:auto; \}/);
  assert.match(css, /\.pdf-page-shell\.drawing \.redaction-box-actions\.manual-actions \{ opacity:1; pointer-events:auto; \}/);
  assert.match(css, /\.review-sidebar-toolbar/);
  assert.match(css, /\.review-alert/);
  assert.match(css, /\.confidence-badge/);
  assert.match(css, /\.verification-card/);
  assert.match(css, /\.preview-redactions/);
  assert.match(css, /\.selection-marquee/);
  assert.match(css, /\.bulk-selection-toolbar/);
  assert.match(css, /\.exact-text-panel/);
  assert.match(css, /\.history-button/);
  assert.match(css, /\.scanned-pdf-notice/);
  assert.match(css, /cursor:crosshair/);
});

test("integrates the local pdf-inspector WebAssembly worker", async () => {
  const [page, worker, packageFile] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pdf-inspector.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(packageFile, /@firecrawl\/pdf-inspector-wasm/);
  assert.match(worker, /processPdf/);
  assert.match(worker, /profile: "compact"/);
  assert.match(page, /new Worker\(new URL\("\.\/pdf-inspector\.worker\.ts"/);
  assert.match(page, /LOCAL RUST\/WASM INSPECTOR/);
  assert.match(page, /pagesNeedingOcr/);
});
