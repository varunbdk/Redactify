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
type Confidence = "high" | "medium" | "low";
type Rect = { page: number; x: number; y: number; width: number; height: number };
type Finding = {
  id: string;
  label: string;
  detail: string;
  detector: string;
  kind: Category;
  confidence: Confidence;
  reason: string;
  country?: string;
  occurrenceCount: number;
  selected: boolean;
  manual?: boolean;
  reported?: boolean;
  reportReason?: string;
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
  explain: (value: string, confidence: Confidence) => string;
  country?: string;
  valueGroup?: number;
};

const digitsOnly = (value: string) => value.replace(/\D/g, "");
const normalizedValue = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const passesLuhn = (digits: string) => {
  if (!digits || /^(\d)\1+$/.test(digits)) return false;
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
const isLuhnValid = (value: string) => {
  const digits = digitsOnly(value);
  return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
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
const isCanadianSinValid = (value: string) => {
  const digits = digitsOnly(value);
  return digits.length === 9 && passesLuhn(digits);
};
const isAustralianTfnValid = (value: string) => {
  const digits = digitsOnly(value);
  if (digits.length !== 9 || /^(\d)\1+$/.test(digits)) return false;
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  return [...digits].reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0) % 11 === 0;
};
const isNhsNumberValid = (value: string) => {
  const digits = digitsOnly(value);
  if (digits.length !== 10 || /^(\d)\1+$/.test(digits)) return false;
  const total = [...digits.slice(0, 9)].reduce((sum, digit, index) => sum + Number(digit) * (10 - index), 0);
  const remainder = 11 - (total % 11);
  const checkDigit = remainder === 11 ? 0 : remainder;
  return checkDigit !== 10 && checkDigit === Number(digits[9]);
};
const verhoeffTable = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const verhoeffPermutation = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const isAadhaarValid = (value: string) => {
  const digits = digitsOnly(value);
  if (digits.length !== 12 || /^(\d)\1+$/.test(digits)) return false;
  let checksum = 0;
  [...digits].reverse().forEach((digit, index) => {
    checksum = verhoeffTable[checksum][verhoeffPermutation[index % 8][Number(digit)]];
  });
  return checksum === 0;
};

const formatReason = (label: string) => `Matches the expected structure for ${label}.`;
const validatedReason = (label: string) => `${formatReason(label)} Its checksum or validation rule also passed.`;

const rules: DetectionRule[] = [
  { kind: "PII", label: "Email address", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: "high", explain: () => "Contains a valid-looking mailbox, @ symbol, domain, and top-level domain." },
  { kind: "PII", label: "Phone number", expression: /(?<!\w)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)?\d{3,4}[ .-]\d{3,4}(?!\w)/g, confidence: "medium", assess: (value) => isPhoneLike(value) ? "medium" : false, explain: () => "Contains 7–15 digits in a phone-like layout. Numbering rules vary by country, so review is recommended." },
  { kind: "Financial", label: "IBAN", expression: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, confidence: "high", assess: (value) => isIbanValid(value) ? "high" : "low", explain: (_value, confidence) => confidence === "high" ? validatedReason("an IBAN") : "Looks like an IBAN, but its checksum did not validate. Review it carefully." },
  { kind: "Financial", label: "Payment card or long account number", expression: /\b(?:\d[ -]*?){13,19}\b/g, confidence: "medium", assess: (value) => isLuhnValid(value) ? "high" : "low", explain: (_value, confidence) => confidence === "high" ? validatedReason("a payment-card number") : "Contains 13–19 grouped digits, but the payment-card checksum did not pass." },
  { kind: "Financial", label: "Indian bank routing code (IFSC)", expression: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, confidence: "high", country: "India", explain: () => formatReason("an Indian IFSC bank code") },
  { kind: "Financial", label: "UPI payment address", expression: /\b[A-Z0-9._-]{2,}@(upi|okaxis|okhdfcbank|oksbi|ybl|paytm|ibl|axl)\b/gi, confidence: "high", country: "India", explain: () => formatReason("an Indian UPI payment address") },
  { kind: "Financial", label: "Account or transaction reference", expression: /\b(?:CUST|ACCT|ACC|CARD|UPI-PS|PAY|TRF|REF|POL)[-A-Z0-9/]{5,}\b/gi, confidence: "low", explain: () => "Starts with a common account or transaction prefix, but reference formats are organization-specific." },
  { kind: "Identity", label: "PAN identity number", expression: /\b[A-Z]{5}\d{4}[A-Z]\b/g, confidence: "high", country: "India", explain: () => formatReason("an Indian PAN identity number") },
  { kind: "Identity", label: "Aadhaar identity number", expression: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, confidence: "medium", country: "India", assess: (value) => isAadhaarValid(value) ? "high" : "medium", explain: (_value, confidence) => confidence === "high" ? validatedReason("an Indian Aadhaar number") : "Has the 12-digit Aadhaar layout, but its checksum did not validate." },
  { kind: "Identity", label: "US Social Security number", expression: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g, confidence: "high", country: "United States", explain: () => "Matches the US Social Security number layout and excludes invalid number ranges." },
  { kind: "Identity", label: "UK National Insurance number", expression: /\b(?:national insurance(?: number)?|NINO|NI number)\s*[:#-]?\s*((?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]?)\b/gi, valueGroup: 1, confidence: "high", country: "United Kingdom", explain: () => "Appears beside a National Insurance label and matches the UK NINO structure." },
  { kind: "Identity", label: "UK NHS number", expression: /\b(?:NHS(?: number)?|national health service number)\s*[:#-]?\s*(\d{3}[ -]?\d{3}[ -]?\d{4})\b/gi, valueGroup: 1, confidence: "medium", country: "United Kingdom", assess: (value) => isNhsNumberValid(value) ? "high" : "low", explain: (_value, confidence) => confidence === "high" ? validatedReason("a UK NHS number") : "Appears beside an NHS label, but its checksum did not validate." },
  { kind: "Identity", label: "Canadian Social Insurance Number", expression: /\b(?:social insurance number|SIN)\s*[:#-]?\s*(\d{3}[ -]?\d{3}[ -]?\d{3})\b/gi, valueGroup: 1, confidence: "medium", country: "Canada", assess: (value) => isCanadianSinValid(value) ? "high" : "low", explain: (_value, confidence) => confidence === "high" ? validatedReason("a Canadian SIN") : "Appears beside a Canadian SIN label, but its checksum did not validate." },
  { kind: "Identity", label: "Australian Tax File Number", expression: /\b(?:tax file number|TFN)\s*[:#-]?\s*(\d{3}[ -]?\d{3}[ -]?\d{3})\b/gi, valueGroup: 1, confidence: "medium", country: "Australia", assess: (value) => isAustralianTfnValid(value) ? "high" : "low", explain: (_value, confidence) => confidence === "high" ? validatedReason("an Australian TFN") : "Appears beside an Australian TFN label, but its checksum did not validate." },
  { kind: "Network", label: "IP address", expression: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, confidence: "high", assess: (value) => isIpValid(value) ? "high" : false, explain: () => "Contains four valid IPv4 number groups, each between 0 and 255." },
  { kind: "Network", label: "Web address", expression: /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, confidence: "high", explain: () => formatReason("a web address") },
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

type PdfModule = Awaited<ReturnType<typeof getPdf>>;
type PdfLoadingTask = ReturnType<PdfModule["getDocument"]>;
type PdfDocument = Awaited<PdfLoadingTask["promise"]>;
type AnalysisProgress = { stage: "opening" | "analysing" | "inspecting"; current: number; total: number; detail: string };
type ExportProgress = { stage: "rendering" | "verifying"; current: number; total: number; detail: string };

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DOCUMENT_PAGES = 300;
const MAX_CANVAS_PIXELS = 12_000_000;

const nextPaint = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
const cancellationError = () => new DOMException("Operation cancelled", "AbortError");
const isCancellation = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const readablePdfError = (error: unknown) => {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "PasswordException") return "Password-protected PDFs are not supported. Remove the password and try again.";
  if (name === "InvalidPDFException") return "This PDF appears to be damaged or invalid. Try exporting a fresh copy.";
  if (name === "MissingPDFException") return "The selected PDF could not be opened. Please choose it again.";
  return "This PDF could not be read. Try a standard, non-password-protected PDF.";
};

const inspectLocally = (bytes: Uint8Array, signal?: AbortSignal) => new Promise<LocalInspection>((resolve, reject) => {
  if (signal?.aborted) {
    reject(cancellationError());
    return;
  }
  const worker = new Worker(new URL("./pdf-inspector.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  let settled = false;
  const timeout = window.setTimeout(() => {
    finish();
    reject(new Error("Local PDF inspection timed out"));
  }, 45_000);
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    worker.terminate();
  };
  const cancel = () => {
    finish();
    reject(cancellationError());
  };
  signal?.addEventListener("abort", cancel, { once: true });
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
  for (const rect of [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const group = groups.find((candidate) => {
      const last = candidate.at(-1)!;
      const sameLine = last.page === rect.page && Math.abs(last.y - rect.y) <= Math.max(4, rect.height * .55);
      const nearby = rect.x - (last.x + last.width) <= Math.max(12, rect.height * 1.4);
      return sameLine && nearby;
    });
    if (group) group.push(rect);
    else groups.push([rect]);
  }
  return groups.flatMap(mergeRectsOnLine);
};

const likelyName = /\b[A-Z][a-zÀ-ÿ'’-]{1,30}(?:\s+[A-Z][a-zÀ-ÿ'’-]{1,30}){1,3}\b/g;
const titledName = /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+([A-Z][a-zÀ-ÿ'’-]{1,30}(?:\s+[A-Z][a-zÀ-ÿ'’-]{1,30}){1,3})\b/i;
const labelledName = /\b(?:account holder|client name|customer name|full name|beneficiary|recipient|payee|employee name|patient name|insured person)\s*[:#-]?\s+((?:(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+)?[A-Z][a-zÀ-ÿ'’-]{1,30}(?:\s+[A-Z][a-zÀ-ÿ'’-]{1,30}){1,3})/i;
const bareNameLabel = /^\s*(?:name|account name)\s*[:#-]?\s+((?:(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+)?[A-Z][a-zÀ-ÿ'’-]{1,30}(?:\s+[A-Z][a-zÀ-ÿ'’-]{1,30}){1,3})\s*$/i;
const labelledAccountIdentifier = /^\s*(?:account(?:\s+(?:number|no\.?|id))?|client(?:\s+(?:number|no\.?|id))?|customer(?:\s+(?:number|no\.?|id))?|brokerage account|portfolio(?:\s+(?:number|id))?|user(?:\s+(?:number|id))?|account code)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{3,31})\s*$/i;
const contextualName = /\b(?:paid to|received(?: from)?|transfer(?:red)? (?:to|from|received)|attention|attn|care of|c\/o)\s*[:#-]?\s+([A-Z][a-zÀ-ÿ'’-]{1,30}(?:\s+[A-Z][a-zÀ-ÿ'’-]{1,30}){1,3})/i;
const nameStopPhrases = /^(?:Private Client|Client Details|Transaction Activity|Statement Summary|Test Document|Security Contact|Document Service|Account Statement|Personal Information|Contact Details|Northstar Bank|Residential Address)$/i;
const businessNameClues = /\b(?:bank|limited|ltd|llc|llp|inc|incorporated|corp|corporation|company|co\.?|plc|gmbh|group|partners|foundation|university|college|hospital|clinic|insurance|mutual|capital|holdings|laboratories|labs|market|transit|services|solutions|technologies|association|department|authority)\b/i;
const nonPersonNameClues = /\b(?:account|address|client|customer|transaction|statement|summary|details|document|invoice|payment|balance|credit|debit|activity|period|reference|security|contact|residential|postal|billing|shipping|avenue|street|road|lane|drive|boulevard|highway|court|square)\b/i;
const isAccountIdentifier = (value: string) => {
  const compact = value.replace(/[._/-]/g, "");
  return /^(?=.*\d)[A-Z0-9]{5,32}$/i.test(compact);
};

const addressLabel = /(?<!email )(?<!web )(?<!ip )\b(?:(?:residential|home|mailing|billing|shipping|postal|correspondence|registered|business|office)\s+)?address\b\s*[:#-]?\s*/i;
const addressAnchor = /\b(?:flat|apartment|apt|suite|unit|floor|house|building|plot|room)?\s*\d{1,6}[A-Za-z]?(?:\s*[-/]\s*\d{1,6})?\s+[A-Za-z0-9.'’ -]{2,80}\b(?:Avenue|Ave|Street|St|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Highway|Hwy|Way|Court|Ct|Place|Pl|Terrace|Close|Square|Crescent|Parkway|Marg|Nagar|Colony|Sector|Layout|Cross|Main)\b[,.]?/i;
const postalCode = /(?:\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b|\b\d{5}(?:-\d{4})?\b|\b\d{6}\b|\b\d{4}\b)/i;
const addressContinuation = /(?:\b(?:apartment|apt|suite|unit|floor|building|district|city|state|province|county|postcode|postal|zip|india|united kingdom|uk|united states|usa|canada|australia|germany|france|spain|italy|singapore|uae)\b|[,;]|^[A-Za-zÀ-ÿ.'’ -]{3,55}$)/i;
const addressStop = /\b(?:transaction|date|description|amount|balance|statement|invoice|subtotal|total|iban|account(?: number)?|email|phone|telephone|tax|identity|reference|period)\b/i;
const confidenceRank: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };
const confidenceMeta: Record<Confidence, { label: string; summary: string }> = {
  high: { label: "HIGH", summary: "Strong pattern, label, or checksum evidence. Selected automatically." },
  medium: { label: "MEDIUM", summary: "Good contextual evidence, but human review is recommended." },
  low: { label: "LOW", summary: "Weak or partially validated evidence. Not selected automatically." },
};
const incorrectSuggestionReasons = ["Not sensitive", "Wrong type", "Wrong text area", "Business or heading", "Other"] as const;

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

const verifyRedactedPdf = async (
  bytes: Uint8Array,
  selectedRects: Rect[],
  expectedPages: number,
  signal?: AbortSignal,
  onProgress?: (page: number, total: number) => void,
): Promise<VerificationResult> => {
  const pdfjs = await getPdf();
  const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
  const document = await loadingTask.promise;
  const selectedRectsByPage = new Map<number, Rect[]>();
  selectedRects.forEach((rect) => {
    const pageRects = selectedRectsByPage.get(rect.page) || [];
    pageRects.push(rect);
    selectedRectsByPage.set(rect.page, pageRects);
  });
  let extractedCharacters = 0;
  let checkedRegions = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (signal?.aborted) throw cancellationError();
      onProgress?.(pageNumber, document.numPages);
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      extractedCharacters += textContent.items.reduce((total, item) => total + ("str" in item ? item.str.trim().length : 0), 0);
      const pageRects = selectedRectsByPage.get(pageNumber) || [];
      if (!pageRects.length) {
        page.cleanup();
        if (pageNumber % 3 === 0) await nextPaint();
        continue;
      }
      const viewport = page.getViewport({ scale: 1 });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas unavailable during verification");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      checkedRegions += pageRects.filter((rect) => darkRegionSamples(context, rect, canvas.width, canvas.height)).length;
      page.cleanup();
      if (pageNumber % 3 === 0) await nextPaint();
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
  document,
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
  document: PdfDocument;
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
  const [renderAttempt, setRenderAttempt] = useState(0);
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
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | undefined;
    let loadedPage: Awaited<ReturnType<PdfDocument["getPage"]>> | undefined;
    let renderedCanvas: HTMLCanvasElement | null = null;

    const renderPage = async () => {
      try {
        setRenderError("");
        setPageSize({ width: 0, height: 0 });
        loadedPage = await document.getPage(pageNumber);
        const viewport = loadedPage.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        if (!canvas || disposed) return;
        renderedCanvas = canvas;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas unavailable");
        const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
        const safeScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(viewport.width * viewport.height, 1));
        const outputScale = Math.max(1, Math.min(deviceScale, safeScale));
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ width: viewport.width, height: viewport.height });
        renderTask = loadedPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
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
      loadedPage?.cleanup();
      if (renderedCanvas) {
        renderedCanvas.width = 1;
        renderedCanvas.height = 1;
      }
    };
  }, [document, pageNumber, renderAttempt, zoom]);

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
    {renderError && <div className="page-loading error"><span>{renderError}</span><button type="button" onClick={() => setRenderAttempt((attempt) => attempt + 1)}>Retry page</button></div>}
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
  const analysisAbortRef = useRef<AbortController | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const reviewLoadingTaskRef = useRef<PdfLoadingTask | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>("hero");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageDimensions, setPageDimensions] = useState<PageSize[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [creating, setCreating] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
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
  const [reportingFindingId, setReportingFindingId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<LocalInspection | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [reviewDocument, setReviewDocument] = useState<PdfDocument | null>(null);
  const [viewerError, setViewerError] = useState("");
  const [viewerLoadAttempt, setViewerLoadAttempt] = useState(0);

  const selectedCount = findings.filter((finding) => finding.selected).length;
  const bulkSelectionCount = selectedFindingIds.size;
  const reviewCount = findings.filter((finding) => finding.confidence !== "high").length;
  const analysisPercent = analysisProgress?.total
    ? Math.max(3, Math.round((analysisProgress.current / analysisProgress.total) * 100))
    : 8;
  const exportPercent = exportProgress?.total
    ? Math.max(3, Math.round((exportProgress.current / exportProgress.total) * 100))
    : 8;
  const filteredFindings = useMemo(
    () => filter === "All" ? findings : findings.filter((finding) => finding.kind === filter),
    [filter, findings],
  );
  const usedCategories = useMemo(() => [...new Set(findings.map((finding) => finding.kind))], [findings]);

  useEffect(() => {
    if (phase !== "review" || !fileBytes) return;
    let disposed = false;
    const loadDocument = async () => {
      try {
        setViewerError("");
        const pdfjs = await getPdf();
        if (disposed) return;
        const task = pdfjs.getDocument({ data: fileBytes.slice() });
        reviewLoadingTaskRef.current = task;
        const document = await task.promise;
        if (disposed) {
          await task.destroy();
          return;
        }
        setReviewDocument(document);
      } catch (error) {
        if (!disposed) {
          console.error(error);
          setViewerError("The document viewer could not start. Try reopening the PDF.");
        }
      }
    };
    void loadDocument();
    return () => {
      disposed = true;
      const task = reviewLoadingTaskRef.current;
      reviewLoadingTaskRef.current = null;
      void task?.destroy();
    };
  }, [fileBytes, phase, viewerLoadAttempt]);

  useEffect(() => () => {
    analysisAbortRef.current?.abort();
    exportAbortRef.current?.abort();
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

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
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
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
    });
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
    if (!file || analyzing) return;
    setScannedPdfDetected(false);
    setMessage("");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setMessage("Please choose a PDF document.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setMessage("Please choose a PDF smaller than 50 MB for reliable local processing.");
      return;
    }
    const controller = new AbortController();
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = controller;
    setFileName(file.name);
    setFileBytes(null);
    setReviewDocument(null);
    setViewerError("");
    setPageCount(0);
    setPageDimensions([]);
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
    setAnalysisProgress({ stage: "opening", current: 0, total: 0, detail: "Opening the PDF safely…" });
    let loadingTask: PdfLoadingTask | null = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (controller.signal.aborted) throw cancellationError();
      let inspectionPromise: Promise<LocalInspection | null> | null = null;
      const pdfjs = await getPdf();
      if (controller.signal.aborted) throw cancellationError();
      loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      const pdfDocument = await loadingTask.promise;
      if (controller.signal.aborted) throw cancellationError();
      if (!pdfDocument.numPages) throw new Error("The PDF has no pages");
      if (pdfDocument.numPages > MAX_DOCUMENT_PAGES) {
        throw new Error(`This PDF has ${pdfDocument.numPages} pages. Redactify currently supports up to ${MAX_DOCUMENT_PAGES} pages per document for reliable local processing.`);
      }
      setPageCount(pdfDocument.numPages);
      setAnalysisProgress({ stage: "analysing", current: 0, total: pdfDocument.numPages, detail: `Preparing ${pdfDocument.numPages} ${pdfDocument.numPages === 1 ? "page" : "pages"}…` });
      const found = new Map<string, Finding>();
      const documentLines: TextLine[] = [];
      const dimensions: PageSize[] = [];
      const pagesWithoutText: number[] = [];
      let extractedCharacterCount = 0;
      const registerFinding = ({
        label,
        detector,
        kind,
        confidence,
        reason,
        country,
        page,
        rects,
      }: {
        label: string;
        detector: string;
        kind: Category;
        confidence: Confidence;
        reason: string;
        country?: string;
        page: number;
        rects: Rect[];
      }) => {
        if (!rects.length || !normalizedValue(label)) return;
        const groupedRects = mergeRectsByVisualLine(rects);
        const key = `${kind}:${detector}:${normalizedValue(label)}`;
        const existing = found.get(key);
        if (existing) {
          existing.rects = mergeRectsByVisualLine([...existing.rects, ...groupedRects]);
          existing.occurrenceCount += 1;
          if (confidenceRank[confidence] > confidenceRank[existing.confidence]) {
            existing.confidence = confidence;
            existing.reason = reason;
            existing.selected = confidence === "high";
          }
          return;
        }
        found.set(key, {
          id: crypto.randomUUID(),
          label,
          detail: `${detector} · Page ${page}`,
          detector,
          kind,
          confidence,
          reason,
          country,
          occurrenceCount: 1,
          selected: confidence === "high",
          rects: groupedRects,
        });
      };
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (controller.signal.aborted) throw cancellationError();
        setAnalysisProgress({ stage: "analysing", current: pageNumber, total: pdfDocument.numPages, detail: `Analysing page ${pageNumber} of ${pdfDocument.numPages}…` });
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        dimensions.push({ width: viewport.width, height: viewport.height });
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
          inspectionPromise = inspectLocally(bytes, controller.signal).catch((error) => {
            if (isCancellation(error)) throw error;
            console.warn("pdf-inspector was unavailable; continuing with PDF.js", error);
            return null;
          });
        }

        const lines = groupTextLines(pageItems);
        const sortedLineHeights = lines.map((line) => line.height).sort((a, b) => a - b);
        const medianLineHeight = sortedLineHeights[Math.floor(sortedLineHeights.length / 2)] || 10;
        documentLines.push(...lines.map((line) => ({ page: pageNumber, text: textForLine(line.items), items: line.items })));
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          const lineText = textForLine(line.items);
          for (const rule of rules) {
            rule.expression.lastIndex = 0;
            for (const match of lineText.matchAll(rule.expression)) {
              const value = rule.valueGroup ? match[rule.valueGroup] : match[0];
              if (!value) continue;
              if (rule.label === "Phone number" && /\b(?:aadhaar|identity|social security|account|iban|card|tax|reference|postcode|postal|zip)\b/i.test(lineText)) continue;
              const confidence = rule.assess?.(value) ?? rule.confidence;
              if (!confidence) continue;
              const valueStart = (match.index || 0) + match[0].lastIndexOf(value);
              registerFinding({
                label: value,
                detector: rule.label,
                kind: rule.kind,
                confidence,
                reason: rule.explain(value, confidence),
                country: rule.country,
                page: pageNumber,
                rects: rectsForTextRange(line.items, valueStart, value.length),
              });
            }
          }
          const accountMatch = labelledAccountIdentifier.exec(lineText);
          if (accountMatch?.[1] && isAccountIdentifier(accountMatch[1])) {
            const accountIdentifier = accountMatch[1];
            const identifierStart = (accountMatch.index || 0) + accountMatch[0].lastIndexOf(accountIdentifier);
            registerFinding({
              label: accountIdentifier,
              detector: "Labelled account or client identifier",
              kind: "Financial",
              confidence: "high",
              reason: "Appears in a dedicated account or client field and contains a short alphanumeric identifier.",
              page: pageNumber,
              rects: rectsForTextRange(line.items, identifierStart, accountIdentifier.length),
            });
          }

          const lineContainsAddress = addressLabel.test(lineText) || addressAnchor.test(lineText);
          const labelledMatch = labelledName.exec(lineText) || bareNameLabel.exec(lineText);
          const titledMatch = titledName.exec(lineText);
          const contextualMatch = contextualName.exec(lineText);
          if (labelledMatch) {
            const name = labelledMatch[1];
            const nameStart = (labelledMatch.index || 0) + labelledMatch[0].lastIndexOf(name);
            registerFinding({
              label: name,
              detector: "Table-labelled person name",
              kind: "PII",
              confidence: "high",
              reason: "Appears in a dedicated name field, such as an account holder, client, beneficiary, or Name row.",
              page: pageNumber,
              rects: rectsForTextRange(line.items, nameStart, name.length),
            });
          } else if (titledMatch && !businessNameClues.test(titledMatch[1])) {
            const name = titledMatch[1];
            const nameStart = (titledMatch.index || 0) + titledMatch[0].lastIndexOf(name);
            registerFinding({
              label: name,
              detector: "Titled person name",
              kind: "PII",
              confidence: "high",
              reason: "A personal title such as Mr, Ms, or Dr appears immediately before this name.",
              page: pageNumber,
              rects: rectsForTextRange(line.items, nameStart, name.length),
            });
          } else if (contextualMatch && !businessNameClues.test(contextualMatch[1])) {
            const name = contextualMatch[1];
            const nameStart = (contextualMatch.index || 0) + contextualMatch[0].lastIndexOf(name);
            registerFinding({
              label: name,
              detector: "Contextual person name",
              kind: "PII",
              confidence: "medium",
              reason: "Appears after wording that normally introduces a person, such as paid to, received from, or attention.",
              page: pageNumber,
              rects: rectsForTextRange(line.items, nameStart, name.length),
            });
          } else if (!lineContainsAddress) {
            likelyName.lastIndex = 0;
            for (const match of lineText.matchAll(likelyName)) {
              const name = match[0];
              const coversMostOfLine = normalizedValue(name).length >= normalizedValue(lineText).length * .8;
              const looksLikeHeading = coversMostOfLine && line.height > medianLineHeight * 1.25;
              if (nameStopPhrases.test(name) || businessNameClues.test(name) || nonPersonNameClues.test(name) || looksLikeHeading) continue;
              registerFinding({
                label: name,
                detector: "Possible person name",
                kind: "PII",
                confidence: "low",
                reason: "Uses person-name capitalization and word structure, but no nearby label confirms it is a person.",
                page: pageNumber,
                rects: rectsForTextRange(line.items, match.index || 0, name.length),
              });
            }
          }

          const labelMatch = addressLabel.exec(lineText);
          const addressMatch = addressAnchor.exec(lineText);
          if (!labelMatch && !addressMatch) continue;
          const labelledValueStart = labelMatch ? (labelMatch.index || 0) + labelMatch[0].length : -1;
          const addressStart = labelledValueStart >= 0 && lineText.slice(labelledValueStart).trim().length >= 3
            ? labelledValueStart
            : addressMatch?.index ?? lineText.length;
          const matchedEnd = addressMatch ? (addressMatch.index || 0) + addressMatch[0].length : addressStart;
          const inlineTail = lineText.slice(matchedEnd).trim();
          const includeInlineTail = Boolean(labelMatch) || (inlineTail.length > 0 && inlineTail.length <= 120 && !addressStop.test(inlineTail) && (addressContinuation.test(inlineTail) || postalCode.test(inlineTail)));
          const firstAddressEnd = includeInlineTail ? lineText.length : Math.max(matchedEnd, addressStart);
          const addressLines = [line];
          let previous = line;
          for (let offset = 1; offset <= 5 && lineIndex + offset < lines.length; offset += 1) {
            const candidate = lines[lineIndex + offset];
            const candidateText = textForLine(candidate.items);
            const gap = candidate.y - (previous.y + previous.height);
            const continuationEvidence = addressContinuation.test(candidateText) || postalCode.test(candidateText);
            if (gap > Math.max(22, previous.height * 2.1) || addressStop.test(candidateText) || !continuationEvidence) break;
            addressLines.push(candidate);
            previous = candidate;
          }
          const firstAddress = lineText.slice(addressStart, firstAddressEnd).trim();
          const continuationText = addressLines.slice(1).map((addressLine) => textForLine(addressLine.items));
          const value = [firstAddress, ...continuationText].filter(Boolean).join(", ");
          if (!value || normalizedValue(value).length < 5) continue;
          const addressRects = [
            ...rectsForTextRange(line.items, addressStart, firstAddressEnd - addressStart),
            ...addressLines.slice(1).flatMap((addressLine) => addressLine.items.map((item) => ({ ...item.rect }))),
          ];
          registerFinding({
            label: value,
            detector: "Complete address",
            kind: "PII",
            confidence: labelMatch ? "high" : "medium",
            reason: labelMatch
              ? `Appears beside an address label and groups ${addressLines.length} adjacent postal ${addressLines.length === 1 ? "line" : "lines"} into one finding.`
              : `Matches a street-address structure and groups ${addressLines.length} adjacent postal ${addressLines.length === 1 ? "line" : "lines"}.`,
            page: pageNumber,
            rects: addressRects,
          });
          lineIndex += addressLines.length - 1;
        }
        page.cleanup();
        if (pageNumber % 2 === 0) await nextPaint();
      }
      if (extractedCharacterCount === 0) {
        setFileBytes(null);
        setPageCount(0);
        setPageDimensions([]);
        setInspection(null);
        setScannedPdfDetected(true);
        setMessage("Scanned or image-only PDFs are not supported yet. Redactify needs selectable text to detect sensitive information safely.");
        return;
      }
      setAnalysisProgress({ stage: "inspecting", current: pdfDocument.numPages, total: pdfDocument.numPages, detail: "Checking document structure and text support…" });
      const localInspection = await (inspectionPromise ?? Promise.resolve(null));
      if (controller.signal.aborted) throw cancellationError();
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
        setPageDimensions([]);
        setInspection(null);
        setScannedPdfDetected(true);
        setMessage("Scanned or image-only PDFs are not supported yet. Redactify needs selectable text to detect sensitive information safely.");
        return;
      }
      setFileBytes(bytes);
      setPageDimensions(dimensions);
      setInspection(localInspection);
      setFindings([...found.values()]);
      setExtractedLines(documentLines);
      setMessage(found.size ? "Analysis complete. High-confidence matches are selected; uncertain matches are marked for review." : "No common sensitive patterns were found.");
      setPhase("review");
    } catch (error) {
      setFileBytes(null);
      setPageCount(0);
      setPageDimensions([]);
      if (isCancellation(error)) {
        setScannedPdfDetected(false);
        setMessage("Analysis cancelled. The document was cleared from this browser tab.");
      } else {
        console.error(error);
        setScannedPdfDetected(false);
        const detail = error instanceof Error && error.message.startsWith("This PDF has") ? error.message : readablePdfError(error);
        setMessage(detail);
      }
    } finally {
      if (loadingTask) {
        try { await loadingTask.destroy(); } catch { /* PDF.js may already be shutting down after cancellation. */ }
      }
      if (analysisAbortRef.current === controller) {
        analysisAbortRef.current = null;
        setAnalyzing(false);
        setAnalysisProgress(null);
      }
    }
  };

  const cancelAnalysis = () => {
    analysisAbortRef.current?.abort();
    setAnalysisProgress((progress) => progress ? { ...progress, detail: "Stopping safely…" } : progress);
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
    if (!fileBytes || !selectedCount || creating) return;
    const selected = findings.filter((finding) => finding.selected);
    const selectedRects = selected.flatMap((finding) => finding.rects);
    const selectedRectsByPage = new Map<number, Rect[]>();
    selectedRects.forEach((rect) => {
      const pageRects = selectedRectsByPage.get(rect.page) || [];
      pageRects.push(rect);
      selectedRectsByPage.set(rect.page, pageRects);
    });
    const controller = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    setCreating(true);
    setExportProgress({ stage: "rendering", current: 0, total: pageCount, detail: "Preparing the secure export…" });
    setVerification(null);
    setMessage("Creating and independently verifying a flattened PDF on your device…");
    let loadingTask: PdfLoadingTask | null = null;
    try {
      const [{ PDFDocument }, pdfjs] = await Promise.all([import("pdf-lib"), getPdf()]);
      if (controller.signal.aborted) throw cancellationError();
      loadingTask = pdfjs.getDocument({ data: fileBytes.slice() });
      const source = await loadingTask.promise;
      const output = await PDFDocument.create();
      const preferredScale = source.numPages > 80 ? 1.25 : source.numPages > 30 ? 1.55 : 2;
      for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber += 1) {
        if (controller.signal.aborted) throw cancellationError();
        setExportProgress({ stage: "rendering", current: pageNumber, total: source.numPages, detail: `Securing page ${pageNumber} of ${source.numPages}…` });
        const page = await source.getPage(pageNumber);
        const pageSize = page.getViewport({ scale: 1 });
        const pixelSafeScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(pageSize.width * pageSize.height, 1));
        const renderScale = Math.max(1, Math.min(preferredScale, pixelSafeScale));
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        context.fillStyle = "#111018";
        (selectedRectsByPage.get(pageNumber) || []).forEach((rect) => {
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
        page.cleanup();
        canvas.width = 1;
        canvas.height = 1;
        if (pageNumber % 2 === 0) await nextPaint();
      }
      if (controller.signal.aborted) throw cancellationError();
      const redactedBytes = Uint8Array.from(await output.save());
      setExportProgress({ stage: "verifying", current: 0, total: pageCount, detail: "Starting independent safety verification…" });
      const result = await verifyRedactedPdf(redactedBytes, selectedRects, pageCount, controller.signal, (page, total) => {
        setExportProgress({ stage: "verifying", current: page, total, detail: `Verifying page ${page} of ${total}…` });
      });
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
      if (isCancellation(error)) {
        setMessage("Export cancelled. No partial PDF was downloaded or stored.");
      } else {
        console.error(error);
        setMessage("The redacted PDF could not be created. Your original remains unchanged; please try again.");
      }
    } finally {
      if (loadingTask) {
        try { await loadingTask.destroy(); } catch { /* PDF.js may already be shutting down. */ }
      }
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
        setCreating(false);
        setExportProgress(null);
      }
    }
  };

  const cancelExport = () => {
    exportAbortRef.current?.abort();
    setExportProgress((progress) => progress ? { ...progress, detail: "Stopping safely…" } : progress);
  };

  const downloadLastExport = () => {
    if (exportedPdfRef.current) downloadPdfBytes(exportedPdfRef.current);
  };

  const reset = () => {
    analysisAbortRef.current?.abort();
    exportAbortRef.current?.abort();
    setPhase("hero"); setFileName(""); setFileBytes(null); setPageCount(0);
    setPageDimensions([]); setAnalysisProgress(null); setExportProgress(null);
    setReviewDocument(null); setViewerError("");
    setFindings([]); setExtractedLines([]); setCustomTerms(""); setFilter("All"); setMessage(""); setActivePage(1);
    setScannedPdfDetected(false);
    setZoom(1); setDrawing(false); setPreviewRedactions(false); setActiveFindingId(null); setSelectedFindingIds(new Set()); setReportingFindingId(null);
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
    const navigationRects = finding.detector === "Complete address"
      ? finding.rects.filter((rect, index, rects) => {
          const previous = rects[index - 1];
          return !previous || previous.page !== rect.page || rect.y - (previous.y + previous.height) > Math.max(24, rect.height * 2.2);
        })
      : finding.rects;
    const current = occurrenceRef.current.get(finding.id) ?? 0;
    const next = (current + 1) % Math.max(navigationRects.length, 1);
    occurrenceRef.current.set(finding.id, next);
    const page = navigationRects[next]?.page;
    if (page) goToPage(page);
    activateFinding(finding.id, false);
    setMessage(`Showing occurrence ${next + 1} of ${finding.occurrenceCount}.`);
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
      let matches = 0;
      const needle = term.toLocaleLowerCase();
      for (const items of pageItems.values()) {
        const haystack = items.map((item) => item.text).join(" ").toLocaleLowerCase();
        let start = 0;
        while (start <= haystack.length - needle.length) {
          const matchIndex = haystack.indexOf(needle, start);
          if (matchIndex < 0) break;
          matches += 1;
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
          reason: "Entered explicitly by you and matched exactly in the PDF text layer.",
          occurrenceCount: matches,
          selected: true,
          rects: mergeRectsByVisualLine(rects),
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
    const occurrenceCount = customFindings.reduce((total, finding) => total + finding.occurrenceCount, 0);
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
      reason: "Drawn manually by you on the PDF page.",
      occurrenceCount: 1,
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
  const reportIncorrectFinding = (id: string, reportReason: string) => {
    checkpoint();
    setFindings((items) => items.map((item) => item.id === id ? {
      ...item,
      selected: false,
      reported: true,
      reportReason,
    } : item));
    setReportingFindingId(null);
    setMessage("Marked as an incorrect suggestion for this browser session. No PDF text or report was sent anywhere.");
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
    event.preventDefault(); setDragging(false);
    if (!analyzing) void analyzeFile(event.dataTransfer.files[0]);
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
      {phase === "hero" ? <div className="marketing-nav" aria-label="Primary navigation">
        <a href="#privacy-story">How it works</a>
        <a href="#features">Features</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
      </div> : <div className="progress-dots" aria-label={`Step ${phaseIndex + 1} of 3`}>{[0, 1, 2].map((step) => <span key={step} className={step === phaseIndex ? "active" : step < phaseIndex ? "complete" : ""} />)}</div>}
      <button className="nav-action" onClick={focusUploader}>Start redacting, for free</button>
    </nav>

    {phase === "hero" && <section className="hero-screen">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" /><div className="ambient ambient-three" />
      <div className="hero-layout">
        <div className="hero-intro">
          <h1>Get sensitive details redacted, <em>instantly!</em></h1>
          <p className="hero-copy">Find names, addresses, account details, and other sensitive text. Review every suggestion before creating a permanently redacted copy.</p>
          <div className="hero-actions"><button className="primary-button" onClick={focusUploader}>Choose your PDF <b>→</b></button><a className="secondary-button" href="#privacy-story">How privacy works</a></div>
          <div className="hero-assurances"><span>✓ No account</span><span>✓ No document upload</span><span>✓ You approve every redaction</span></div>
        </div>
        <div className="hero-uploader" id="quick-upload">
          <div className="uploader-heading"><span>START HERE</span><strong>{analyzing ? "Reading your document…" : "Start redacting, for free"}</strong><p>{analyzing ? "Local detection is running in this browser." : "Drop a searchable, text-based PDF or select one from your device."}</p></div>
          <div className={`upload-card compact-upload ${dragging ? "dragging" : ""} ${analyzing ? "analyzing" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => !analyzing && inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !analyzing) inputRef.current?.click(); }}>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { const nextFile = event.target.files?.[0]; event.target.value = ""; void analyzeFile(nextFile); }} />
            <div className="upload-orb"><span>{analyzing ? "✦" : "↑"}</span></div>
            <div className="upload-copy"><strong>{analyzing ? fileName : dragging ? "Release to analyse" : "Drag & drop your PDF"}</strong><small>{analyzing ? "Your file has not left this browser" : "or click to browse files"}</small></div>
            {analyzing && <div className="analysis-track determinate" aria-hidden="true"><i style={{ width: `${analysisPercent}%` }} /></div>}
          </div>
          {analyzing && analysisProgress && <div className="analysis-status" role="status" aria-live="polite">
            <div><strong>{analysisProgress.detail}</strong><span>{analysisProgress.total ? `${analysisPercent}%` : "Starting…"}</span></div>
            <button type="button" onClick={cancelAnalysis}>Cancel analysis</button>
          </div>}
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
      <section className="landing-section" id="features">
        <span>FEATURES</span><h2>Private PDF redaction, with you in control</h2>
        <div className="landing-card-grid"><article><b>Local PDF analysis</b><p>Your document is analysed in browser memory and is not uploaded to Redactify.</p></article><article><b>Review every suggestion</b><p>Approve, resize, move, keep, or remove redaction boxes before you export.</p></article><article><b>Permanent redaction</b><p>Approved areas are burned into a rebuilt PDF, followed by an independent security check.</p></article></div>
      </section>
      <section className="landing-section pricing-section" id="pricing">
        <span>PRICING</span><h2>Free while Redactify is in beta</h2><p>Use the local PDF redaction workflow without creating an account.</p><button type="button" className="primary-button" onClick={focusUploader}>Start redacting, for free <b>→</b></button>
      </section>
      <section className="landing-section faq-section" id="faq">
        <span>FAQ</span><h2>Good to know before you begin</h2>
        <details><summary>Does Redactify upload my PDF?</summary><p>No. Your PDF is processed in browser memory on your device.</p></details>
        <details><summary>Are scanned PDFs supported?</summary><p>Not yet. Redactify currently supports searchable, text-based PDFs.</p></details>
        <details><summary>Can I review every suggestion?</summary><p>Yes. You can approve, edit, keep, or delete redaction boxes before exporting.</p></details>
      </section>
      <footer className="site-footer" id="site-footer" aria-label="Redactify footer">
        <div className="footer-main">
          <div className="footer-brand"><button className="brand-button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Back to the top"><span className="brand-icon"><i /><i /><i /></span><strong>Redactify</strong></button><p>Redact sensitive details privately, directly from your device.</p></div>
          <div className="footer-column"><strong>Product</strong><a href="#privacy-story">How it works</a><a href="#features">Features</a><a href="#pricing">Pricing</a></div>
          <div className="footer-column"><strong>Resources</strong><a href="#faq">FAQ</a><a href="#quick-upload">Text-based PDFs</a><a href="#privacy-story">Privacy promise</a></div>
          <div className="footer-column"><strong>For</strong><span>Legal professionals</span><span>Financial services professionals</span><span>Recruiters</span><span>Individuals</span></div>
          <div className="footer-column"><strong>Company</strong><a href="#privacy-story">Privacy</a><a href="#faq">Terms of use</a><a href="#faq">Cookies</a></div>
        </div>
        <div className="footer-bottom"><span>© 2026 Redactify. All rights reserved.</span><span>Local PDF redaction</span></div>
      </footer>
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
          {viewerError && <div className="viewer-error" role="alert"><span>{viewerError}</span><button type="button" onClick={() => setViewerLoadAttempt((attempt) => attempt + 1)}>Retry viewer</button></div>}
          <div className="pdf-stage" ref={stageRef} onScroll={updatePageFromScroll} aria-busy={!reviewDocument && !viewerError}>
            {!reviewDocument && !viewerError && <div className="viewer-starting" role="status">Preparing the document viewer…</div>}
            {fileBytes && Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => <div
              className="pdf-page-entry"
              key={pageNumber}
              data-page={pageNumber}
              style={{ minHeight: (pageDimensions[pageNumber - 1]?.height || 792) * zoom + 44 }}
            >
              <div className="pdf-page-number">Page {pageNumber}</div>
              {reviewDocument && Math.abs(pageNumber - activePage) <= 1 ? <PdfPageView
                document={reviewDocument}
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
              /> : <div className="pdf-page-placeholder" style={{ width: (pageDimensions[pageNumber - 1]?.width || 612) * zoom, height: (pageDimensions[pageNumber - 1]?.height || 792) * zoom }}><span>Page {pageNumber} will render as you approach it</span></div>}
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
            <button className="primary-button compact sidebar-export" onClick={createRedactedPdf} disabled={!selectedCount || creating}>{creating ? exportProgress?.stage === "verifying" ? "Verifying…" : "Creating…" : "Apply & export"} <b>→</b></button>
            {creating && exportProgress && <div className="export-status" role="status" aria-live="polite">
              <div><strong>{exportProgress.detail}</strong><span>{exportPercent}%</span></div>
              <div className="export-track" aria-hidden="true"><i style={{ width: `${exportPercent}%` }} /></div>
              <button type="button" onClick={cancelExport}>Cancel export</button>
            </div>}
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
              className={`suggestion-card ${finding.selected ? "selected" : "kept"} ${finding.reported ? "reported" : ""} ${activeFindingId === finding.id ? "active" : ""} ${selectedFindingIds.has(finding.id) ? "bulk-active" : ""}`}
              key={finding.id}
              style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) activateFinding(finding.id, true);
                else showFinding(finding);
              }}
            >
              <div className="suggestion-meta"><span className={categoryMeta[finding.kind].className}>{finding.manual ? "MANUAL" : finding.detail.split(" · ")[0].toUpperCase()}</span><small>p.{finding.rects[0]?.page}{finding.occurrenceCount > 1 ? ` · ${finding.occurrenceCount} occurrences` : finding.rects.length > 1 ? " · multi-line" : ""}</small>{finding.country && <span className="country-badge">{finding.country}</span>}<span className={`confidence-badge ${finding.confidence}`} title={confidenceMeta[finding.confidence].summary}>{confidenceMeta[finding.confidence].label}</span><button type="button" className="locate-button" onClick={(event) => { event.stopPropagation(); showFinding(finding); }}>Jump to match</button></div>
              <code>{finding.label}</code>
              <div className="detection-explanation"><strong>Why detected</strong><span>{finding.reason}</span><small>{confidenceMeta[finding.confidence].summary}</small></div>
              <p className="edit-hint">Drag the box to move it; drag any edge or corner to resize it.</p>
              {finding.reported && <div className="reported-notice">Marked incorrect for this session{finding.reportReason ? ` · ${finding.reportReason}` : ""}</div>}
              <div className="choice-row">
                <button className={finding.selected ? "active-redact" : ""} onClick={(event) => { event.stopPropagation(); toggle(finding.id, true); }}>✓ Redact</button>
                <button className={!finding.selected ? "active-keep" : ""} onClick={(event) => { event.stopPropagation(); toggle(finding.id, false); }}>× Keep</button>
                {!finding.manual && <button onClick={(event) => { event.stopPropagation(); selectSimilar(finding); }}>Select similar</button>}
                {finding.occurrenceCount > 1 && <button onClick={(event) => { event.stopPropagation(); showNextOccurrence(finding); }}>Next match</button>}
                {finding.rects.length > 1 && <button onClick={(event) => { event.stopPropagation(); mergeFindingRects(finding.id); }}>Merge boxes</button>}
                <button className="remove-finding" aria-label={`Remove ${finding.label}`} onClick={(event) => { event.stopPropagation(); removeFinding(finding.id); }}>Delete</button>
              </div>
              {!finding.manual && !finding.reported && <button type="button" className="report-incorrect" onClick={(event) => { event.stopPropagation(); setReportingFindingId((current) => current === finding.id ? null : finding.id); }}>Report incorrect suggestion</button>}
              {reportingFindingId === finding.id && <div className="incorrect-report-panel" role="group" aria-label="Reason this suggestion is incorrect" onClick={(event) => event.stopPropagation()}>
                <strong>What went wrong?</strong>
                    <span>This feedback stays in this browser session. No document text or report is sent anywhere.</span>
                <div>{incorrectSuggestionReasons.map((reason) => <button type="button" key={reason} onClick={() => reportIncorrectFinding(finding.id, reason)}>{reason}</button>)}</div>
                <button type="button" className="cancel-report" onClick={() => setReportingFindingId(null)}>Cancel</button>
              </div>}
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
