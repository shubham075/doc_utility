import type { PDFDocument } from 'pdf-lib';
import { loadDoc } from '@pdfsuite/annotations';
import { listLinks, type LinkInfo } from './links';
import { scanPage, type PageObject } from './scan';

/** Read-only inspection shares one parsed document per byte array, so hovering over many pages stays cheap. */
const docs = new WeakMap<Uint8Array, Promise<PDFDocument>>();
const cached = (bytes: Uint8Array) => {
  let d = docs.get(bytes);
  if (!d) {
    d = loadDoc(bytes);
    docs.set(bytes, d);
  }
  return d;
};

export async function listPageObjects(bytes: Uint8Array, pageIndex: number): Promise<PageObject[]> {
  return (await scanPage(await cached(bytes), pageIndex)).objects;
}

export async function listPageLinks(bytes: Uint8Array, pageIndex: number): Promise<LinkInfo[]> {
  return listLinks(bytes, pageIndex, await cached(bytes));
}
