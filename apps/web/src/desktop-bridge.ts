/** Surface injected by apps/desktop/src/preload.ts. Undefined when running in a plain browser. */
export interface DesktopFile {
  name: string;
  path: string;
  bytes: Uint8Array;
}
export interface DesktopBridge {
  platform: string;
  openFileDialog(): Promise<DesktopFile[]>;
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<string | null>;
  onFileOpened(cb: (file: DesktopFile) => void): () => void;
}
declare global {
  interface Window {
    pdfsuite?: DesktopBridge;
  }
}
export const desktop = (): DesktopBridge | undefined => window.pdfsuite;
