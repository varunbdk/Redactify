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
  assert.match(page, /↶ Undo/);
  assert.match(page, /Merge boxes/);
  assert.match(page, /onUpdateRect=\{updateRect\}/);
  assert.match(page, /onDeleteFinding=\{removeFinding\}/);
  assert.match(page, /onConfirmFinding=\{\(id\) => toggle\(id, true\)\}/);
  assert.match(page, /Delete selected manual redaction/);
  assert.match(page, /Confirm detected redaction/);
  assert.match(page, /Stop drawing/);
  assert.match(page, /event\.key !== "Escape"/);
  assert.match(page, /Draw another box or press Esc/);
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
  assert.match(css, /\.review-sidebar-toolbar/);
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
