import { useEffect, useRef, useState } from 'react';
import { saveSignature, trimToPng, whiteToTransparent, type SavedSignature, type SignatureKind } from './signatures';

type Mode = 'draw' | 'type' | 'image';

interface Props {
  kind: SignatureKind;
  onDone(sig: SavedSignature | null): void;
}

const W = 520;
const H = 170;
const SCRIPT_FONT = "'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Snell Roundhand', cursive";

/** Create a signature or initials: draw it, type it, or upload an image. Result is a trimmed transparent PNG. */
export function SignatureDialog({ kind, onDone }: Props) {
  const label = kind === 'signature' ? 'signature' : 'initials';
  const [mode, setMode] = useState<Mode>('draw');
  const [typed, setTyped] = useState('');
  const [remember, setRemember] = useState(true);
  const [removeWhite, setRemoveWhite] = useState(true);
  const [hasInk, setHasInk] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const uploaded = useRef<HTMLImageElement | null>(null);

  const ctx = () => canvasRef.current!.getContext('2d')!;
  const clear = () => {
    ctx().clearRect(0, 0, W, H);
    setHasInk(false);
  };

  // ---- draw
  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'draw') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = pos(e);
    const c = ctx();
    c.fillStyle = '#111';
    c.beginPath();
    c.arc(drawing.current.x, drawing.current.y, 1.6, 0, Math.PI * 2);
    c.fill();
    setHasInk(true);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const p = pos(e);
    const c = ctx();
    c.strokeStyle = '#111';
    c.lineWidth = 3.2;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(drawing.current.x, drawing.current.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    drawing.current = p;
  };
  const onUp = () => {
    drawing.current = null;
  };

  // ---- type / image previews render into the same canvas
  useEffect(() => {
    if (mode === 'type') {
      clear();
      if (!typed.trim()) return;
      const c = ctx();
      c.fillStyle = '#111';
      c.textBaseline = 'middle';
      let size = 90;
      c.font = `italic ${size}px ${SCRIPT_FONT}`;
      while (c.measureText(typed).width > W - 24 && size > 16) {
        size -= 4;
        c.font = `italic ${size}px ${SCRIPT_FONT}`;
      }
      c.fillText(typed, 12, H / 2);
      setHasInk(true);
    }
  }, [mode, typed]);

  useEffect(() => {
    if (mode !== 'image') return;
    const img = uploaded.current;
    clear();
    if (!img) return;
    const k = Math.min(W / img.width, H / img.height, 1);
    ctx().drawImage(img, 0, 0, img.width * k, img.height * k);
    if (removeWhite) whiteToTransparent(canvasRef.current!);
    setHasInk(true);
  }, [mode, removeWhite, imageReady]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      uploaded.current = img;
      setImageReady((v) => !v);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const apply = () => {
    const sig = canvasRef.current ? trimToPng(canvasRef.current) : null;
    if (!sig) return;
    if (remember) saveSignature(kind, sig);
    onDone(sig);
  };

  return (
    <div className="pv-modal-backdrop" role="presentation" onPointerDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <div className="pv-modal" role="dialog" aria-modal="true" aria-label={`Create ${label}`}>
        <h3>{kind === 'signature' ? 'Add signature' : 'Add initials'}</h3>
        <div className="pv-tabs" role="tablist">
          {(['draw', 'type', 'image'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                clear();
              }}
            >
              {m === 'draw' ? 'Draw' : m === 'type' ? 'Type' : 'Image'}
            </button>
          ))}
        </div>
        {mode === 'type' && <input autoFocus className="pv-search-input" placeholder={`Type your ${label}`} value={typed} onChange={(e) => setTyped(e.target.value)} />}
        {mode === 'image' && (
          <div className="pv-search-row">
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => onFile(e.target.files?.[0])} />
            <label>
              <input type="checkbox" checked={removeWhite} onChange={(e) => setRemoveWhite(e.target.checked)} /> Remove white background
            </label>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="pv-sig-canvas"
          width={W}
          height={H}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          aria-label={mode === 'draw' ? `Draw your ${label} here` : 'Preview'}
        />
        <div className="pv-search-row">
          {mode === 'draw' && <button onClick={clear}>Clear</button>}
          <label>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Save for future use
          </label>
          <span className="pv-spacer" />
          <button onClick={() => onDone(null)}>Cancel</button>
          <button className="pv-primary" onClick={apply} disabled={!hasInk}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
