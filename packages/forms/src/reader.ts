import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFButton,
  PDFTextField,
  PDFWidgetAnnotation,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import { loadDoc, pageGeometry, rectFromUser, type PageGeometry } from '@pdfsuite/annotations';
import type { FieldActions, FieldType, FieldValue, FormField, FormModel, Widget } from './model';
import { emptyValue } from './model';

const hex = (c: number[] | undefined): string | null => {
  if (!c || !c.length) return null;
  const to = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  if (c.length === 1) return `#${to(c[0]!).repeat(3)}`;
  if (c.length === 3) return `#${to(c[0]!)}${to(c[1]!)}${to(c[2]!)}`;
  if (c.length === 4) {
    const [cy, m, y, k] = c as [number, number, number, number];
    return `#${to((1 - cy) * (1 - k))}${to((1 - m) * (1 - k))}${to((1 - y) * (1 - k))}`;
  }
  return null;
};

export function fieldTypeOf(f: PDFField): FieldType | null {
  if (f instanceof PDFTextField) return 'text';
  if (f instanceof PDFCheckBox) return 'checkbox';
  if (f instanceof PDFRadioGroup) return 'radio';
  if (f instanceof PDFDropdown) return 'dropdown';
  if (f instanceof PDFOptionList) return 'list';
  if (f instanceof PDFButton) return 'pushbutton';
  if (f instanceof PDFSignature) return 'signature';
  return null;
}

