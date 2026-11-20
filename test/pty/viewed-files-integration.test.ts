import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "tuistory";
import { createPtyHarness, dragMouse } from "./harness";

const harness = createPtyHarness();
const firstFile = "a-first.ts";
const secondFile = "b-second.ts";
const thirdFile = "c-third.ts";
const copyMarker = "VIEWED_COPY_FROM_RIGHT_HALF";
const firstBody = "alphaAdded";
const secondBody = "secondReplacement";
const thirdBody = "thirdReplacement";

/** Give real terminal startup, reloads, and search enough time on slower machines. */
setDefaultTimeout(30_000);

afterEach(() => harness.cleanup());

/** Build an isolated review with one full-width addition beside two replacement files. */
function createViewedFilesTestFixture(options?: { deep?: boolean }) {
  const dir = harness.createIsolatedConfigHome();
  const originals = {
    "0-leading.ts": "export const leading = 1;\n",
    [firstFile]: "export const alphaKept = true;\n",
    [secondFile]: "export const secondOriginal = 1;\n",
    [thirdFile]: "export const thirdOriginal = 1;\n",
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
  for (const [path, contents] of Object.entries(originals)) {
    writeFileSync(join(dir, path), contents);
  }
  runGit(["add", "."]);
  runGit(["commit", "-m", "viewed files fixture"]);
  const additions = options?.deep
    ? Array.from({ length: 60 }, (_, index) =>
        index === 43
          ? "export const deepViewedMatch = 44;"
          : `export const alphaAdded${String(index + 1).padStart(2, "0")} = ${index + 1};`,
      ).join("\n")
    : `export const alphaAdded = '${"x".repeat(65)} ${copyMarker}';`;
  writeFileSync(join(dir, firstFile), `${originals[firstFile]}${additions}\n`);
  writeFileSync(join(dir, secondFile), "export const secondReplacement = 2;\n");
  writeFileSync(join(dir, thirdFile), "export const thirdReplacement = 3;\n");
  return { dir };
}

/** Find a file's visible header independently of any matching sidebar label. */
function viewedHeader(frame: string, file: string) {
  return frame.split("\n").find((row) => row.includes(file) && row.includes("Viewed")) ?? "";
}

/** Read the checked state only from the file's retained review header. */
function isViewed(frame: string, file: string) {
  return viewedHeader(frame, file).includes("[x] Viewed");
}

/** Find a visible row's terminal coordinates for a precise mouse interaction. */
function terminalTextPosition(session: Session, needle: string, file?: string) {
  const rows = session
    .getTerminalData()
    .lines.map((line) => line.spans.map((span) => span.text).join(""));
  const y = rows.findIndex((row) => row.includes(needle) && (!file || row.includes(file)));
  if (y < 0) throw new Error(`Expected visible ${JSON.stringify(needle)} for ${file ?? "code"}.`);
  return { x: rows[y]!.indexOf(needle), y };
}

/** Click one header control without letting repeated labels choose another file. */
function clickViewedHeaderControl(session: Session, file: string, label: string) {
  const point = terminalTextPosition(session, label, file);
  session.writeRaw(`\x1b[<0;${point.x + 1};${point.y + 1}M`);
  session.writeRaw(`\x1b[<0;${point.x + 1};${point.y + 1}m`);
}

/** Click exactly one checkbox independently of the selected file. */
function clickViewedCheckbox(session: Session, file: string, checked = false) {
  clickViewedHeaderControl(session, file, checked ? "[x] Viewed" : "[ ] Viewed");
}

/** Wait for the first complete review and prove the keyboard handler is ready. */
async function waitForViewedReview(session: Session, options?: { deep?: boolean }) {
  await harness.waitForSnapshot(
    session,
    (frame) =>
      viewedHeader(frame, firstFile).includes("[ ] Viewed") &&
      frame.includes(firstBody) &&
      (options?.deep || (frame.includes(secondBody) && frame.includes(thirdBody))),
    15_000,
  );
  await harness.ensureKeyboardIsLive(session);
  return session.text({ immediate: true });
}

describe("PTY viewed files", () => {
  test("Viewed remains in one column beside different counts and checkbox states", async () => {
    const fixture = createViewedFilesTestFixture();
    writeFileSync(
      join(fixture.dir, firstFile),
      `export const alphaKept = true;\n${Array.from({ length: 45 }, (_, index) => `export const alphaAdded${index} = ${index};`).join("\n")}\n`,
    );
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 90,
      rows: 18,
    });
    try {
      await waitForViewedReview(session, { deep: true });
      for (const file of [firstFile, secondFile, thirdFile]) {
        clickViewedCheckbox(session, file);
        await harness.waitForSnapshot(session, (frame) => isViewed(frame, file));
      }
      const collapsed = await session.text({ immediate: true });
      const headers = [firstFile, secondFile, thirdFile].map((file) =>
        viewedHeader(collapsed, file),
      );
      expect(headers[0]).toContain("+45 -0");
      expect(headers[1]).toContain("+1 -1");
      expect(new Set(headers.map((row) => row.indexOf("[x] Viewed"))).size).toBe(1);
      clickViewedCheckbox(session, thirdFile, true);
      const expanded = await harness.waitForSnapshot(
        session,
        (frame) => !isViewed(frame, thirdFile) && frame.includes(thirdBody),
      );
      expect(viewedHeader(expanded, thirdFile).indexOf("[ ] Viewed")).toBe(
        viewedHeader(expanded, firstFile).indexOf("[x] Viewed"),
      );
    } finally {
      session.close();
    }
  });

  for (const cols of [160, 90]) {
    test(`mouse and keyboard collapse and reopen Smart files at ${cols} columns`, async () => {
      const fixture = createViewedFilesTestFixture();
      const session = await harness.launchHunk({
        args: ["diff", "--mode", "smart", "--no-sidebar"],
        cwd: fixture.dir,
        cols,
        rows: 24,
      });
      try {
        const initial = await waitForViewedReview(session);
        const secondHeaderRow = initial.split("\n").findIndex((row) => row.includes(secondFile));
        clickViewedCheckbox(session, firstFile);
        const collapsed = await harness.waitForSnapshot(
          session,
          (frame) => isViewed(frame, firstFile) && !frame.includes(firstBody),
        );
        expect(collapsed).toContain(secondBody);
        expect(collapsed).toContain(thirdBody);
        expect(collapsed.split("\n").findIndex((row) => row.includes(secondFile))).toBeLessThan(
          secondHeaderRow,
        );
        const reopened = await harness.pressAndWaitForSnapshot(
          session,
          "o",
          (frame) => isViewed(frame, firstFile) && frame.includes(firstBody),
        );
        expect(reopened).toContain(secondBody);
        await harness.pressAndWaitForSnapshot(
          session,
          "o",
          (frame) => isViewed(frame, firstFile) && !frame.includes(firstBody),
        );
        clickViewedHeaderControl(session, firstFile, "▸");
        await harness.waitForSnapshot(
          session,
          (frame) => isViewed(frame, firstFile) && frame.includes(firstBody),
        );
        const unmarked = await harness.pressAndWaitForSnapshot(
          session,
          ["shift", "v"],
          (frame) =>
            viewedHeader(frame, firstFile).includes("[ ] Viewed") && frame.includes(firstBody),
        );
        expect(unmarked).toContain(secondBody);
        expect(unmarked).toContain(thirdBody);
        if (cols === 160) expect(unmarked).toContain(copyMarker);
      } finally {
        session.close();
      }
    });
  }

  test("all collapsed headers remain navigable and the first reopens with no file gap", async () => {
    const fixture = createViewedFilesTestFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar", "--file-gap", "0"],
      cwd: fixture.dir,
      cols: 160,
      rows: 24,
    });
    try {
      await waitForViewedReview(session);
      for (const [index, file] of [firstFile, secondFile, thirdFile].entries()) {
        if (index > 0) await session.press(".");
        await harness.pressAndWaitForSnapshot(session, ["shift", "v"], (frame) =>
          isViewed(frame, file),
        );
      }
      const collapsed = await session.text({ immediate: true });
      expect(collapsed).not.toContain(firstBody);
      expect(collapsed).not.toContain(secondBody);
      expect(collapsed).not.toContain(thirdBody);
      for (const file of [firstFile, secondFile, thirdFile])
        expect(isViewed(collapsed, file)).toBe(true);
      await session.press(",");
      await session.press(",");
      const reopened = await harness.pressAndWaitForSnapshot(
        session,
        "o",
        (frame) => isViewed(frame, firstFile) && frame.includes(firstBody),
      );
      expect(reopened).not.toContain(secondBody);
      expect(reopened).not.toContain(thirdBody);
      const hunkJump = await harness.pressAndWaitForSnapshot(
        session,
        "]",
        (frame) => isViewed(frame, secondFile) && frame.includes(secondBody),
      );
      expect(hunkJump).not.toContain(thirdBody);
    } finally {
      session.close();
    }
  });

  test("a sidebar file jump keeps a viewed body closed and selects its retained header", async () => {
    const fixture = createViewedFilesTestFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--sidebar"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });
    try {
      await waitForViewedReview(session);
      await harness.pressAndWaitForSnapshot(
        session,
        ["shift", "v"],
        (frame) => isViewed(frame, firstFile) && !frame.includes(firstBody),
      );
      await harness.pressAndWaitForSnapshot(session, ".", (frame) =>
        frame.includes(`▌M ${secondFile}`),
      );
      const jumped = await harness.clickAndWaitForSnapshot(
        session,
        /M a-first\.ts/,
        (frame) => frame.includes(`▌M ${firstFile}`) && isViewed(frame, firstFile),
      );
      expect(jumped).not.toContain(firstBody);
      expect(jumped).toContain(secondBody);
      await harness.pressAndWaitForSnapshot(
        session,
        "o",
        (frame) => isViewed(frame, firstFile) && frame.includes(firstBody),
      );
    } finally {
      session.close();
    }
  });

  test("marking a file retires a committed full-width text selection", async () => {
    const fixture = createViewedFilesTestFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 160,
      rows: 24,
    });
    let output = "";
    const unsubscribe = session.subscribe((chunk) => {
      output += chunk;
    });
    try {
      await waitForViewedReview(session);
      const point = terminalTextPosition(session, copyMarker);
      expect(point.x).toBeGreaterThan(80);
      await dragMouse(session, point.x, point.y, point.x + copyMarker.length - 1, point.y);
      await harness.waitForSnapshot(session, (frame) => frame.includes("Copy"));
      clickViewedCheckbox(session, firstFile);
      const collapsed = await harness.waitForSnapshot(
        session,
        (frame) =>
          isViewed(frame, firstFile) && !frame.includes(firstBody) && !frame.includes("Copy"),
      );
      expect(collapsed).toContain(secondBody);
      const beforeCopy = output.length;
      await session.press("y");
      expect(output.slice(beforeCopy)).not.toContain("\x1b]52;");
      expect(await session.text({ immediate: true })).not.toContain(
        "Copied selection to clipboard",
      );
    } finally {
      unsubscribe();
      session.close();
    }
  });

  test("a focused note draft blocks marking or collapsing its file", async () => {
    const fixture = createViewedFilesTestFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 160,
      rows: 28,
    });
    try {
      await waitForViewedReview(session);
      await harness.pressAndWaitForSnapshot(session, "c", (frame) => frame.includes("Draft note"));
      clickViewedCheckbox(session, firstFile);
      await session.waitIdle();
      let frame = await session.text({ immediate: true });
      expect(viewedHeader(frame, firstFile)).toContain("[ ] Viewed");
      expect(frame).toContain(firstBody);
      expect(frame).toContain("Draft note");
      clickViewedHeaderControl(session, firstFile, "▾");
      await session.waitIdle();
      frame = await session.text({ immediate: true });
      expect(frame).toContain(firstBody);
      expect(frame).toContain("Draft note");
      expect(isViewed(frame, firstFile)).toBe(false);
    } finally {
      session.close();
    }
  });

  test("reload keeps unchanged viewed files and manual expansion across runtime id shifts", async () => {
    const fixture = createViewedFilesTestFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "smart", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 160,
      rows: 32,
    });
    try {
      await waitForViewedReview(session);
      await harness.pressAndWaitForSnapshot(
        session,
        ["shift", "v"],
        (frame) => isViewed(frame, firstFile) && !frame.includes(firstBody),
      );
      await harness.pressAndWaitForSnapshot(
        session,
        "o",
        (frame) => isViewed(frame, firstFile) && frame.includes(firstBody),
      );
      clickViewedCheckbox(session, secondFile);
      await harness.waitForSnapshot(
        session,
        (frame) => isViewed(frame, secondFile) && !frame.includes(secondBody),
      );
      // A new earlier change gives both existing files different VCS runtime ids.
      writeFileSync(join(fixture.dir, "0-leading.ts"), "export const leadingShift = 2;\n");
      const shifted = await harness.pressAndWaitForSnapshot(
        session,
        "r",
        (frame) => frame.includes("leadingShift") && isViewed(frame, firstFile),
        10_000,
      );
      expect(shifted).toContain(firstBody);
      expect(isViewed(shifted, secondFile)).toBe(true);
      expect(shifted).not.toContain(secondBody);
      writeFileSync(join(fixture.dir, firstFile), "export const alphaChangedAfterReview = 7;\n");
      const changed = await harness.pressAndWaitForSnapshot(
        session,
        "r",
        (frame) =>
          frame.includes("alphaChangedAfterReview") &&
          viewedHeader(frame, firstFile).includes("[ ] Viewed"),
        10_000,
      );
      expect(isViewed(changed, secondFile)).toBe(true);
      expect(changed).not.toContain(secondBody);
    } finally {
      session.close();
    }
  });

  for (const startsViewed of [false, true]) {
    test(
      startsViewed
        ? "search opens a deep match inside a viewed file while keeping its checked state"
        : "search lands a deep Smart match in an already open file",
      async () => {
        const fixture = createViewedFilesTestFixture({ deep: true });
        const session = await harness.launchHunk({
          args: ["diff", "--mode", "smart", "--no-sidebar"],
          cwd: fixture.dir,
          cols: 160,
          rows: 14,
        });
        try {
          await waitForViewedReview(session, { deep: true });
          if (startsViewed) {
            await harness.pressAndWaitForSnapshot(
              session,
              ["shift", "v"],
              (frame) => isViewed(frame, firstFile) && !frame.includes(firstBody),
            );
          }
          await harness.pressAndWaitForSnapshot(session, "/", (frame) =>
            frame.includes("/ search diff"),
          );
          await session.type("deepViewedMatch");
          const landed = await harness.pressAndWaitForSnapshot(
            session,
            "enter",
            (frame) =>
              frame
                .split("\n")
                .some(
                  (row) => row.includes("▌") && row.includes("export const deepViewedMatch = 44;"),
                ) && isViewed(frame, firstFile) === startsViewed,
          );
          expect(landed).not.toContain("alphaAdded01");
          expect(landed).toContain("[1/1]");
        } finally {
          session.close();
        }
      },
    );
  }
});
