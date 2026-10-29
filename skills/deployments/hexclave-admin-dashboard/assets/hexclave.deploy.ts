import type { HexclaveDeploymentConfig } from "@hexclave/js";

export const deploymentGroupId = "app";

export const deploy: HexclaveDeploymentConfig = ({ isDev, secret, service, hexclave }) => ({
  services: {
    backend: {
      type: "server",
      public: false,
      ports: { 3000: { protocol: "http" } },
      memory: "2GB",
      minInstances: 1,
      rootDirectory: ".",
      dockerfilePath: "infra/docker/backend.Dockerfile",
      env: {
        DASHBOARD_API_TOKEN: isDev ? null : secret("DASHBOARD_API_TOKEN"),
      },
    },
    dashboard: {
      type: "serverless",
      public: true,
      ports: { 8080: { protocol: "http" } },
      memory: "1GB",
      minInstances: 0,
      maxInstances: 1,
      rootDirectory: ".",
      dockerfilePath: "infra/docker/dashboard.Dockerfile",
      env: {
        PORT: "8080",
        DASHBOARD_PERMISSION: "admin_dashboard",
        DASHBOARD_BACKEND_URL: isDev ? null : service("backend").url(3000),
        DASHBOARD_BACKEND_TOKEN: isDev ? null : secret("DASHBOARD_API_TOKEN"),
        HEXCLAVE_PROJECT_ID: hexclave.projectId,
        HEXCLAVE_API_URL: hexclave.apiUrl,
        HEXCLAVE_SECRET_SERVER_KEY: hexclave.secretServerKey,
      },
    },
  },
});
