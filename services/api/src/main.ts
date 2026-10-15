import { buildServer, configFromEnv } from './server';

const config = configFromEnv();
const app = buildServer(config);
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

if (!config.apiKeys?.length && host !== '127.0.0.1' && host !== 'localhost') {
  console.error('Refusing to listen on a public interface without API_KEYS set.');
  process.exit(1);
}

app.listen({ port, host }).then(
  () => {
    console.log(`PDF Suite API on http://${host}:${port}`);
    console.log(`  Office conversion: ${config.tools.soffice ?? 'unavailable (set SOFFICE_PATH)'}`);
    console.log(`  HTML conversion:   ${config.tools.browser ?? 'unavailable (set CHROME_PATH)'}`);
    if (!config.apiKeys?.length) console.log('  WARNING: no API_KEYS configured; requests are not authenticated');
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
