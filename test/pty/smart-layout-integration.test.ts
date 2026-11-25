import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness, dragMouse } from "./harness";

const harness = createPtyHarness();
const copyMarker = "COPY_FROM_UNIFIED_RIGHT_HALF";
const additionLine = `export const added = '${"x".repeat(65)} ${copyMarker}';`;

/** Give startup, live resize, and note transitions room on slower PTY backends. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Build a private working tree with one-sided and replacement changes in review order. */
function createSmartLayoutRepoFixture(additionCount = 1) {
  const dir = harness.createIsolatedConfigHome();
  const beforeFiles = {
    "a-additions.ts": "export const kept = true;\n",
    "b-replacement.ts": "export const oldMixed = 1;\n",
    "c-deletions.ts": "export const deleted = 3;\n",
  };

  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    }
  };

  runGit(["init"]);
  runGit(["config", "user.name", "Hunk PTY Test"]);
  runGit(["config", "user.email", "hunk-pty@example.com"]);
  for (const [path, contents] of Object.entries(beforeFiles)) {
    writeFileSync(join(dir, path), contents);
  }
  runGit(["add", "."]);
  runGit(["commit", "-m", "smart layout fixture"]);

  const additions =
    additionCount === 1
      ? [additionLine]
      : Array.from(
          { length: additionCount },
          (_, index) => `export const added_${String(index + 1).padStart(2, "0")} = ${index + 1};`,
        );
  writeFileSync(
    join(dir, "a-additions.ts"),
    `${beforeFiles["a-additions.ts"]}${additions.join("\n")}\n`,
  );
  writeFileSync(join(dir, "b-replacement.ts"), "export const newMixed = 2;\n");
  writeFileSync(join(dir, "c-deletions.ts"), "");
  return { dir };
}

