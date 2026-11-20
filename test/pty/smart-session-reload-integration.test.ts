import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");

setDefaultTimeout(30_000);
afterEach(() => harness.cleanup());

/** Reserve one private daemon port so this test cannot contact a developer's sessions. */
async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!port) throw new Error("Failed to reserve the Smart reload daemon port.");
  return port;
}

/** Wait for one concrete daemon or registration fact with a bounded polling deadline. */
async function waitUntil<T>(label: string, read: () => T | null | Promise<T | null>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Run the real session CLI with exactly the environment shared by this test's window. */
function runSessionCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawnSync([process.execPath, sourceEntrypoint, "session", ...args], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: Buffer.from(child.stdout).toString("utf8"),
    stderr: Buffer.from(child.stderr).toString("utf8"),
  };
}

describe("PTY Smart session reload", () => {
  test("the agent CLI preserves Smart layout across reloads through HTTP and the broker", async () => {
    const dir = harness.createIsolatedConfigHome();
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    writeFileSync(before, "export const beforeValue = 1;\n");
    writeFileSync(after, "export const initialValue = 2;\n");
    const port = await reserveLoopbackPort();
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: harness.createIsolatedConfigHome(),
      XDG_RUNTIME_DIR: harness.createIsolatedConfigHome(),
      HUNK_MCP_HOST: "127.0.0.1",
      HUNK_MCP_PORT: String(port),
      HUNK_MCP_DISABLE: "0",
      HUNK_INTERNAL_SESSION_DAEMON_VERSION: undefined,
    };
    const daemon = Bun.spawn([process.execPath, sourceEntrypoint, "daemon", "serve"], {
      cwd: repoRoot,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    let session: Awaited<ReturnType<typeof harness.launchHunk>> | undefined;

    try {
      await waitUntil("the private session daemon", async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).ok ? true : null;
        } catch {
          return null;
        }
      });
      session = await harness.launchHunk({
        args: ["diff", "--files", before, after, "--mode", "smart", "--no-sidebar"],
        cwd: dir,
        cols: 90,
        rows: 20,
        env,
      });
      await harness.waitForSnapshot(session, (frame) => frame.includes("initialValue"));
      const sessionId = await waitUntil("the registered Smart reload window", () => {
        const listed = runSessionCli(["list", "--json"], env);
        if (listed.exitCode !== 0) return null;
        const parsed = JSON.parse(listed.stdout) as { sessions: Array<{ sessionId: string }> };
        return parsed.sessions[0]?.sessionId ?? null;
      });

      const reload = () => {
        const result = runSessionCli(
          [
            "reload",
            sessionId,
            "--json",
            "--",
            "diff",
            "--files",
            before,
            after,
            "--mode",
            "smart",
          ],
          env,
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          result: { sessionId, inputKind: "diff", fileCount: 1, selectedFilePath: "after.ts" },
        });
      };

      writeFileSync(after, "export const beforeValue = 1;\nexport const SMART_ADDED = true;\n");
      reload();
      const oneSided = await harness.waitForSnapshot(session, (frame) =>
        frame.includes("SMART_ADDED"),
      );
      const addedRow = oneSided.split("\n").find((line) => line.includes("SMART_ADDED"));
      expect(addedRow).not.toMatch(/▌.*▌/);
      expect(oneSided).not.toContain("initialValue");

      writeFileSync(after, "export const SMART_REPLACED = 3;\n");
      reload();
      const mixed = await harness.waitForSnapshot(session, (frame) =>
        frame.includes("SMART_REPLACED"),
      );
      const mixedRow = mixed.split("\n").find((line) => line.includes("SMART_REPLACED"));
      expect(mixedRow).toMatch(/▌.*▌/);
      expect(mixedRow).toContain("beforeValue");
    } finally {
      session?.close();
      if (daemon.exitCode === null) daemon.kill();
      await daemon.exited;
    }
  });
});
