import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFHexString, PDFName, StandardFonts, type PDFField } from 'pdf-lib';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine, type RenderedBitmap } from '@pdfsuite/engine';
import { FormEngine, createQuickJsRunner, readForm, writeForm, type ScriptRunner } from './index';

const js = (doc: PDFDocument, src: string) =>
  doc.context.obj({ S: PDFName.of('JavaScript'), JS: PDFHexString.fromText(src) });

function withActions(doc: PDFDocument, field: PDFField, actions: Record<string, string>) {
  const aa: Record<string, any> = {};
  for (const [k, src] of Object.entries(actions)) aa[k] = js(doc, src);
  field.acroField.dict.set(PDFName.of('AA'), doc.context.obj(aa));
}

/** A small order form: qty * price = total, with formats, a range check, checkbox, radio, dropdown and list. */
async function makeForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 500]);
  const form = doc.getForm();
  const text = (name: string, x: number, y: number, w = 100) => {
    const f = form.createTextField(name);
    f.addToPage(page, { x, y, width: w, height: 20, font, borderWidth: 1 });
    return f;
  };
  const qty = text('qty', 50, 440);
  const price = text('price', 200, 440);
  const total = text('total', 50, 400);
  withActions(doc, qty, { V: 'AFRange_Validate(true, 0, true, 1000);' });
  withActions(doc, price, { F: 'AFNumber_Format(2, 0, 0, 0, "$", true);', K: 'AFNumber_Keystroke(2, 0, 0, 0, "$", true);' });
  withActions(doc, total, { F: 'AFNumber_Format(2, 0, 0, 0, "$", true);', C: 'event.value = Number(this.getField("qty").value) * Number(this.getField("price").value);' });
  total.enableReadOnly();
  doc.getForm().acroForm.dict.set(PDFName.of('CO'), doc.context.obj([total.acroField.ref]));

  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 50, y: 360, width: 16, height: 16, borderWidth: 1 });
  const color = form.createRadioGroup('color');
  color.addOptionToPage('red', page, { x: 50, y: 330, width: 14, height: 14 });
  color.addOptionToPage('blue', page, { x: 90, y: 330, width: 14, height: 14 });
  const country = form.createDropdown('country');
  country.addOptions(['Canada', 'India', 'Japan']);
  country.addToPage(page, { x: 50, y: 290, width: 120, height: 20, font });
  const tags = form.createOptionList('tags');
  tags.addOptions(['a', 'b', 'c']);
  tags.enableMultiselect();
  tags.addToPage(page, { x: 200, y: 260, width: 80, height: 60, font });

  // A second, rotated page with one field.
  const p2 = doc.addPage([400, 500]);
  p2.setRotation({ type: 'degrees', angle: 90 } as never);
  const rot = form.createTextField('rotated');
  rot.addToPage(p2, { x: 50, y: 400, width: 100, height: 20, font });
  return doc.save();
}

let runner: ScriptRunner;
let engines: PdfEngine[] = [];
beforeAll(async () => {
  runner = await createQuickJsRunner();
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  engines = [
    await createPdfiumEngine(),
    await createPdfjsEngine({
      pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs' as string),
      createCanvas: (w, h) => createCanvas(w, h) as never,
      documentParams: { standardFontDataUrl: join(root, 'standard_fonts') + '/' },
    }),
  ];
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});

async function render(engine: PdfEngine, bytes: Uint8Array, page = 0): Promise<RenderedBitmap> {
  const doc = await engine.open(bytes);
  const p = await doc.getPage(page);
  const bmp = await p.render({ scale: 1 });
  doc.close();
  return bmp;
}
const darkIn = (b: RenderedBitmap, x: number, y: number, w: number, h: number) => {
  let n = 0;
  for (let j = Math.floor(y); j < y + h; j++)
    for (let i = Math.floor(x); i < x + w; i++) if (b.data[(j * b.width + i) * 4]! < 100) n++;
  return n;
};

describe('readForm', () => {
  it('reads field types, values, geometry, actions, calc order and tab order', async () => {
    const m = await readForm(await makeForm());
    expect(m.hasForm).toBe(true);
    const by = Object.fromEntries(m.fields.map((f) => [f.name, f]));
    expect(Object.keys(by).sort()).toEqual(['agree', 'color', 'country', 'price', 'qty', 'rotated', 'tags', 'total']);
    expect(by.qty!.type).toBe('text');
    expect(by.agree).toMatchObject({ type: 'checkbox', value: false });
    expect(by.color).toMatchObject({ type: 'radio', value: '' });
    expect(by.color!.widgets.map((w) => w.exportValue)).toEqual(['red', 'blue']);
    expect(by.country).toMatchObject({ type: 'dropdown' });
    expect(by.country!.options.map((o) => o.value)).toEqual(['Canada', 'India', 'Japan']);
    expect(by.tags).toMatchObject({ type: 'list', multiSelect: true });
    expect(by.total!.readOnly).toBe(true);

    // display space: page is 500 high, field bottom-left y=440 height 20 -> top at 500-460=40
    const qr = by.qty!.widgets[0]!.rect; // pdf-lib grows the rect by half the border width
    expect(qr.x).toBeCloseTo(50, -0.5);
    expect(qr.y).toBeCloseTo(40, -0.5);
    expect(qr.width).toBeCloseTo(100, -0.5);
    expect(qr.height).toBeCloseTo(20, -0.5);
    expect(by.qty!.widgets[0]!.borderWidth).toBeGreaterThanOrEqual(1);

    expect(by.price!.actions.format).toContain('AFNumber_Format');
    expect(by.qty!.actions.validate).toContain('AFRange_Validate');
    expect(m.calculationOrder).toEqual(['total']);
    expect(m.tabOrder.map((t) => t.field)).toContain('qty');
    expect(m.tabOrder.filter((t) => t.field === 'color')).toHaveLength(2);

    // rotated page: display is 500 x 400; user rect (50,400)-(150,420) maps to x=400..420 (y_u), y=50..150 (x_u)
    const r = by.rotated!.widgets[0]!;
    expect(r.page).toBe(1);
    expect(r.rect.x).toBeCloseTo(400, -0.5);
    expect(r.rect.y).toBeCloseTo(50, -0.5);
    expect(r.rect.width).toBeCloseTo(20, -0.5);
    expect(r.rect.height).toBeCloseTo(100, -0.5);
  });

  it('returns an empty model for documents without a form', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect((await readForm(await doc.save())).hasForm).toBe(false);
  });
});

