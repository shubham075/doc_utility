import type { PdfDocument, TextItem } from '@pdfsuite/engine';
import type { TextSource } from './search';

/** Memoizes per-page text runs from an engine that implements `getTextItems`. */
export class TextCache implements TextSource {
  private cache = new Map<number, Promise<TextItem[]>>();

  constructor(private readonly doc: PdfDocument) {}

  get pageCount(): number {
    return this.doc.pageCount;
  }

  getItems(index: number): Promise<TextItem[]> {
    let p = this.cache.get(index);
    if (!p) {
      p = (async () => {
        const page = await this.doc.getPage(index);
        try {
          return (await page.getTextItems?.()) ?? [];
        } finally {
          page.close();
        }
      })();
      p.catch(() => this.cache.delete(index));
      this.cache.set(index, p);
    }
    return p;
  }
}