/** Return the visible code row so layout assertions cannot accidentally match other files. */
function codeRow(frame: string, needle: string) {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

/** Detect the second change rail that belongs to a concrete split code row. */
function isSplitCodeRow(frame: string, needle: string) {
  return /▌.*▌/.test(codeRow(frame, needle));
}

/** Wait for all three files to commit one complete visible review frame. */
function waitForMixedFrame(session: Parameters<typeof harness.waitForSnapshot>[0]) {
  return harness.waitForSnapshot(
    session,
    (frame) =>
      frame.includes("export const added") &&
      frame.includes("oldMixed") &&
      frame.includes("newMixed") &&
      frame.includes("export const deleted"),
    15_000,
  );
}

describe("PTY Smart layout", () => {
  test("one frame renders additions and deletions unified beside a split replacement file", async () => {
    const fixture = createSmartLayoutRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 160,
      rows: 28,
    });

    try {
      const frame = await waitForMixedFrame(session);
      expect(isSplitCodeRow(frame, "export const added")).toBe(false);
      expect(isSplitCodeRow(frame, "export const deleted")).toBe(false);
      expect(isSplitCodeRow(frame, "oldMixed")).toBe(true);
      expect(codeRow(frame, "oldMixed")).toContain("newMixed");
      expect(codeRow(frame, "export const added")).toContain(copyMarker);
    } finally {
      session.close();
    }
  });

  test("resizing Smart keeps replacement changes split even below Auto's width cutoff", async () => {
    const fixture = createSmartLayoutRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 160,
      rows: 28,
    });

    try {
      const wide = await waitForMixedFrame(session);
      const wideRailColumn = codeRow(wide, "oldMixed").lastIndexOf("▌");
      session.resize({ cols: 90, rows: 28 });
      const narrow = await harness.waitForSnapshot(
        session,
        (frame) =>
          isSplitCodeRow(frame, "oldMixed") &&
          codeRow(frame, "oldMixed").lastIndexOf("▌") < wideRailColumn &&
          frame.includes("export const deleted"),
        5_000,
      );
      expect(codeRow(narrow, "oldMixed")).toContain("newMixed");
      expect(isSplitCodeRow(narrow, "export const added")).toBe(false);
      expect(isSplitCodeRow(narrow, "export const deleted")).toBe(false);

      session.resize({ cols: 160, rows: 28 });
      const restored = await harness.waitForSnapshot(
        session,
        (frame) => codeRow(frame, "oldMixed").lastIndexOf("▌") === wideRailColumn,
        5_000,
      );
      expect(isSplitCodeRow(restored, "export const added")).toBe(false);
      expect(codeRow(restored, "export const added")).toContain(copyMarker);
    } finally {
      session.close();
    }
  });

  test("layout keys preserve explicit overrides and distinguish Auto from Smart on resize", async () => {
    const fixture = createSmartLayoutRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 160,
      rows: 28,
    });

    try {
      await waitForMixedFrame(session);
      const unified = await harness.pressAndWaitForSnapshot(
        session,
        "1",
        (frame) => frame.includes("oldMixed") && !isSplitCodeRow(frame, "oldMixed"),
      );
      expect(isSplitCodeRow(unified, "export const added")).toBe(false);

      const split = await harness.pressAndWaitForSnapshot(session, "2", (frame) =>
        isSplitCodeRow(frame, "export const added"),
      );
      expect(isSplitCodeRow(split, "oldMixed")).toBe(true);
      expect(isSplitCodeRow(split, "export const deleted")).toBe(true);

      await harness.pressAndWaitForSnapshot(
        session,
        "3",
        (frame) =>
          isSplitCodeRow(frame, "oldMixed") &&
          frame.includes("export const added") &&
          !isSplitCodeRow(frame, "export const added"),
      );
      await harness.pressAndWaitForSnapshot(session, "0", (frame) =>
        isSplitCodeRow(frame, "export const added"),
      );

      session.resize({ cols: 90, rows: 28 });
      const autoNarrow = await harness.waitForSnapshot(
        session,
        (frame) => frame.includes("oldMixed") && !isSplitCodeRow(frame, "oldMixed"),
      );
      expect(isSplitCodeRow(autoNarrow, "export const added")).toBe(false);
      const smartNarrow = await harness.pressAndWaitForSnapshot(session, "3", (frame) =>
        isSplitCodeRow(frame, "oldMixed"),
      );
      expect(isSplitCodeRow(smartNarrow, "export const added")).toBe(false);
      await harness.pressAndWaitForSnapshot(
        session,
        "1",
        (frame) => frame.includes("oldMixed") && !isSplitCodeRow(frame, "oldMixed"),
      );
      const explicitNarrowSplit = await harness.pressAndWaitForSnapshot(session, "2", (frame) =>
        isSplitCodeRow(frame, "export const added"),
      );
      expect(isSplitCodeRow(explicitNarrowSplit, "oldMixed")).toBe(true);
    } finally {
      session.close();
    }
  });

  test("hunk and sidebar navigation cross files with different Smart section heights", async () => {
    const fixture = createSmartLayoutRepoFixture(24);
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--sidebar"],
      cwd: fixture.dir,
      cols: 220,
      rows: 16,
    });

    try {
      await session.waitForText(/added_01/, { timeout: 15_000 });
      const replacement = await harness.pressAndWaitForSnapshot(
        session,
        "]",
        (frame) => isSplitCodeRow(frame, "oldMixed") && !frame.includes("added_01"),
      );
      expect(replacement).toContain("newMixed");
      const additions = await harness.pressAndWaitForSnapshot(
        session,
        "[",
        (frame) => frame.includes("added_01") && !frame.includes("oldMixed"),
      );
      expect(isSplitCodeRow(additions, "added_01")).toBe(false);

      const deletion = await harness.clickAndWaitForSnapshot(
        session,
        /c-deletions\.ts/,
        (frame) => frame.includes("▌  M c-deletions.ts") && frame.includes("export const deleted"),
      );
      expect(isSplitCodeRow(deletion, "export const deleted")).toBe(false);
      // Bottom clamping keeps neighboring code visible; the sidebar mark proves target ownership.
      const back = await harness.pressAndWaitForSnapshot(
        session,
        "[",
        (frame) => frame.includes("▌  M b-replacement.ts") && isSplitCodeRow(frame, "oldMixed"),
      );
      expect(back).toContain("newMixed");
    } finally {
      session.close();
    }
  });

  test("full-width Smart addition text copies and comments from beyond the split midpoint", async () => {
    const fixture = createSmartLayoutRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 160,
      rows: 28,
    });
    let output = "";
    const unsubscribe = session.subscribe((chunk) => {
      output += chunk;
    });

    try {
      const initial = await waitForMixedFrame(session);
      expect(initial).toContain(copyMarker);
      const terminalRows = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = terminalRows.findIndex((line) => line.includes(copyMarker));
      const column = terminalRows[row]!.indexOf(copyMarker);
      expect(column).toBeGreaterThan(80);
      await dragMouse(session, column, row, column + copyMarker.length - 1, row);
      await harness.pressAndWaitForText(session, "y", /Copied selection to clipboard/, {
        timeout: 5_000,
      });
      const clipboard = [...output.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g)].at(-1);
      expect(clipboard).toBeDefined();
      expect(Buffer.from(clipboard![1]!, "base64").toString("utf8")).toBe(copyMarker);

      // Clipboard feedback changes the viewport, which intentionally retires the old selection.
      const commentRows = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const commentRow = commentRows.findIndex((line) => line.includes(copyMarker));
      const commentColumn = commentRows[commentRow]!.indexOf(copyMarker);
      await dragMouse(
        session,
        commentColumn,
        commentRow,
        commentColumn + copyMarker.length - 1,
        commentRow,
      );
      const draft = await harness.pressAndWaitForText(session, "c", /Draft note/, {
        timeout: 5_000,
      });
      expect(draft).toContain("a-additions.ts R2");
      await session.type("Comment on the full-width Smart addition.");
      const saved = await harness.pressAndWaitForText(session, ["ctrl", "s"], /Your note/, {
        timeout: 5_000,
      });
      expect(saved).toContain("a-additions.ts R2");
      expect(saved).toContain("Comment on the full-width Smart addition.");
    } finally {
      unsubscribe();
      session.close();
    }
  });
});
