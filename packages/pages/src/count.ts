import { loadDoc } from '@pdfsuite/annotations';

/** Number of pages in a PDF. */
export async function countPages(bytes: Uint8Array): Promise<number> {
  return (await loadDoc(bytes)).getPageCount();
}
