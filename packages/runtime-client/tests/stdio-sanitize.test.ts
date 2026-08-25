/**
 * Security Repair 05B §E: runtime stderr sanitization.
 * A child process writes secret-shaped material to stderr and exits
 * nonzero; every stderr surface (error message, tail text, crash record)
 * must be scrubbed while benign ids survive.
 */

import { describe, expect, it } from "vitest";
import { StdioRuntimeTransport } from "../src/stdio.js";

// Passed as one argv element to `node -e` — no outer shell quotes. The
// GitHub-token literal is split so the repository secret-scanner never
// trips on a contiguous real-looking token in a test fixture.
const CHILD = "console.error('db=postgresql://user:pw@db.internal/app'); console.error('token: ' + 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'); console.error('password=hunter2'); console.error('Bearer abc123.def456.ghi789'); console.error('worker=compute-1234ab node=11111111-1111-4111-8111-00000000abcd'); process.exit(3)";

describe("stdio transport sanitization (05B §E)", () => {
  it("scrubs secret-shaped stderr before it reaches errors and diagnostics", async () => {
    const transport = new StdioRuntimeTransport(process.execPath, ["-e", CHILD]);
    const error = await transport.onClosed();
    expect(error).toBeDefined();
    const message = error!.message;
    expect(message).not.toContain("postgresql://");
    expect(message).not.toContain("ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("Bearer abc123");

    const tail = transport.stderrTailText();
    expect(tail).not.toContain("postgresql://");
    expect(tail).not.toContain("hunter2");
    expect(tail).not.toContain("ghp_");
    // Benign ids are not corrupted.
    expect(tail).toContain("compute-1234ab");
    expect(tail).toContain("11111111-1111-4111-8111-00000000abcd");

    const crash = transport.crashDiagnostic("corr-1");
    expect(crash.component).toBe("stdio-runtime");
    expect(crash.exitCode).toBe(3);
    expect(crash.correlationId).toBe("corr-1");
    expect(crash.diagnostic).not.toContain("hunter2");
    expect(crash.rawDiagnosticSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
