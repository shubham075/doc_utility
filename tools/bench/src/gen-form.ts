/** Builds a sample AcroForm (formats, validation, calculation, all widget types) for manual testing. */
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb, type PDFField } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const page = doc.addPage([612, 792]);
const form = doc.getForm();

const js = (src: string) => doc.context.obj({ S: PDFName.of('JavaScript'), JS: PDFHexString.fromText(src) });
const actions = (field: PDFField, a: Record<string, string>) => {
  const aa: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) aa[k] = js(v);
  field.acroField.dict.set(PDFName.of('AA'), doc.context.obj(aa));
};
const label = (text: string, x: number, y: number, size = 10) => page.drawText(text, { x, y, size, font });
const text = (name: string, x: number, y: number, w = 160) => {
  const f = form.createTextField(name);
  f.addToPage(page, { x, y, width: w, height: 20, font, borderWidth: 1, borderColor: rgb(0.4, 0.4, 0.4) });
  return f;
};

page.drawText('Order form', { x: 50, y: 730, size: 22, font: bold });
label('Name', 50, 690);
text('name', 50, 664, 250).setMaxLength(40);
label('Order date (mm/dd/yyyy)', 330, 690);
actions(text('date', 330, 664, 150), { F: 'AFDate_FormatEx("mm/dd/yyyy");', K: 'AFDate_KeystrokeEx("mm/dd/yyyy");' });
label('Phone', 50, 630);
actions(text('phone', 50, 604, 150), { F: 'AFSpecial_Format(2);', K: 'AFSpecial_Keystroke(2);' });

label('Quantity (1-100)', 50, 560);
actions(text('qty', 50, 534, 100), { V: 'AFRange_Validate(true, 1, true, 100);', K: 'AFNumber_Keystroke(0, 0, 0, 0, "", true);' });
label('Unit price', 200, 560);
actions(text('price', 200, 534, 100), { F: 'AFNumber_Format(2, 0, 0, 0, "$", true);', K: 'AFNumber_Keystroke(2, 0, 0, 0, "$", true);' });
label('Tax (%)', 350, 560);
actions(text('tax', 350, 534, 80), { F: 'AFPercent_Format(1, 0);' });
label('Total (calculated)', 50, 500);
const total = text('total', 50, 474, 150);
total.enableReadOnly();
actions(total, {
  F: 'AFNumber_Format(2, 0, 0, 0, "$", true);',
  C: 'var t = Number(this.getField("tax").value) || 0; event.value = Number(this.getField("qty").value) * Number(this.getField("price").value) * (1 + t);',
});
doc.getForm().acroForm.dict.set(PDFName.of('CO'), doc.context.obj([total.acroField.ref]));
form.getTextField('tax').setText('0.08');

label('Shipping', 50, 430);
const ship = form.createRadioGroup('shipping');
ship.addOptionToPage('standard', page, { x: 50, y: 404, width: 14, height: 14, borderWidth: 1 });
label('Standard', 70, 407);
ship.addOptionToPage('express', page, { x: 140, y: 404, width: 14, height: 14, borderWidth: 1 });
label('Express', 160, 407);
const gift = form.createCheckBox('gift');
gift.addToPage(page, { x: 250, y: 404, width: 14, height: 14, borderWidth: 1 });
label('Gift wrap', 270, 407);

label('Country', 50, 370);
const country = form.createDropdown('country');
country.addOptions(['Canada', 'India', 'Japan', 'United Kingdom', 'United States']);
country.addToPage(page, { x: 50, y: 344, width: 160, height: 20, font, borderWidth: 1 });
label('Interests (multi-select)', 250, 370);
const tags = form.createOptionList('interests');
tags.addOptions(['Books', 'Music', 'Travel', 'Sports']);
tags.enableMultiselect();
tags.addToPage(page, { x: 250, y: 300, width: 140, height: 64, font, borderWidth: 1 });

label('Comments', 50, 270);
const notes = form.createTextField('comments');
notes.enableMultiline();
notes.addToPage(page, { x: 50, y: 190, width: 340, height: 74, font, borderWidth: 1 });

page.drawText('Sign here:', { x: 50, y: 150, size: 10, font });
page.drawLine({ start: { x: 50, y: 110 }, end: { x: 300, y: 110 }, thickness: 0.8 });

await mkdir(new URL('../../../corpus/', import.meta.url), { recursive: true });
const bytes = await doc.save();
await writeFile(new URL('../../../corpus/form-sample.pdf', import.meta.url), bytes);
await writeFile(new URL('../../../apps/web/public/form.pdf', import.meta.url), bytes);
console.log('wrote corpus/form-sample.pdf and apps/web/public/form.pdf', bytes.length, 'bytes');
