import init, {
  processPdf,
  version,
  type PdfProcessResult,
} from "@firecrawl/pdf-inspector-wasm";

type InspectRequest = { id: string; bytes: ArrayBuffer };
type InspectResponse =
  | { id: string; ok: true; result: PdfProcessResult; version: string }
  | { id: string; ok: false; error: string };

let initialization: Promise<unknown> | null = null;

self.onmessage = async (event: MessageEvent<InspectRequest>) => {
  const { id, bytes } = event.data;
  try {
    initialization ??= init();
    await initialization;
    const result = processPdf(new Uint8Array(bytes), {
      profile: "compact",
      includePageMarkers: true,
      includeImages: false,
    });
    self.postMessage({ id, ok: true, result, version: version() } satisfies InspectResponse);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "PDF inspection failed",
    } satisfies InspectResponse);
  }
};

