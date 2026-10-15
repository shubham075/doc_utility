import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PdfDocument, TextItem } from '@pdfsuite/engine';
import type { Size } from './layout';
import type { RenderQueue } from './renderQueue';
import type { SearchMatch } from './search';
import type { TextCache } from './textCache';

const MAX_CANVAS_PIXELS = 40_000_000;

/** Pick the bitmap scale for a page: device-pixel sharp, capped so huge zooms cannot exhaust memory. */
export function bitmapScale(size: Size, zoom: number, dpr: number): number {
  const wanted = Math.round(zoom * dpr * 100) / 100;
  const pixels = size.width * size.height * wanted * wanted;
  return pixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / (size.width * size.height)) : wanted;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
function measure(text: string, font: string): number {
  const key = font + '|' + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    if (!measureCtx) return 0;
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
    if (widthCache.size > 50_000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

interface Props {
  index: number;
  size: Size;
  zoom: number;
  left: number;
  top: number;
  doc: PdfDocument;
  queue: RenderQueue;
  textCache: TextCache | null;
  /** Reads the page currently nearest the viewport centre, for render ordering. */
  distanceRef: React.RefObject<(index: number) => number>;
  matches: SearchMatch[];
  activeMatch: SearchMatch | null;
}

export const PageView = memo(function PageView({
  index,
  size,
  zoom,
  left,
  top,
  doc,
  queue,
  textCache,
  distanceRef,
  matches,
  activeMatch,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasBitmap = useRef(false);
  const [items, setItems] = useState<TextItem[]>([]);

  // Bitmap rendering. Zoom changes stretch the old bitmap via CSS until the sharp one is ready.
  useEffect(() => {
    const scale = bitmapScale(size, zoom, window.devicePixelRatio || 1);
    let cancel: (() => void) | undefined;
    const timer = setTimeout(
      () => {
        cancel = queue.enqueue({
          priority: () => distanceRef.current(index),
          run: async (signal) => {
            const page = await doc.getPage(index);
            try {
              const bmp = await page.render({ scale });
              if (signal.aborted || !canvasRef.current) return;
              const c = canvasRef.current;
              c.width = bmp.width;
              c.height = bmp.height;
              c.getContext('2d')!.putImageData(
                new ImageData(bmp.data as Uint8ClampedArray<ArrayBuffer>, bmp.width, bmp.height),
                0,
                0,
              );
              hasBitmap.current = true;
            } finally {
              page.close();
            }
          },
        });
      },
      hasBitmap.current ? 120 : 0,
    );
    return () => {
      clearTimeout(timer);
      cancel?.();
    };
  }, [doc, queue, index, size.width, size.height, zoom, distanceRef]);

  useEffect(() => {
    let alive = true;
    setItems([]);
    textCache?.getItems(index).then(
      (it) => alive && setItems(it),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [textCache, index]);

  return (
    <div className="pv-page" data-page={index} style={{ left, top, width: size.width * zoom, height: size.height * zoom }}>
      <canvas ref={canvasRef} className="pv-canvas" />
      <div className="pv-layer" style={{ width: size.width, height: size.height, transform: `scale(${zoom})` }}>
        <Highlights matches={matches} active={activeMatch} />
        <TextLayer items={items} />
      </div>
    </div>
  );
});

function Highlights({ matches, active }: { matches: SearchMatch[]; active: SearchMatch | null }) {
  if (!matches.length) return null;
  return (
    <>
      {matches.map((m) =>
        m.rects.map((r, i) => (
          <div
            key={`${m.start}-${i}`}
            className={m === active ? 'pv-hit pv-hit-active' : 'pv-hit'}
            style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
          />
        )),
      )}
    </>
  );
}

function TextLayer({ items }: { items: TextItem[] }) {
  const spans = useMemo(
    () =>
      items.map((it, i) => {
        const font = `${it.fontSize}px ${it.fontFamily}`;
        const natural = it.str ? measure(it.str, font) : 0;
        const sx = natural > 0 && it.width > 0 ? it.width / natural : 1;
        const originY = it.ascent * it.fontSize;
        return (
          <span key={i}>
            {it.str && (
              <span
                className="pv-text"
                style={{
                  left: it.x,
                  top: it.y - originY,
                  fontSize: it.fontSize,
                  fontFamily: it.fontFamily,
                  transformOrigin: `0 ${originY}px`,
                  transform: `rotate(${it.angle}rad) scaleX(${sx})`,
                }}
              >
                {it.str}
              </span>
            )}
            {it.hasEOL && <br role="presentation" />}
          </span>
        );
      }),
    [items],
  );
  return <div className="pv-text-layer">{spans}</div>;
}
