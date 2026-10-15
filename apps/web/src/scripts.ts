import { createQuickJsRunner, type ScriptRunner } from '@pdfsuite/forms';
import quickjsWasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';

let runner: Promise<ScriptRunner> | null = null;

/** Sandboxed (QuickJS/WebAssembly) runner for form JavaScript; created on first use. */
export function getScriptRunner(): Promise<ScriptRunner> {
  runner ??= createQuickJsRunner({ wasmUrl: quickjsWasmUrl });
  return runner;
}
