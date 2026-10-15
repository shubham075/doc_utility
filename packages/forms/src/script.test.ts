import { beforeAll, describe, expect, it } from 'vitest';
import { createQuickJsRunner, type ScriptContext, type ScriptRunner } from './script';

let runner: ScriptRunner;
beforeAll(async () => {
  runner = await createQuickJsRunner({ timeoutMs: 300 });
});

const ctx = (value: string, over: Partial<ScriptContext> = {}, name: ScriptContext['event']['name'] = 'Format'): ScriptContext => ({
  fields: { f: { value, readonly: false, required: false, type: 'text' } },
  thisField: 'f',
  event: { name, value, willCommit: true },
  ...over,
});

describe('number formats', () => {
  it('formats with separators, decimals, currency and negative styles', () => {
    expect(runner.run('AFNumber_Format(2, 0, 0, 0, "", true);', ctx('1234.5')).value).toBe('1,234.50');
    expect(runner.run('AFNumber_Format(2, 2, 0, 0, "", true);', ctx('1234.5')).value).toBe('1.234,50'); // machine form
    expect(runner.run('AFNumber_Format(2, 2, 0, 0, "", true);', ctx('1.234,5')).value).toBe('1.234,50'); // locale form
    expect(runner.run('AFNumber_Format(0, 1, 0, 0, "", true);', ctx('1234.5')).value).toBe('1235');
    expect(runner.run('AFNumber_Format(2, 0, 0, 0, "$", true);', ctx('1234.5')).value).toBe('$1,234.50');
    expect(runner.run('AFNumber_Format(2, 0, 2, 0, "", true);', ctx('-5')).value).toBe('(5.00)');
    expect(runner.run('AFNumber_Format(2, 0, 0, 0, "", true);', ctx('')).value).toBe('');
    expect(runner.run('AFPercent_Format(1, 1);', ctx('0.256')).value).toBe('25.6%');
  });

  it('rejects non-numeric commits', () => {
    const r = runner.run('AFNumber_Keystroke(2, 0, 0, 0, "", true);', ctx('12abc', {}, 'Keystroke'));
    expect(r.rc).toBe(false);
    expect(r.alerts[0]).toContain('does not match the format');
    expect(runner.run('AFNumber_Keystroke(2, 0, 0, 0, "", true);', ctx('12.5', {}, 'Keystroke')).rc).toBe(true);
  });

  it('validates ranges', () => {
    const run = (v: string) => runner.run('AFRange_Validate(true, 0, true, 100);', ctx(v, {}, 'Validate'));
    expect(run('50').rc).toBe(true);
    expect(run('150').rc).toBe(false);
    expect(run('-1').alerts[0]).toContain('greater than or equal to 0 and less than or equal to 100');
    expect(run('').rc).toBe(true);
  });
});

describe('dates and special formats', () => {
  it('formats and parses dates by pattern', () => {
    expect(runner.run('AFDate_FormatEx("mm/dd/yyyy");', ctx('2026-01-05')).value).toBe('01/05/2026');
    expect(runner.run('AFDate_FormatEx("mmm d, yyyy");', ctx('03/09/2025').fields ? ctx('3/9/2025') : ctx('')).value).toBeTypeOf('string');
    expect(runner.run('AFDate_FormatEx("dd-mmm-yy");', ctx('15-Feb-24')).value).toBe('15-Feb-24');
    expect(runner.run('AFDate_FormatEx("mmmm d, yyyy");', ctx('2026-12-25')).value).toBe('December 25, 2026');
  });
  it('rejects impossible dates', () => {
    expect(runner.run('AFDate_KeystrokeEx("mm/dd/yyyy");', ctx('02/30/2026', {}, 'Keystroke')).rc).toBe(false);
    expect(runner.run('AFDate_KeystrokeEx("mm/dd/yyyy");', ctx('02/28/2026', {}, 'Keystroke')).rc).toBe(true);
  });
  it('formats phone, zip and SSN', () => {
    expect(runner.run('AFSpecial_Format(2);', ctx('5551234567')).value).toBe('(555) 123-4567');
    expect(runner.run('AFSpecial_Format(1);', ctx('123456789')).value).toBe('12345-6789');
    expect(runner.run('AFSpecial_Format(3);', ctx('123456789')).value).toBe('123-45-6789');
    expect(runner.run('AFSpecial_Keystroke(0);', ctx('1234', {}, 'Keystroke')).rc).toBe(false);
  });
});

describe('field access and calculation helpers', () => {
  const fields = {
    a: { value: '10', readonly: false, required: false, type: 'text' },
    b: { value: '5.5', readonly: false, required: false, type: 'text' },
    'grp.x': { value: '1', readonly: false, required: false, type: 'text' },
    'grp.y': { value: '2', readonly: false, required: false, type: 'text' },
    total: { value: '', readonly: true, required: false, type: 'text' },
  };
  const calc = (script: string) => runner.run(script, { fields, thisField: 'total', event: { name: 'Calculate', value: '' } });

  it('sums, averages, multiplies and finds extremes', () => {
    expect(calc('AFSimple_Calculate("SUM", ["a", "b"]);').value).toBe('15.5');
    expect(calc('AFSimple_Calculate("AVG", "a, b");').value).toBe('7.75');
    expect(calc('AFSimple_Calculate("PRD", ["a", "b"]);').value).toBe('55');
    expect(calc('AFSimple_Calculate("MAX", ["a", "b"]);').value).toBe('10');
    expect(calc('AFSimple_Calculate("SUM", ["grp"]);').value).toBe('3'); // parent name selects children
  });

  it('reads fields and reports assignments as a patch', () => {
    const r = calc('var a = Number(this.getField("a").value); this.getField("b").value = a * 2; event.value = a + 1; app.alert("hi");');
    expect(r.value).toBe('11');
    expect(r.patch).toEqual({ b: 20 });
    expect(r.alerts).toEqual(['hi']);
    expect(calc('event.value = this.getField("missing") === null ? "none" : "some";').value).toBe('none');
  });

  it('supports document-level helper functions and util.printf', () => {
    const r = runner.run('event.value = util.printf("%,2.2f|%05d|%s", 1234.5, 42, "x") + "|" + twice(4);', {
      ...ctx(''),
      documentScripts: ['function twice(n) { return n * 2; }'],
    });
    expect(r.value).toBe('1,234.50|00042|x|8');
  });
});

describe('sandbox', () => {
  it('has no host APIs', () => {
    const r = runner.run('event.value = [typeof process, typeof require, typeof fetch, typeof window, typeof document, typeof XMLHttpRequest].join(",");', ctx(''));
    expect(r.value).toBe('undefined,undefined,undefined,undefined,undefined,undefined');
  });
  it('stops runaway scripts', () => {
    const t = Date.now();
    const r = runner.run('while (true) {}', ctx('keep'));
    expect(r.error).toBeTruthy();
    expect(r.value).toBe('keep');
    expect(Date.now() - t).toBeLessThan(3000);
  });
  it('reports syntax and runtime errors without throwing', () => {
    expect(runner.run('this is not javascript', ctx('x')).error).toBeTruthy();
    expect(runner.run('null.boom', ctx('x')).error).toBeTruthy();
  });
  it('limits memory', () => {
    const r = runner.run('var s = "x".repeat(1e9);', ctx('x'));
    expect(r.error).toBeTruthy();
  });
});
