import {
  RELEASE_SYNC,
  getQuickJS,
  newQuickJSWASMModule,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { PRELUDE } from './prelude';

export type EventName = 'Keystroke' | 'Format' | 'Validate' | 'Calculate';

export interface ScriptField {
  value: string | number | boolean | string[];
  readonly: boolean;
  required: boolean;
  type: string;
}

export interface ScriptContext {
  fields: Record<string, ScriptField>;
  /** Fully qualified name of the field the script belongs to. */
  thisField: string;
  event: { name: EventName; value: string; change?: string; willCommit?: boolean };
  documentScripts?: string[];
}

export interface ScriptResult {
  /** Fields the script assigned (name -> new value). */
  patch: Record<string, unknown>;
  /** Final `event.value`. */
  value: string;
  /** `event.rc`: false means the script rejected the value. */
  rc: boolean;
  alerts: string[];
  error: string | null;
}

export interface ScriptRunner {
  run(script: string, ctx: ScriptContext): ScriptResult;
}

export interface QuickJsRunnerOptions {
  /** Pre-built QuickJS module. */
  module?: QuickJSWASMModule;
  /** URL of quickjs.wasm for bundlers (e.g. Vite `import url from '@jitl/quickjs-wasmfile-release-sync/wasm?url'`). */
  wasmUrl?: string;
  /** Wall-clock budget per script in ms. */
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

/**
 * Runs untrusted PDF scripts in a fresh QuickJS (WebAssembly) context per call: no DOM, network or file
 * access, a CPU deadline and a memory cap. Scripts can only read the field snapshot passed in and
 * report assignments back as a patch.
 */
export async function createQuickJsRunner(opts: QuickJsRunnerOptions = {}): Promise<ScriptRunner> {
  const QuickJS =
    opts.module ??
    (opts.wasmUrl ? await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmLocation: opts.wasmUrl })) : await getQuickJS());
  const timeoutMs = opts.timeoutMs ?? 400;
  const memoryLimitBytes = opts.memoryLimitBytes ?? 32 * 1024 * 1024;

  return {
    run(script, ctx) {
      const input = { ...ctx, script, documentScripts: ctx.documentScripts ?? [] };
      const code = `var __input = ${JSON.stringify(input)};\n${PRELUDE}`;
      try {
        const out = QuickJS.evalCode(code, {
          shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + timeoutMs),
          memoryLimitBytes,
        });
        return JSON.parse(String(out)) as ScriptResult;
      } catch (e) {
        const message = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);
        return { patch: {}, value: ctx.event.value, rc: true, alerts: [], error: message };
      }
    },
  };
}

export { newQuickJSWASMModule };
