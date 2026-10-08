// OpenTelemetry for a Node service deployed on Hexclave (or Hexclave's own backend).
// Load it before anything else:  node --import ./otel-node.js server.js   (ESM)
// (CJS apps: delete the register() call and load with --require instead.)
//
// npm i @opentelemetry/api@1.9.1 @opentelemetry/api-logs@0.223.0 @opentelemetry/sdk-node@0.223.0 \
//   @opentelemetry/auto-instrumentations-node@0.81.0 @opentelemetry/exporter-trace-otlp-proto@0.223.0 \
//   @opentelemetry/exporter-logs-otlp-proto@0.223.0 @opentelemetry/exporter-metrics-otlp-proto@0.223.0 \
//   @opentelemetry/sdk-metrics@2.12.0 @opentelemetry/sdk-logs@0.223.0 @opentelemetry/resources@2.12.0 \
//   @opentelemetry/instrumentation@0.223.0   (direct dep so the hook path resolves under pnpm)
//
// Env (the OTLP exporters read these themselves; nothing is hard-coded):
//   OTEL_EXPORTER_OTLP_ENDPOINT=https://<otel-gateway url>.deploy.built-with-hexclave.com      (base URL; /v1/traces etc. are appended)
//   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<token>      (value is URL-encoded: space = %20)
//   OTEL_SERVICE_NAME=my-service
//   OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,hexclave.project_id=<id>
import { register } from "node:module";
// ESM apps: without this loader hook, node:http/express/pg etc. are NOT patched (only fetch/undici,
// which uses diagnostics_channel, still produces spans). Verified with NodeSDK 0.223.0 on Node 20.
// Must run before the instrumented modules are imported, hence --import ./otel-node.js.
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

import { metrics } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK({
  // Exporters pick up endpoint + headers from OTEL_EXPORTER_OTLP_* env vars.
  traceExporter: new OTLPTraceExporter(),
  metricReaders: [
    new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 }),
  ],
  // sdk-logs >= 0.2xx takes an options object ({ exporter }), not a bare exporter.
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs spans are noisy and expensive at volume.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();
void metrics; // the global MeterProvider is registered by sdk.start(); use metrics.getMeter() in app code

// Flush on SIGTERM (sent before a machine stops) so the last batch is not lost.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    sdk.shutdown().catch((err) => console.error("otel shutdown failed", err)).finally(() => process.exit(0));
  });
}