/** Decode a /JS entry (text string or stream). */
function jsSource(ctx: PDFContext, action: PDFObject | undefined): string | undefined {
  const a = ctx.lookup(action);
  if (!(a instanceof PDFDict)) return undefined;
  const js = ctx.lookup(a.get(PDFName.of('JS')));
  if (js instanceof PDFString || js instanceof PDFHexString) return js.decodeText();
  if (js instanceof PDFRawStream) {
    try {
      return new TextDecoder('utf-8').decode(decodePDFRawStream(js).decode());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function actionsOf(ctx: PDFContext, dicts: PDFDict[]): FieldActions {
  const out: FieldActions = {};
  for (const d of dicts) {
    const aa = ctx.lookup(d.get(PDFName.of('AA')));
    if (!(aa instanceof PDFDict)) continue;
    const pick = (k: string) => jsSource(ctx, aa.get(PDFName.of(k)));
    out.keystroke ??= pick('K');
    out.format ??= pick('F');
    out.validate ??= pick('V');
    out.calculate ??= pick('C');
  }
  return out;
}

function parseDA(da: string | undefined): { size: number; color: string } {
  const size = da ? /([\d.]+)\s+Tf/.exec(da) : null;
  const rgb = da ? /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da) : null;
  const gray = da ? /([\d.]+)\s+g(?:\s|$)/.exec(da) : null;
  return {
    size: size ? Number(size[1]) : 0,
    color: (rgb ? hex([+rgb[1]!, +rgb[2]!, +rgb[3]!]) : gray ? hex([+gray[1]!]) : null) ?? '#000000',
  };
}

function documentScripts(doc: PDFDocument): string[] {
  const ctx = doc.context;
  const out: string[] = [];
  const names = ctx.lookup(doc.catalog.get(PDFName.of('Names')));
  if (!(names instanceof PDFDict)) return out;
  const tree = ctx.lookup(names.get(PDFName.of('JavaScript')));
  const walk = (node: PDFObject | undefined, depth: number) => {
    const d = ctx.lookup(node);
    if (!(d instanceof PDFDict) || depth > 8) return;
    const list = ctx.lookup(d.get(PDFName.of('Names')));
    if (list instanceof PDFArray) {
      for (let i = 1; i < list.size(); i += 2) {
        const src = jsSource(ctx, list.get(i));
        if (src) out.push(src);
      }
    }
    const kids = ctx.lookup(d.get(PDFName.of('Kids')));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
  };
  walk(tree, 0);
  return out;
}

export interface FormReadResult extends FormModel {
  hasForm: boolean;
  /** True if the form uses XFA (not supported: AcroForm fallback is shown if present). */
  xfa: boolean;
}

/** Parse the AcroForm of a PDF into the display-space form model. */
export async function readForm(bytes: Uint8Array): Promise<FormReadResult> {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const empty: FormReadResult = { hasForm: false, xfa: false, fields: [], calculationOrder: [], documentScripts: [], tabOrder: [] };
  const acro = ctx.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  if (!(acro instanceof PDFDict)) return empty;

  const pages = doc.getPages();
  const geometry: PageGeometry[] = pages.map(pageGeometry);
  // widget ref -> page index, and per-page annotation order (for tab order)
  const pageOfWidget = new Map<string, number>();
  const annotOrder: PDFRef[][] = pages.map(() => []);
  pages.forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i);
      if (r instanceof PDFRef) {
        pageOfWidget.set(r.toString(), pi);
        annotOrder[pi]!.push(r);
      }
    }
  });

  const refOfDict = new Map<PDFObject, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) refOfDict.set(obj, ref);

  let acroFields: PDFField[] = [];
  try {
    acroFields = doc.getForm().getFields();
  } catch {
    return { ...empty, hasForm: true };
  }

  const fields: FormField[] = [];
  const widgetKey = new Map<string, { field: string; widget: number }>();

  for (const f of acroFields) {
    try {
      const type = fieldTypeOf(f);
      if (!type) continue;
      const widgets: Widget[] = [];
      const acroWidgets = f.acroField.getWidgets();
      const dicts: PDFDict[] = [f.acroField.dict];
      acroWidgets.forEach((w: PDFWidgetAnnotation, wi: number) => {
        dicts.push(w.dict);
        const wref = refOfDict.get(w.dict);
        let page = wref ? pageOfWidget.get(wref.toString()) : undefined;
        if (page === undefined) {
          const p = ctx.lookup(w.dict.get(PDFName.of('P')));
          const idx = pages.findIndex((pg) => pg.node === p);
          page = idx >= 0 ? idx : 0;
        }
        const g = geometry[page]!;
        const r = w.getRectangle();
        const rect = rectFromUser(g, [r.x, r.y, r.x + r.width, r.y + r.height]);
        const mk = w.getAppearanceCharacteristics();
        let exportValue: string | undefined;
        if (type === 'checkbox') exportValue = w.getOnValue()?.decodeText();
        if (type === 'radio') {
          // With an /Opt array the widget's appearance state is just an index; the option text is the export value.
          const opts = (f as PDFRadioGroup).getOptions();
          const on = w.getOnValue()?.decodeText();
          exportValue = on !== undefined && opts.includes(on) ? on : (opts[wi] ?? on);
        }
        widgets.push({
          page,
          rect,
          exportValue,
          background: hex(mk?.getBackgroundColor()),
          borderColor: hex(mk?.getBorderColor()),
          borderWidth: w.getBorderStyle()?.getWidth() ?? (mk?.getBorderColor() ? 1 : 0),
          ref: wref ? `${wref.objectNumber} ${wref.generationNumber}` : `w${wi}`,
        });
        if (wref) widgetKey.set(wref.toString(), { field: f.getName(), widget: wi });
      });
      if (!widgets.length) continue;

      const da = parseDA(f.acroField.getDefaultAppearance() ?? widgetDA(ctx, acroWidgets));
      let value: FieldValue = emptyValue(type);
      let options: { value: string; label: string }[] = [];
      let multiline = false;
      let password = false;
      let comb = false;
      let maxLength: number | undefined;
      let multiSelect = false;
      let editable = false;
      let align: 0 | 1 | 2 = 0;

      if (f instanceof PDFTextField) {
        value = f.getText() ?? '';
        multiline = f.isMultiline();
        password = f.isPassword();
        comb = f.isCombed();
        maxLength = f.getMaxLength();
        align = (f.getAlignment() as unknown as number) === 1 ? 1 : (f.getAlignment() as unknown as number) === 2 ? 2 : 0;
      } else if (f instanceof PDFCheckBox) {
        value = f.isChecked();
      } else if (f instanceof PDFRadioGroup) {
        value = f.getSelected() ?? '';
        options = f.getOptions().map((o) => ({ value: o, label: o }));
      } else if (f instanceof PDFDropdown) {
        value = f.getSelected()[0] ?? '';
        options = f.getOptions().map((o) => ({ value: o, label: o }));
        editable = f.isEditable();
        multiSelect = false;
      } else if (f instanceof PDFOptionList) {
        value = f.getSelected();
        options = f.getOptions().map((o) => ({ value: o, label: o }));
        multiSelect = f.isMultiselect();
      }

      fields.push({
        name: f.getName(),
        type,
        widgets,
        value,
        defaultValue: value,
        options,
        readOnly: f.isReadOnly(),
        required: f.isRequired(),
        multiline,
        password,
        comb,
        maxLength,
        multiSelect,
        editable,
        fontSize: da.size,
        textColor: da.color,
        align,
        tooltip: tooltipOf(ctx, f.acroField.dict),
        actions: actionsOf(ctx, dicts),
      });
    } catch (e) {
      console.warn('Skipping unreadable form field', e);
    }
  }

  // ---- calculation order: /CO first, then remaining fields with calculate scripts in document order
  const withCalc = new Set(fields.filter((f) => f.actions.calculate).map((f) => f.name));
  const calculationOrder: string[] = [];
  const co = ctx.lookup(acro.get(PDFName.of('CO')));
  if (co instanceof PDFArray) {
    for (let i = 0; i < co.size(); i++) {
      const d = ctx.lookup(co.get(i));
      const n = d instanceof PDFDict ? qualifiedName(ctx, d) : undefined;
      if (n && withCalc.has(n) && !calculationOrder.includes(n)) calculationOrder.push(n);
    }
  }
  for (const f of fields) if (withCalc.has(f.name) && !calculationOrder.includes(f.name)) calculationOrder.push(f.name);

  return {
    hasForm: true,
    xfa: acro.get(PDFName.of('XFA')) !== undefined,
    fields,
    calculationOrder,
    documentScripts: documentScripts(doc),
    tabOrder: tabOrderOf(doc, annotOrder, widgetKey, fields),
  };
}

