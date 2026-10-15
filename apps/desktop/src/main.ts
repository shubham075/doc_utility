import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC, type OpenedFile } from './ipc';

const DEV_URL = process.env.PDFSUITE_DEV_URL;
const WEB_DIST = join(__dirname, '..', '..', 'web', 'dist');
const APP_ORIGIN = 'app://pdfsuite';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// wasm-unsafe-eval: PDFium WASM. No remote origins at all.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

let mainWindow: BrowserWindow | null = null;
const pendingFiles: string[] = [];

const isPdf = (p: string) => extname(p).toLowerCase() === '.pdf';

async function load(path: string): Promise<OpenedFile> {
  const buf = await readFile(path);
  app.addRecentDocument(path);
  return { name: basename(path), path, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
}

async function sendOpened(path: string) {
  try {
    const file = await load(path);
    mainWindow?.webContents.send(IPC.fileOpened, file);
  } catch (e) {
    dialog.showErrorBox('Cannot open file', `${path}\n\n${String(e)}`);
  }
}

function pdfArgs(argv: string[]): string[] {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && isPdf(a));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    title: 'PDF Suite',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));

  // Never let the app window navigate away or spawn windows; external links go to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith(APP_ORIGIN);
    if (!allowed) e.preventDefault();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    for (const p of pendingFiles.splice(0)) void sendOpened(p);
  });
  void mainWindow.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    const full = join(WEB_DIST, rel);
    if (full !== WEB_DIST && !full.startsWith(WEB_DIST + sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(full).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(res.body, { status: res.status, headers });
  });
}

function registerIpc() {
  ipcMain.handle(IPC.openDialog, async (): Promise<OpenedFile[]> => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    return r.canceled ? [] : Promise.all(r.filePaths.map(load));
  });
  ipcMain.handle(IPC.saveDialog, async (_e, suggestedName: string, bytes: Uint8Array) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: basename(String(suggestedName)),
      filters: extname(String(suggestedName)).toLowerCase() === '.zip' ? [{ name: 'ZIP archive', extensions: ['zip'] }] : [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, bytes); // TODO(phase 3+): atomic write (temp + rename)
    return r.filePath;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    for (const p of pdfArgs(argv)) void sendOpened(p);
  });
  // macOS file association
  app.on('open-file', (e, path) => {
    e.preventDefault();
    if (mainWindow?.webContents.isLoading() === false) void sendOpened(path);
    else pendingFiles.push(path);
  });

  void app.whenReady().then(() => {
    if (!DEV_URL) registerAppProtocol();
    registerIpc();
    pendingFiles.push(...pdfArgs(process.argv));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
