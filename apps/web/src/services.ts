/** Client for the PDF Suite API service (Office/HTML conversion, server-side compress and OCR). */

const BASE = (import.meta.env.VITE_SERVICES_URL as string | undefined) ?? '/api';
const KEY = 'pdfsuite.apiKey';

export interface Capabilities {
  'office-to-pdf': boolean;
  'html-to-pdf': boolean;
  compress: boolean;
  ocr: boolean;
}

function headers(): Record<string, string> {
  try {
    const k = localStorage.getItem(KEY);
    return k ? { authorization: `Bearer ${k}` } : {};
  } catch {
    return {};
  }
}

/** Null when the service is not reachable (features that need it stay disabled). */
export async function getCapabilities(): Promise<Capabilities | null> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500), headers: headers() });
    if (!r.ok) return null;
    const j = (await r.json()) as { ok: boolean; capabilities: Capabilities };
    return j.ok ? j.capabilities : null;
  } catch {
    return null;
  }
}

export interface JobHandlers {
  onProgress?(fraction: number): void;
  signal?: AbortSignal;
}

export type JobKind = 'office-to-pdf' | 'html-to-pdf' | 'compress' | 'ocr';

/** Upload a file, wait for the job, download the result. Throws with the server's message on failure. */
export async function runJob(kind: JobKind, file: { name: string; data: Uint8Array }, options: object, h: JobHandlers = {}): Promise<{ data: Uint8Array; filename: string }> {
  const form = new FormData();
  form.set('options', JSON.stringify(options));
  form.set('file', new Blob([file.data as BlobPart]), file.name);
  const sub = await fetch(`${BASE}/v1/jobs/${kind}`, { method: 'POST', body: form, headers: headers(), signal: h.signal });
  if (!sub.ok) throw new Error(await errorText(sub));
  const { id } = (await sub.json()) as { id: string };

  const cancel = () => void fetch(`${BASE}/v1/jobs/${id}`, { method: 'DELETE', headers: headers() }).catch(() => undefined);
  h.signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (h.signal?.aborted) throw new Error('Cancelled');
      const r = await fetch(`${BASE}/v1/jobs/${id}`, { headers: headers(), signal: h.signal });
      if (!r.ok) throw new Error(await errorText(r));
      const j = (await r.json()) as { state: string; progress: number; error?: string };
      h.onProgress?.(j.progress);
      if (j.state === 'done') break;
      if (j.state === 'failed' || j.state === 'canceled') throw new Error(j.error ?? `Job ${j.state}`);
      await new Promise((res) => setTimeout(res, 400));
    }
    const res = await fetch(`${BASE}/v1/jobs/${id}/result`, { headers: headers(), signal: h.signal });
    if (!res.ok) throw new Error(await errorText(res));
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'result.pdf';
    return { data: new Uint8Array(await res.arrayBuffer()), filename };
  } finally {
    h.signal?.removeEventListener('abort', cancel);
    cancel(); // free the result on the server (no-op if already gone)
  }
}

async function errorText(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string };
    return j.error ?? `Request failed (${r.status})`;
  } catch {
    return `Request failed (${r.status})`;
  }
}
