import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type OpenedFile } from './ipc';

// Sandboxed preload: only this narrow, typed surface reaches the web app.
contextBridge.exposeInMainWorld('pdfsuite', {
  platform: process.platform,
  openFileDialog: (): Promise<OpenedFile[]> => ipcRenderer.invoke(IPC.openDialog),
  saveFile: (suggestedName: string, bytes: Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke(IPC.saveDialog, suggestedName, bytes),
  scan: process.platform === 'win32' ? (): Promise<Uint8Array | null> => ipcRenderer.invoke(IPC.scan) : undefined,
  onFileOpened: (cb: (file: OpenedFile) => void) => {
    const handler = (_e: unknown, file: OpenedFile) => cb(file);
    ipcRenderer.on(IPC.fileOpened, handler);
    return () => ipcRenderer.removeListener(IPC.fileOpened, handler);
  },
});