function widgetDA(ctx: PDFContext, widgets: PDFWidgetAnnotation[]): string | undefined {
  for (const w of widgets) {
    const v = ctx.lookup(w.dict.get(PDFName.of('DA')));
    if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  }
  return undefined;
}

function tooltipOf(ctx: PDFContext, d: PDFDict): string | undefined {
  const v = ctx.lookup(d.get(PDFName.of('TU')));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}

function qualifiedName(ctx: PDFContext, d: PDFDict): string | undefined {
  const parts: string[] = [];
  let cur: PDFDict | undefined = d;
  for (let i = 0; cur && i < 32; i++) {
    const t = ctx.lookup(cur.get(PDFName.of('T')));
    if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText());
    const p: PDFObject | undefined = ctx.lookup(cur.get(PDFName.of('Parent')));
    cur = p instanceof PDFDict ? p : undefined;
  }
  return parts.length ? parts.join('.') : undefined;
}

/** Tab order per page honouring /Tabs (R rows, C columns, S/none = annotation order). */
function tabOrderOf(
  doc: PDFDocument,
  annotOrder: PDFRef[][],
  widgetKey: Map<string, { field: string; widget: number }>,
  fields: FormField[],
): { field: string; widget: number }[] {
  const ctx = doc.context;
  const out: { field: string; widget: number }[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));
  doc.getPages().forEach((page, pi) => {
    const refs = annotOrder[pi]!.filter((r) => widgetKey.has(r.toString()));
    if (!refs.length) return;
    const mode = ctx.lookup(page.node.get(PDFName.of('Tabs')));
    const kind = mode instanceof PDFName ? mode.decodeText() : 'S';
    const entries = refs.map((r, order) => {
      const k = widgetKey.get(r.toString())!;
      const w = byName.get(k.field)!.widgets[k.widget]!;
      return { k, rect: w.rect, order };
    });
    if (kind === 'R') entries.sort((a, b) => Math.round(a.rect.y / 4) - Math.round(b.rect.y / 4) || a.rect.x - b.rect.x || a.order - b.order);
    else if (kind === 'C') entries.sort((a, b) => Math.round(a.rect.x / 4) - Math.round(b.rect.x / 4) || a.rect.y - b.rect.y || a.order - b.order);
    for (const e of entries) out.push(e.k);
  });
  return out;
}
