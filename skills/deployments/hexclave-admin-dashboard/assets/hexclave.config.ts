import type { HexclaveConfig } from "@hexclave/js";

export const config: HexclaveConfig = {
  apps: {
    installed: {
      authentication: { enabled: true },
      emails: { enabled: true },
      rbac: { enabled: true },
      deploy: { enabled: true },
    },
  },

  auth: { allowSignUp: false, otp: { allowSignIn: true } },

  rbac: {
    permissions: {
      admin_dashboard: {
        description: "Use the admin dashboard",
        scope: "project",
      },
    },
  },
};
