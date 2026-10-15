/** IPC channel names shared by main and preload. */
export const IPC = {
  openDialog: 'file:open-dialog',
  readFile: 'file:read',
  fileOpened: 'file:opened', // main -> renderer (OS file association, second instance)
  saveDialog: 'file:save',
} as const;

export interface OpenedFile {
  name: string;
  path: string;
  bytes: Uint8Array;
}
