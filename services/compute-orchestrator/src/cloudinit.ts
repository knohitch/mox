/**
 * Cloud-init user-data builder for Mox-provisioned servers (Prompt 09).
 *
 * Installs Mox Node via cloud-init. Enrollment uses a one-time token that is
 * exchanged over HTTPS; no long-lived secret is baked into user-data.
 * Root credentials are never embedded here or logged anywhere.
 *
 * Prompt 00 §F: the control-plane URL is validated deployment configuration
 * passed in by the orchestrator — never a hard-coded default.
 */

export interface MoxNodeCloudInitInput {
  /** Resolved, validated control-plane endpoint (https in production). */
  controlPlaneUrl: string;
  /** One-time enrollment token; short-lived, single use. */
  enrollToken: string;
  orgId: string;
  orderId: string;
  /** Server-issued node identity; customer VPS must not choose this. */
  nodeId: string;
  /** Extra packages/config kept minimal on purpose. */
  extraPackages?: string[];
}

export function buildMoxNodeCloudInit(input: MoxNodeCloudInitInput): string {
  const packages = ["docker.io", "ca-certificates", "curl", ...(input.extraPackages ?? [])];
  return [
    "#cloud-config",
    "package_update: true",
    "packages:",
    ...packages.map((p) => `  - ${p}`),
    "write_files:",
    "  - path: /etc/mox-node/enroll.env",
    "    permissions: '0600'",
    "    owner: root:root",
    "    content: |",
    `      MOX_CONTROL_PLANE_URL=${input.controlPlaneUrl}`,
    `      MOX_ENROLL_TOKEN=${input.enrollToken}`,
    `      MOX_ORG_ID=${input.orgId}`,
    `      MOX_ORDER_ID=${input.orderId}`,
    `      MOX_NODE_ID=${input.nodeId}`,
    "runcmd:",
    "  - systemctl enable --now docker",
    `  - curl -fsSL ${input.controlPlaneUrl}/node/install.sh | bash -s -- /etc/mox-node/enroll.env`,
    "  - systemctl enable --now mox-node",
    "",
  ].join("\n");
}
