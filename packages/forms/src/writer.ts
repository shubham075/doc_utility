import { PDFCheckBox, PDFDropdown, PDFHexString, PDFOptionList, PDFRadioGroup, PDFTextField, StandardFonts } from 'pdf-lib';
import { loadDoc } from '@pdfsuite/annotations';
import type { FieldValue } from './model';

export interface WriteFormOptions {
  /** Only the fields whose values changed (others keep their existing appearance streams byte-for-byte). */
  values: ReadonlyMap<string, FieldValue>;
  /** Text to draw for a text field when it differs from the stored value (e.g. "$1,234.00" for 1234). */
  display?: ReadonlyMap<string, string>;
  /** Burn the field appearances into the page and remove the form. */
  flatten?: boolean;
}

/**
 * Write form values into the PDF and regenerate appearance streams for the changed fields only.
 * Note: pdf-lib rewrites the whole file (no incremental update), which invalidates existing signatures.
 */
export async function writeForm(bytes: Uint8Array, opts: WriteFormOptions): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const supported = new Set(font.getCharacterSet());
  const encodable = (s: string) => Array.from(s, (ch) => (supported.has(ch.codePointAt(0)!) || ch === '\n' ? ch : '?')).join('');

  for (const [name, value] of opts.values) {
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) {
        const raw = typeof value === 'string' ? value : String(value);
        let shown = opts.display?.get(name) ?? raw;
        const max = field.getMaxLength();
        if (max !== undefined) shown = shown.slice(0, max);
        field.setText(encodable(shown) || undefined);
        if (shown !== raw) field.acroField.setValue(PDFHexString.fromText(raw)); // keep the real value in /V
        field.updateAppearances(font);
      } else if (field instanceof PDFCheckBox) {
        if (value === true) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === 'string' && value && field.getOptions().includes(value)) field.select(value);
        else field.clear();
      } else if (field instanceof PDFDropdown) {
        const v = Array.isArray(value) ? (value[0] ?? '') : String(value);
        if (!v) field.clear();
        else {
          if (!field.getOptions().includes(v) && field.isEditable()) field.addOptions([v]);
          if (field.getOptions().includes(v)) field.select(v);
        }
        field.updateAppearances(font);
      } else if (field instanceof PDFOptionList) {
        const vs = (Array.isArray(value) ? value : [String(value)]).filter((v) => field.getOptions().includes(v));
        if (vs.length) field.select(vs);
        else field.clear();
        field.updateAppearances(font);
      }
    } catch (e) {
      console.warn(`Could not write form field "${name}"`, e);
    }
  }

  if (opts.flatten) form.flatten({ updateFieldAppearances: false });
  return doc.save({ updateFieldAppearances: false });
}
