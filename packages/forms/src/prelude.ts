/**
 * JavaScript run inside QuickJS before every field script: a small, dependency-free subset of the
 * Acrobat form API (`event`, `this.getField`, `app.alert`, `util`, and the AF* format/validate helpers).
 * There is no host access at all (no DOM, network or files): inputs arrive as one JSON literal and
 * outputs leave as one JSON string. Kept as plain ES2015 without template literals so it can live in a TS string.
 */
export const PRELUDE = String.raw`
var __fields = __input.fields;
var __patch = {};
var __alerts = [];
var __MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var __DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

var app = {
  alert: function (msg) { __alerts.push(String(msg)); return 1; },
  beep: function () {},
  response: function () { return null; },
  viewerType: 'Reader', viewerVersion: 20, platform: 'WIN', language: 'ENU'
};
var color = {
  transparent: ['T'], black: ['G', 0], white: ['G', 1], red: ['RGB', 1, 0, 0], green: ['RGB', 0, 1, 0],
  blue: ['RGB', 0, 0, 1], yellow: ['RGB', 1, 1, 0], cyan: ['RGB', 0, 1, 1], magenta: ['RGB', 1, 0, 1],
  ltGray: ['G', 0.75], gray: ['G', 0.5], dkGray: ['G', 0.25]
};

function __Field(name) { this.name = name; }
__Field.prototype = {
  get value() { return __fields[this.name].value; },
  set value(v) { __fields[this.name].value = v; __patch[this.name] = v; },
  get valueAsString() { var v = __fields[this.name].value; return v === null || v === undefined ? '' : String(v); },
  get readonly() { return !!__fields[this.name].readonly; },
  set readonly(v) {},
  get required() { return !!__fields[this.name].required; },
  set required(v) {},
  get type() { return __fields[this.name].type; },
  get doc() { return globalThis; },
  get fillColor() { return color.transparent; }, set fillColor(v) {},
  get textColor() { return color.black; }, set textColor(v) {},
  get strokeColor() { return color.black; }, set strokeColor(v) {},
  get borderStyle() { return 'solid'; }, set borderStyle(v) {},
  get display() { return 0; }, set display(v) {},
  get hidden() { return false; }, set hidden(v) {},
  get userName() { return this.name; }, set userName(v) {},
  setFocus: function () {},
  setAction: function () {},
  isBoxChecked: function () { return !!__fields[this.name].value && __fields[this.name].value !== 'Off'; },
  checkThisBox: function (i, b) { this.value = b ? true : false; }
};

globalThis.getField = function (name) {
  return Object.prototype.hasOwnProperty.call(__fields, name) ? new __Field(name) : null;
};
globalThis.getNthFieldName = function (i) { return Object.keys(__fields)[i]; };
globalThis.resetForm = function () {};
globalThis.calculate = true;
Object.defineProperty(globalThis, 'numFields', { get: function () { return Object.keys(__fields).length; } });

var event = {
  name: __input.event.name,
  type: 'Field',
  value: __input.event.value,
  change: __input.event.change || '',
  changeEx: '',
  willCommit: !!__input.event.willCommit,
  rc: true,
  selStart: 0, selEnd: 0, fieldFull: false, shift: false, modifier: false,
  target: getField(__input.thisField)
};

/* ---------- number helpers ---------- */
function __parseNum(v, sepStyle) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  var s = String(v).replace(/[\s$€£¥%]/g, '');
  if (s === '') return NaN;
  if ((sepStyle === 2 || sepStyle === 3) && s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.'); /* a bare '.' is the machine form written by calculations */
  else if (sepStyle === 4) s = s.replace(/'/g, '');
  else s = s.replace(/,/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}
function __clean(n) { return Number(n.toFixed(12)); }
function AFMakeNumber(s) { var n = __parseNum(s, 0); return isNaN(n) ? null : n; }

function __formatNumber(n, nDec, sepStyle, negStyle, strCurrency, bCurrencyPrepend) {
  var neg = n < 0; n = Math.abs(n);
  var parts = n.toFixed(nDec).split('.');
  var int = parts[0]; var dec = parts[1] || '';
  var thou = sepStyle === 0 ? ',' : sepStyle === 2 ? '.' : sepStyle === 4 ? "'" : '';
  var decSep = (sepStyle === 2 || sepStyle === 3) ? ',' : '.';
  if (thou) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, thou);
  var out = int + (nDec > 0 ? decSep + dec : '');
  if (strCurrency) out = bCurrencyPrepend ? strCurrency + out : out + ' ' + strCurrency;
  if (neg) out = (negStyle === 2 || negStyle === 3) ? '(' + out + ')' : '-' + out;
  return out;
}
function __reject(msg) { event.rc = false; app.alert(msg); }
function __badValue() { __reject('The value entered does not match the format of the field [ ' + (event.target ? event.target.name : '') + ' ]'); }

function AFNumber_Format(nDec, sepStyle, negStyle, currStyle, strCurrency, bCurrencyPrepend) {
  var n = __parseNum(event.value, sepStyle);
  if (isNaN(n)) { event.value = ''; return; }
  event.value = __formatNumber(n, nDec, sepStyle, negStyle, strCurrency, bCurrencyPrepend);
}
function AFNumber_Keystroke(nDec, sepStyle) {
  if (!event.willCommit || event.value === '' || event.value === null) return;
  if (isNaN(__parseNum(event.value, sepStyle))) __badValue();
}
function AFPercent_Format(nDec, sepStyle) {
  var n = __parseNum(event.value, sepStyle);
  if (isNaN(n)) { event.value = ''; return; }
  event.value = __formatNumber(__clean(n * 100), nDec, sepStyle, 0, '', false) + '%';
}
function AFPercent_Keystroke(nDec, sepStyle) { AFNumber_Keystroke(nDec, sepStyle); }

function AFSimple_Calculate(fn, fields) {
  var names = typeof fields === 'string' ? fields.split(/\s*,\s*/) : fields;
  var nums = [];
  var keys = Object.keys(__fields);
  for (var i = 0; i < names.length; i++) {
    var want = names[i];
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === want || keys[k].indexOf(want + '.') === 0) {
        var n = __parseNum(__fields[keys[k]].value, 0);
        if (!isNaN(n)) nums.push(n);
      }
    }
  }
  var r = 0;
  switch (fn) {
    case 'SUM': r = nums.reduce(function (a, b) { return a + b; }, 0); break;
    case 'AVG': r = nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : 0; break;
    case 'PRD': r = nums.length ? nums.reduce(function (a, b) { return a * b; }, 1) : 0; break;
    case 'MIN': r = nums.length ? Math.min.apply(null, nums) : 0; break;
    case 'MAX': r = nums.length ? Math.max.apply(null, nums) : 0; break;
  }
  event.value = __clean(r);
}

function AFRange_Validate(bGreater, nGreater, bLess, nLess) {
  if (event.value === '' || event.value === null) return;
  var n = __parseNum(event.value, 0);
  if (isNaN(n)) { __badValue(); return; }
  var low = bGreater && n < nGreater;
  var high = bLess && n > nLess;
  if (!low && !high) return;
  var msg = 'Invalid value: must be ';
  if (bGreater && bLess) msg += 'greater than or equal to ' + nGreater + ' and less than or equal to ' + nLess;
  else if (bGreater) msg += 'greater than or equal to ' + nGreater;
  else msg += 'less than or equal to ' + nLess;
  __reject(msg + '.');
}
function AFMergeChange(e) {
  if (e.willCommit) return e.value;
  return e.value.substring(0, e.selStart) + e.change + e.value.substring(e.selEnd);
}

/* ---------- dates ---------- */
var __DATE_FORMATS = ['m/d','m/d/yy','mm/dd/yy','mm/yy','d-mmm','d-mmm-yy','dd-mmm-yy','yy-mm-dd','mmm-yy','mmmm-yy','mmm d, yyyy','mmmm d, yyyy','m/d/yy h:MM tt','m/d/yy HH:MM'];
var __TIME_FORMATS = ['HH:MM','h:MM tt','HH:MM:ss','h:MM:ss tt'];
var __TOKEN = /yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|HH|H|hh|h|MM|M|ss|s|tt|t/g;
function __p2(n) { return n < 10 ? '0' + n : String(n); }
function __fmtDate(d, fmt) {
  return fmt.replace(__TOKEN, function (t) {
    switch (t) {
      case 'yyyy': return String(d.getFullYear());
      case 'yy': return __p2(d.getFullYear() % 100);
      case 'mmmm': return __MONTHS[d.getMonth()];
      case 'mmm': return __MONTHS[d.getMonth()].substring(0, 3);
      case 'mm': return __p2(d.getMonth() + 1);
      case 'm': return String(d.getMonth() + 1);
      case 'dddd': return __DAYS[d.getDay()];
      case 'ddd': return __DAYS[d.getDay()].substring(0, 3);
      case 'dd': return __p2(d.getDate());
      case 'd': return String(d.getDate());
      case 'HH': return __p2(d.getHours());
      case 'H': return String(d.getHours());
      case 'hh': return __p2(d.getHours() % 12 || 12);
      case 'h': return String(d.getHours() % 12 || 12);
      case 'MM': return __p2(d.getMinutes());
      case 'M': return String(d.getMinutes());
      case 'ss': return __p2(d.getSeconds());
      case 's': return String(d.getSeconds());
      case 'tt': return d.getHours() < 12 ? 'am' : 'pm';
      case 't': return d.getHours() < 12 ? 'a' : 'p';
    }
    return t;
  });
}
function __parseDate(str, fmt) {
  str = String(str).trim();
  var order = [];
  var src = '^' + fmt.replace(/[.*+?^$()|[\]\\\/{}-]/g, '\\$&').replace(__TOKEN, function (t) {
    order.push(t);
    if (t === 'yyyy') return '(\\d{4})';
    if (t === 'mmmm') return '([A-Za-z]+)';
    if (t === 'mmm') return '([A-Za-z]{3})';
    if (t === 'tt') return '([AaPp][Mm])';
    return '(\\d{1,2})';
  }) + '$';
  var m = new RegExp(src).exec(str);
  var y = null, mo = 0, da = 1, h = 0, mi = 0, s = 0, pm = null;
  if (m) {
    for (var i = 0; i < order.length; i++) {
      var t = order[i], v = m[i + 1];
      if (t === 'yyyy') y = Number(v);
      else if (t === 'yy') y = Number(v) < 50 ? 2000 + Number(v) : 1900 + Number(v);
      else if (t === 'mmmm' || t === 'mmm') {
        mo = -1;
        for (var k = 0; k < 12; k++) if (__MONTHS[k].toLowerCase().indexOf(v.toLowerCase()) === 0) { mo = k; break; }
        if (mo < 0) return null;
      }
      else if (t === 'mm' || t === 'm') mo = Number(v) - 1;
      else if (t === 'dd' || t === 'd') da = Number(v);
      else if (t === 'HH' || t === 'H' || t === 'hh' || t === 'h') h = Number(v);
      else if (t === 'MM' || t === 'M') mi = Number(v);
      else if (t === 'ss' || t === 's') s = Number(v);
      else if (t === 'tt') pm = v.toLowerCase() === 'pm';
    }
    if (pm !== null) h = (h % 12) + (pm ? 12 : 0);
    if (y === null) y = new Date().getFullYear();
    var d = new Date(y, mo, da, h, mi, s);
    if (d.getFullYear() === y && d.getMonth() === mo && d.getDate() === da) return d;
    return null;
  }
  var fb = new Date(str);
  return isNaN(fb.getTime()) ? null : fb;
}
function AFDate_FormatEx(fmt) {
  if (event.value === '' || event.value === null) { event.value = ''; return; }
  var d = __parseDate(event.value, fmt);
  event.value = d ? __fmtDate(d, fmt) : '';
}
function AFDate_KeystrokeEx(fmt) {
  if (!event.willCommit || event.value === '' || event.value === null) return;
  if (!__parseDate(event.value, fmt)) __reject('Invalid date/time: please ensure that the date/time exists. Field [ ' + (event.target ? event.target.name : '') + ' ] should match format ' + fmt);
}
function AFDate_Format(i) { AFDate_FormatEx(__DATE_FORMATS[i]); }
function AFDate_Keystroke(i) { AFDate_KeystrokeEx(__DATE_FORMATS[i]); }
function AFTime_FormatEx(fmt) { AFDate_FormatEx(fmt); }
function AFTime_Format(i) { AFDate_FormatEx(__TIME_FORMATS[i]); }
function AFTime_KeystrokeEx(fmt) { AFDate_KeystrokeEx(fmt); }
function AFTime_Keystroke(i) { AFDate_KeystrokeEx(__TIME_FORMATS[i]); }

/* ---------- special formats ---------- */
function AFSpecial_Format(psf) {
  var d = String(event.value === null ? '' : event.value).replace(/\D/g, '');
  if (!d) { event.value = ''; return; }
  if (psf === 0) event.value = d.substring(0, 5);
  else if (psf === 1) event.value = d.length > 5 ? d.substring(0, 5) + '-' + d.substring(5, 9) : d;
  else if (psf === 2) event.value = d.length >= 10 ? '(' + d.substring(0, 3) + ') ' + d.substring(3, 6) + '-' + d.substring(6, 10) : (d.length > 3 ? d.substring(0, 3) + '-' + d.substring(3) : d);
  else if (psf === 3) event.value = d.length > 5 ? d.substring(0, 3) + '-' + d.substring(3, 5) + '-' + d.substring(5, 9) : d;
}
function AFSpecial_Keystroke(psf) {
  if (!event.willCommit || event.value === '' || event.value === null) return;
  var d = String(event.value).replace(/\D/g, '');
  var ok = psf === 0 ? d.length === 5 : psf === 1 ? d.length === 9 : psf === 2 ? (d.length === 10 || d.length === 7) : d.length === 9;
  if (!ok) __badValue();
}

/* ---------- util ---------- */
var util = {
  printd: function (fmt, d) { return __fmtDate(d, fmt); },
  scand: function (fmt, s) { return __parseDate(s, fmt); },
  printf: function (fmt) {
    var args = Array.prototype.slice.call(arguments, 1);
    var ai = 0;
    return String(fmt).replace(/%(,\d)?\+?(0?)(\d*)(?:\.(\d+))?([sdfx%])/g, function (m, sep, zero, width, prec, conv) {
      if (conv === '%') return '%';
      var v = args[ai++];
      var out;
      if (conv === 's') out = String(v);
      else if (conv === 'd') out = String(Math.round(Number(v)));
      else if (conv === 'x') out = Math.round(Number(v)).toString(16);
      else {
        var n = Number(v);
        out = n.toFixed(prec === undefined ? 6 : Number(prec));
        if (sep === ',0' || (sep && sep !== ',1')) out = out.replace(/\B(?=(\d{3})+(?!\d))(?<!\.\d*)/g, ',');
      }
      if (width) { var w = Number(width); while (out.length < w) out = (zero ? '0' : ' ') + out; }
      return out;
    });
  },
  stringToDate: function (s) { return __parseDate(s, 'yyyy-mm-dd'); }
};

/* ---------- document-level scripts, then the field script ---------- */
for (var __i = 0; __i < __input.documentScripts.length; __i++) {
  try { (0, eval)(__input.documentScripts[__i]); } catch (e) {}
}
var __error = null;
try {
  var __fn = new Function(__input.script);
  __fn.call(globalThis);
} catch (e) {
  __error = String(e && e.message ? e.message : e);
}
JSON.stringify({
  patch: __patch,
  value: event.value === null || event.value === undefined ? '' : String(event.value),
  rc: event.rc !== false,
  alerts: __alerts,
  error: __error
});
`;
