import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type OpenedFile } from './ipc';

// Sandboxed preload: only this narrow, typed surface reaches the web app.
contextBridge.exposeInMainWorld('pdfsuite', {
  platform: process.platform,
  openFileDialog: (): Promise<OpenedFile[]> => ipcRenderer.invoke(IPC.openDialog),
  saveFile: (suggestedName: string, bytes: Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke(IPC.saveDialog, suggestedName, bytes),
  onFileOpened: (cb: (file: OpenedFile) => void) => {
    const handler = (_e: unknown, file: OpenedFile) => cb(file);
    ipcRenderer.on(IPC.fileOpened, handler);
    return () => ipcRenderer.removeListener(IPC.fileOpened, handler);
  },
});
