import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PdfDocument } from '@pdfsuite/engine';
import { computeLayout, visibleRange, type Size } from './layout';
import type { RenderQueue } from './renderQueue';

const THUMB_WIDTH = 120;
const LABEL = 22;
const GAP = 10;
const PADDING = 12;

interface Props {
  doc: PdfDocument;
  sizes: Size[];
  queue: RenderQueue;
  current: number;
  onSelect: (page: number) => void;
}

export function Thumbnails({ doc, sizes, queue, current, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  // Each cell = thumbnail + label, so fold the label into the page height.
  const thumbSizes = useMemo(
    () => sizes.map((s) => ({ width: THUMB_WIDTH, height: (s.height / s.width) * THUMB_WIDTH })),
    [sizes],
  );
  const layout = useMemo(
    () => computeLayout(thumbSizes.map((s) => ({ ...s, height: s.height + LABEL })), 1, GAP, PADDING),
    [thumbSizes],
  );
  const { first, last } = visibleRange(layout, scrollTop, height, height);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const el = ref.current;
    const top = layout.tops[current];
    if (!el || top === undefined) return;
    const bottom = top + layout.heights[current]!;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = top - el.clientHeight / 2 + layout.heights[current]! / 2;
    }
  }, [current, layout]);

  const cells = [];
  for (let i = first; i <= last; i++) {
    cells.push(
      <Thumb
        key={i}
        index={i}
        size={thumbSizes[i]!}
        top={layout.tops[i]!}
        doc={doc}
        queue={queue}
        selected={i === current}
        currentRef={current}
        onSelect={onSelect}
      />,
    );
  }

  return (
    <div className="pv-thumbs" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: layout.total, position: 'relative' }}>{cells}</div>
    </div>
  );
}

const Thumb = memo(function Thumb({
  index,
  size,
  top,
  doc,
  queue,
  selected,
  currentRef,
  onSelect,
}: {
  index: number;
  size: Size;
  top: number;
  doc: PdfDocument;
  queue: RenderQueue;
  selected: boolean;
  currentRef: number;
  onSelect: (page: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(currentRef);
  latest.current = currentRef;

  useEffect(() => {
    const cancel = queue.enqueue({
      // Thumbnails yield to main page rendering.
      priority: () => 1000 + Math.abs(index - latest.current),
      run: async (signal) => {
        const page = await doc.getPage(index);
        try {
          const scale = (THUMB_WIDTH / page.width) * (window.devicePixelRatio || 1);
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
        } finally {
          page.close();
        }
      },
    });
    return cancel;
  }, [doc, queue, index]);

  return (
    <button
      className={selected ? 'pv-thumb pv-thumb-selected' : 'pv-thumb'}
      style={{ top, height: size.height + LABEL }}
      onClick={() => onSelect(index)}
      aria-label={`Page ${index + 1}`}
      aria-current={selected}
    >
      <canvas ref={canvasRef} style={{ width: size.width, height: size.height }} />
      <span>{index + 1}</span>
    </button>
  );
});
