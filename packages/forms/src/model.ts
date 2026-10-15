import type { Rect } from '@pdfsuite/annotations';

export type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'pushbutton' | 'signature';

/** text/dropdown: string · checkbox: boolean · radio: selected export value ('' = none) · list: selected values. */
export type FieldValue = string | boolean | string[];

export interface Widget {
  /** Zero-based page index. */
  page: number;
  /** Display-space rectangle (points, top-left origin, after page rotation). */
  rect: Rect;
  /** Checkbox "on" state / radio option export value. */
  exportValue?: string;
  /** Background (#rrggbb) and border colour from the appearance characteristics, if any. */
  background: string | null;
  borderColor: string | null;
  borderWidth: number;
  /** Object reference of the widget annotation ("12 0"), used to correlate with the file. */
  ref: string;
}

export interface ChoiceOption {
  value: string;
  label: string;
}

/** Acrobat JavaScript actions attached to a field (additional-actions dictionary). */
export interface FieldActions {
  keystroke?: string; // /K
  format?: string; // /F
  validate?: string; // /V
  calculate?: string; // /C
}

export interface FormField {
  /** Fully qualified name, e.g. "form.address.city". */
  name: string;
  type: FieldType;
  widgets: Widget[];
  value: FieldValue;
  defaultValue: FieldValue;
  options: ChoiceOption[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  password: boolean;
  comb: boolean;
  maxLength?: number;
  multiSelect: boolean;
  editable: boolean;
  /** Font size in points; 0 means "auto". */
  fontSize: number;
  textColor: string;
  /** 0 left, 1 centre, 2 right. */
  align: 0 | 1 | 2;
  tooltip?: string;
  actions: FieldActions;
}

export interface FormModel {
  fields: FormField[];
  /** Names of fields with calculate scripts in calculation order (/CO, then document order). */
  calculationOrder: string[];
  /** Document-level JavaScript sources (for helper functions used by field scripts). */
  documentScripts: string[];
  /** Widgets in tab order. */
  tabOrder: { field: string; widget: number }[];
}

export const isChecked = (v: FieldValue): boolean => v === true;

export function displayString(value: FieldValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'Off';
  return value;
}

export function emptyValue(type: FieldType): FieldValue {
  switch (type) {
    case 'checkbox':
      return false;
    case 'list':
      return [];
    default:
      return '';
  }
}