describe('FormEngine', () => {
  it('validates, calculates and formats like Acrobat', async () => {
    const m = await readForm(await makeForm());
    const engine = new FormEngine(m, runner);

    let r = engine.commit('price', '12.5');
    expect(r.accepted).toBe(true);
    expect(engine.getValue('price')).toBe('12.5'); // raw value
    expect(engine.getDisplay('price')).toBe('$12.50'); // formatted

    r = engine.commit('qty', '4');
    expect(engine.getValue('total')).toBe('50');
    expect(engine.getDisplay('total')).toBe('$50.00');
    expect(r.changed.get('total')).toBe('50');
    expect(r.display.get('total')).toBe('$50.00');

    r = engine.commit('qty', '5000'); // fails AFRange_Validate(0..1000)
    expect(r.accepted).toBe(false);
    expect(r.alerts[0]).toContain('less than or equal to 1000');
    expect(engine.getValue('qty')).toBe('4');
    expect(engine.getValue('total')).toBe('50');

    r = engine.commit('price', 'abc'); // fails AFNumber_Keystroke
    expect(r.accepted).toBe(false);
    expect(engine.getValue('price')).toBe('12.5');

    engine.commit('agree', true);
    engine.commit('color', 'blue');
    expect(engine.getValue('agree')).toBe(true);
    expect(engine.getValue('color')).toBe('blue');

    const reset = engine.reset();
    expect(engine.getValue('qty')).toBe('');
    expect(engine.getValue('agree')).toBe(false);
    expect(reset.changed.has('qty')).toBe(true);
  });

  it('works without a script runner (plain values)', async () => {
    const m = await readForm(await makeForm());
    const engine = new FormEngine(m, null);
    engine.commit('qty', '7');
    expect(engine.getValue('qty')).toBe('7');
    expect(engine.getDisplay('qty')).toBe('7');
  });
});

describe('writeForm', () => {
  it('writes values that re-read identically and draw in PDFium and PDF.js', async () => {
    const base = await makeForm();
    const out = await writeForm(base, {
      values: new Map<string, string | boolean | string[]>([
        ['qty', '4'],
        ['price', '12.5'],
        ['total', '50'],
        ['agree', true],
        ['color', 'blue'],
        ['country', 'India'],
        ['tags', ['a', 'c']],
      ]),
      display: new Map([
        ['price', '$12.50'],
        ['total', '$50.00'],
      ]),
    });
    const back = await readForm(out);
    const v = Object.fromEntries(back.fields.map((f) => [f.name, f.value]));
    expect(v).toMatchObject({ qty: '4', price: '12.5', total: '50', agree: true, color: 'blue', country: 'India', tags: ['a', 'c'] });

    for (const e of engines) {
      const bmp = await render(e, out);
      // text field "qty" (x 50..150, y 40..60) now has dark text pixels; untouched "rotated" page unaffected
      expect(darkIn(bmp, 52, 42, 96, 16)).toBeGreaterThan(8);
      // checkbox (x 50..66, y 124..140) drawn checked: more dark pixels than just the border would give
      expect(darkIn(bmp, 53, 127, 10, 10)).toBeGreaterThan(5);
    }
  });

  it('flattens the form into page content', async () => {
    const base = await makeForm();
    const out = await writeForm(base, { values: new Map([['qty', '4']]), flatten: true });
    const back = await readForm(out);
    expect(back.fields).toHaveLength(0);
    const bmp = await render(engines[0]!, out);
    expect(darkIn(bmp, 52, 42, 96, 16)).toBeGreaterThan(8);
  });

  it('keeps unchanged fields untouched and tolerates unknown names / over-long text', async () => {
    const base = await makeForm();
    const out = await writeForm(base, { values: new Map([['nope', 'x'], ['qty', 'x'.repeat(30)]]) });
    const back = await readForm(out);
    expect(back.fields.find((f) => f.name === 'qty')!.value).toBe('x'.repeat(30));
    expect(back.fields.find((f) => f.name === 'price')!.value).toBe('');
  });
});
