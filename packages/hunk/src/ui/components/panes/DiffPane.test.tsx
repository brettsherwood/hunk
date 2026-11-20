import { describe, expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { resetOpenTuiScrollAccumulators } from "./DiffPane";
import { DiffPane } from "./DiffPane";
import { testRender } from "@opentui/react/test-utils";
import { act, useRef, useState } from "react";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import { resolveTheme } from "../../themes";
import { maxFileHeaderStatsWidth } from "../../lib/fileHeader";
import { validateFileViewLayout } from "../../fileViews/layout";
import type { ResolvedFileViewLayout } from "../../fileViews/useFileViews";
import { diffSectionId } from "../../lib/ids";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";
import { renderCopySelectionText } from "./copySelection";
import {
  collapsedDiffSectionGeometry,
  measureDiffSectionGeometry,
} from "../../diff/diffSectionGeometry";
import {
  buildFileSectionLayouts,
  buildInStreamFileHeaderHeights,
} from "../../lib/fileSectionLayout";

describe("resetOpenTuiScrollAccumulators", () => {
  test("requires the OpenTUI 0.5.6 compatibility operation", () => {
    const resetScrollAccumulators = (
      ScrollBoxRenderable.prototype as unknown as { resetScrollAccumulators?: () => void }
    ).resetScrollAccumulators;

    expect(resetScrollAccumulators).toBeFunction();
  });

  test("fails clearly when an OpenTUI upgrade removes the compatibility operation", () => {
    expect(() => resetOpenTuiScrollAccumulators({} as unknown as ScrollBoxRenderable)).toThrow(
      "OpenTUI 0.5.6 ScrollBoxRenderable.resetScrollAccumulators is required after shifted wheel input.",
    );
  });
});

/** Settle geometry before reading controls or the scrollbox's real content extent. */
async function flushTestDiffPane(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

describe("DiffPane file disclosure", () => {
  test("consumes a local capture before a later remote collapse below the viewport", async () => {
    const files = ["alpha", "beta", "gamma"].map((id) =>
      createTestDiffFile({
        id,
        path: `${id}.ts`,
        before: "common\n",
        after: `common\n${Array.from({ length: id === "alpha" ? 80 : 15 }, (_, index) => `${id}Row${index}`).join("\n")}\n`,
      }),
    );
    let localCollapse!: () => void;
    let remoteCollapse!: () => void;
    let readScrollBox!: () => ScrollBoxRenderable | null;
    let readCapture!: () => number | null;
    function Harness() {
      const scrollRef = useRef<ScrollBoxRenderable | null>(null);
      const capture = useRef<number | null>(null);
      const [collapsed, setCollapsed] = useState(new Set<string>());
      readScrollBox = () => scrollRef.current;
      readCapture = () => capture.current;
      localCollapse = () => {
        capture.current = scrollRef.current?.scrollTop ?? 0;
        setCollapsed(new Set(["gamma"]));
      };
      remoteCollapse = () => setCollapsed(new Set(["beta", "gamma"]));
      return (
        <DiffPane
          files={files}
          scrollRef={scrollRef}
          width={90}
          height={16}
          diffContentWidth={88}
          headerLabelWidth={70}
          headerStatsWidth={8}
          separatorWidth={88}
          layout="unified"
          selectedFileId="alpha"
          selectedHunkIndex={0}
          showAgentNotes={false}
          showLineNumbers={true}
          showHunkHeaders={true}
          wrapLines={false}
          wrapToggleScrollTop={null}
          fileGap={0}
          theme={resolveTheme("github-dark-default", null)}
          collapsedFileIds={collapsed}
          disclosureScrollTopRef={capture}
          onSelectFile={() => {}}
        />
      );
    }
    const setup = await testRender(<Harness />, { width: 90, height: 18 });
    try {
      await flushTestDiffPane(setup);
      await act(async () => localCollapse());
      await flushTestDiffPane(setup);
      expect(readCapture()).toBeNull();
      await act(async () => {
        readScrollBox()?.scrollTo(30);
        await Bun.sleep(30);
      });
      await flushTestDiffPane(setup);
      const before = setup.captureCharFrame().match(/alphaRow\d+/)?.[0];
      await act(async () => remoteCollapse());
      await flushTestDiffPane(setup);
      expect(readScrollBox()?.scrollTop).toBe(30);
      expect(setup.captureCharFrame().match(/alphaRow\d+/)?.[0]).toBe(before);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test.each([
    ["file-top after paint", "file-top", false],
    ["collapse after paint", "collapse", false],
    ["file-top in one input burst", "file-top", true],
    ["collapse in one input burst", "collapse", true],
  ] as const)(
    "new %s retires a line reveal waiting for native sizing",
    async (_label, action, sameBurst) => {
      const file = createTestDiffFile({
        id: "alpha",
        path: "alpha.ts",
        before: "common\n",
        after: `common\n${Array.from({ length: 60 }, (_, index) => `alphaRow${index}`).join("\n")}\n`,
      });
      let requestLine!: () => void;
      let requestFileTop!: () => void;
      let readScrollBox!: () => ScrollBoxRenderable | null;
      let expansions = 0;
      function Harness() {
        const scrollRef = useRef<ScrollBoxRenderable | null>(null);
        const [lineId, setLineId] = useState(0);
        const [fileId, setFileId] = useState(0);
        const [disclosureId, setDisclosureId] = useState(0);
        readScrollBox = () => scrollRef.current;
        requestLine = () => setLineId(1);
        requestFileTop = () => (action === "file-top" ? setFileId(1) : setDisclosureId(1));
        return (
          <DiffPane
            files={[file]}
            scrollRef={scrollRef}
            width={90}
            height={16}
            diffContentWidth={88}
            headerLabelWidth={70}
            headerStatsWidth={8}
            separatorWidth={88}
            layout="unified"
            selectedFileId={file.id}
            selectedHunkIndex={0}
            selectedHunkRevealRequestId={0}
            selectedFileTopAlignRequestId={fileId}
            fileDisclosureRequestId={disclosureId}
            collapsedFileIds={new Set(disclosureId ? [file.id] : [])}
            lineCursor={{
              fileId: file.id,
              hunkIndex: 0,
              stableKey: "line:0:new:45",
              target: { side: "new", line: 45 },
            }}
            lineCursorRevealRequest={{
              id: lineId,
              placement: "reveal",
              origin: { fileTopToken: 0, hunkToken: 0, fileDisclosureRequestId: 0 },
            }}
            showAgentNotes={false}
            showLineNumbers={true}
            showHunkHeaders={true}
            wrapLines={false}
            wrapToggleScrollTop={null}
            theme={resolveTheme("github-dark-default", null)}
            onSelectFile={() => {}}
            onExpandFile={() => {
              expansions += 1;
            }}
          />
        );
      }
      const setup = await testRender(<Harness />, { width: 90, height: 18 });
      try {
        await flushTestDiffPane(setup);
        const scrollBox = readScrollBox()!;
        const originalScroll = scrollBox.scrollTo.bind(scrollBox);
        let refuse = true;
        const calls: number[] = [];
        scrollBox.scrollTo = (position) => {
          if (typeof position === "number") {
            calls.push(position);
            if (refuse && position > 0) return;
          }
          originalScroll(position);
        };
        if (sameBurst) {
          refuse = false;
          await act(async () => {
            requestLine();
            requestFileTop();
          });
        } else {
          await act(async () => requestLine());
          await flushTestDiffPane(setup);
          expect(calls.some((value) => value > 0)).toBe(true);
          refuse = false;
          await act(async () => requestFileTop());
        }
        await flushTestDiffPane(setup);
        await act(async () => {
          await Bun.sleep(65);
          await setup.renderOnce();
        });
        expect(scrollBox.scrollTop).toBe(0);
        expect(calls.at(-1)).toBe(0);
        expect(expansions).toBe(0);
        if (action === "collapse") expect(setup.captureCharFrame()).not.toContain("alphaRow");
      } finally {
        await act(async () => setup.renderer.destroy());
      }
    },
  );

  test("collapsing a preceding file preserves the following file's viewport row", async () => {
    const files = ["first", "second"].map((id) =>
      createTestDiffFile({
        id,
        path: `${id}.ts`,
        before: "common\n",
        after: `common\n${Array.from({ length: 35 }, (_, index) => `${id}Row${index + 1}`).join("\n")}\n`,
      }),
    );
    const theme = resolveTheme("github-dark-default", null);
    const firstHeight = measureDiffSectionGeometry(
      files[0]!,
      "unified",
      true,
      theme,
      [],
      88,
    ).bodyHeight;
    let collapseFirst!: () => void;
    let readScrollBox!: () => ScrollBoxRenderable | null;
    function Harness() {
      const scrollRef = useRef<ScrollBoxRenderable | null>(null);
      const capturedTop = useRef<number | null>(null);
      const [collapsed, setCollapsed] = useState(new Set<string>());
      readScrollBox = () => scrollRef.current;
      collapseFirst = () => {
        capturedTop.current = scrollRef.current?.scrollTop ?? 0;
        setCollapsed(new Set(["first"]));
      };
      return (
        <DiffPane
          files={files}
          scrollRef={scrollRef}
          width={90}
          height={16}
          diffContentWidth={88}
          headerLabelWidth={70}
          headerStatsWidth={6}
          separatorWidth={88}
          layout="unified"
          selectedFileId="first"
          selectedHunkIndex={0}
          showAgentNotes={false}
          showLineNumbers={true}
          showHunkHeaders={true}
          wrapLines={false}
          wrapToggleScrollTop={null}
          fileGap={0}
          theme={theme}
          collapsedFileIds={collapsed}
          disclosureScrollTopRef={capturedTop}
          onSelectFile={() => {}}
        />
      );
    }
    const setup = await testRender(<Harness />, { width: 90, height: 18 });
    try {
      await flushTestDiffPane(setup);
      await act(async () => {
        readScrollBox()?.scrollTo(firstHeight + 6);
        await Bun.sleep(30);
      });
      await flushTestDiffPane(setup);
      const before = setup.captureCharFrame().match(/secondRow\d+/)?.[0];
      expect(before).toBeDefined();
      const previousTop = readScrollBox()!.scrollTop;
      await act(async () => collapseFirst());
      await flushTestDiffPane(setup);
      expect(setup.captureCharFrame().match(/secondRow\d+/)?.[0]).toBe(before);
      expect(readScrollBox()!.scrollTop).toBe(previousTop - firstHeight + 1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("decoration copying uses the painted caret and Viewed columns beside a wide filename", async () => {
    const file = createTestDiffFile({
      id: "wide",
      path: "目录/review.ts",
      before: "old\n",
      after: "new\n",
    });
    const width = 60;
    const headerStatsWidth = maxFileHeaderStatsWidth([file]);
    const headerLabelWidth = width - 2 - headerStatsWidth - 1;
    const setup = await testRender(
      <DiffFileHeaderRow
        file={file}
        headerLabelWidth={headerLabelWidth}
        headerStatsWidth={headerStatsWidth}
        theme={resolveTheme("github-dark-default", null)}
        reviewPresentation={{ viewed: true, collapsed: true }}
      />,
      { width, height: 1 },
    );
    try {
      await flushTestDiffPane(setup);
      const geometry = collapsedDiffSectionGeometry(file);
      const collapsed = new Set([file.id]);
      const copied = renderCopySelectionText({
        context: {
          codeHorizontalOffset: 0,
          copyDecorations: true,
          files: [file],
          fileSectionLayouts: buildFileSectionLayouts(
            [file],
            [0],
            buildInStreamFileHeaderHeights([file], collapsed),
            0,
          ),
          headerLabelWidth,
          headerStatsWidth,
          layout: "unified",
          pinnedHeaderFile: file,
          viewedFileIds: collapsed,
          collapsedFileIds: collapsed,
          reserveAddNoteColumn: false,
          sectionGeometry: [geometry],
          showHunkHeaders: true,
          showLineNumbers: true,
          width,
          wrapLines: false,
        },
        start: { kind: "pinned-header", fileId: file.id, column: 0, nextVisualRow: 0 },
        end: { kind: "pinned-header", fileId: file.id, column: width - 1, nextVisualRow: 0 },
      });
      expect(copied.trimEnd()).toBe(setup.captureCharFrame().trimEnd());
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("checkbox and caret clicks target their header without selecting another file", async () => {
    const files = ["alpha", "beta"].map((id) =>
      createTestDiffFile({ id, path: `${id}.ts`, before: `old${id}\n`, after: `body${id}\n` }),
    );
    const selected: string[] = [];
    function Harness() {
      const scrollRef = useRef<ScrollBoxRenderable | null>(null);
      const [viewed, setViewed] = useState(new Set<string>());
      const [collapsed, setCollapsed] = useState(new Set<string>());
      return (
        <DiffPane
          files={files}
          scrollRef={scrollRef}
          width={90}
          height={16}
          diffContentWidth={88}
          headerLabelWidth={70}
          headerStatsWidth={maxFileHeaderStatsWidth(files)}
          separatorWidth={88}
          layout="unified"
          selectedFileId="alpha"
          selectedHunkIndex={0}
          showAgentNotes={false}
          showLineNumbers={true}
          showHunkHeaders={true}
          wrapLines={false}
          wrapToggleScrollTop={null}
          fileGap={0}
          theme={resolveTheme("github-dark-default", null)}
          viewedFileIds={viewed}
          collapsedFileIds={collapsed}
          onSelectFile={(id) => selected.push(id)}
          onToggleFileViewed={(id) => {
            const next = new Set(viewed);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setViewed(next);
            setCollapsed(new Set(next));
          }}
          onToggleFileCollapsed={(id) => {
            const next = new Set(collapsed);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setCollapsed(next);
          }}
        />
      );
    }
    const setup = await testRender(<Harness />, { width: 90, height: 18 });
    try {
      await flushTestDiffPane(setup);
      let rows = setup.captureCharFrame().split("\n");
      let y = rows.findIndex((row) => row.includes("beta.ts") && row.includes("Viewed"));
      expect(y).toBeGreaterThan(0);
      await act(async () => setup.mockMouse.click(rows[y]!.indexOf("[ ] Viewed") + 1, y));
      await flushTestDiffPane(setup);
      expect(selected).toEqual([]);
      expect(setup.captureCharFrame()).not.toContain("bodybeta");
      expect(setup.captureCharFrame()).toContain("bodyalpha");
      rows = setup.captureCharFrame().split("\n");
      y = rows.findIndex((row) => row.includes("beta.ts") && row.includes("[x] Viewed"));
      expect(y).toBeGreaterThan(0);
      await act(async () => setup.mockMouse.click(rows[y]!.indexOf("▸"), y));
      await flushTestDiffPane(setup);
      expect(selected).toEqual([]);
      expect(setup.captureCharFrame()).toContain("bodybeta");
      expect(setup.captureCharFrame()).toContain("[x] Viewed");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("collapsing an alternate file view removes its measured body and retains one first header", async () => {
    const file = createTestDiffFile({
      id: "alternate",
      path: "alternate.ts",
      before: "old\n",
      after: "rawBody\n",
    });
    const checked = validateFileViewLayout(
      {
        rows: Array.from({ length: 4 }, (_, index) => ({
          id: `row${index}`,
          spans: [{ text: `ALTERNATE BODY ${index}` }],
        })),
        hunkRows: [{ startRow: 0, endRow: 3 }],
      },
      1,
      88,
    );
    if (!checked.valid) throw new Error(checked.issue);
    const view: ResolvedFileViewLayout = {
      ...checked.value,
      key: "test.alternate",
      extensionId: "test",
      viewId: "alternate",
      registrationIdentity: 1,
      layoutGeneration: 1,
    };
    let setCollapsed!: (value: boolean) => void;
    let readScrollBox!: () => ScrollBoxRenderable | null;
    function Harness() {
      const scrollRef = useRef<ScrollBoxRenderable | null>(null);
      const [collapsed, set] = useState(false);
      setCollapsed = set;
      readScrollBox = () => scrollRef.current;
      return (
        <DiffPane
          files={[file]}
          fileViews={new Map([[file.id, view]])}
          scrollRef={scrollRef}
          width={90}
          height={16}
          diffContentWidth={88}
          headerLabelWidth={70}
          headerStatsWidth={6}
          separatorWidth={88}
          layout="unified"
          selectedFileId={file.id}
          selectedHunkIndex={0}
          showAgentNotes={false}
          showLineNumbers={true}
          showHunkHeaders={true}
          wrapLines={false}
          wrapToggleScrollTop={null}
          fileGap={0}
          viewedFileIds={new Set(collapsed ? [file.id] : [])}
          collapsedFileIds={new Set(collapsed ? [file.id] : [])}
          theme={resolveTheme("github-dark-default", null)}
          onSelectFile={() => {}}
        />
      );
    }
    const setup = await testRender(<Harness />, { width: 90, height: 18 });
    try {
      await flushTestDiffPane(setup);
      expect(setup.captureCharFrame()).toContain("ALTERNATE BODY 3");
      await act(async () => setCollapsed(true));
      await flushTestDiffPane(setup);
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("ALTERNATE BODY");
      expect(frame.match(/alternate\.ts/g)?.length).toBe(1);
      expect(frame).toContain("[x] Viewed");
      expect(readScrollBox()?.content.findDescendantById(diffSectionId(file.id))?.height).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
