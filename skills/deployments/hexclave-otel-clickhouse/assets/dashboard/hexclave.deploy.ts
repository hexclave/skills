// A private dashboard as its own deployment group, next to the observability group in the same
// project. It reads ClickHouse over the private network as the read-only `reader` user.
//
// References (service(...).hostname(), secret(...), hexclave.*) must be the WHOLE env value: the
// CLI refuses them inside a template string, so pass the bare hostname and build URLs in code.
export const deploymentGroupId = "dashboard";

export const deploy = ({ secret, service, hexclave }: any) => ({
  services: {
    dashboard: {
      type: "serverless",
      public: true,
      ports: { 3000: { protocol: "http" } },
      dockerfilePath: "Dockerfile",
      // One instance: the query gate and cache in clickhouse.ts are per process.
      minInstances: 1,
      maxInstances: 1,
      env: {
        HEXCLAVE_PROJECT_ID: hexclave.projectId,
        HEXCLAVE_SECRET_SERVER_KEY: hexclave.secretServerKey,
        CLICKHOUSE_HOST: service("clickhouse").hostname(),
        CLICKHOUSE_USER: "reader",
        CLICKHOUSE_PASSWORD: secret("CLICKHOUSE_READER_PASSWORD"),
        DASHBOARD_ALLOWED_EMAILS: secret("DASHBOARD_ALLOWED_EMAILS"),
      },
    },
  },
});
