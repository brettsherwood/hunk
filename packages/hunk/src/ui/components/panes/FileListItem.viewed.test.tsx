import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import { toReadOnlyFileViews } from "../../../extensions/events";
import { getBundledUIRegistry } from "../../../extensions/default/ui";
import { resolveTheme } from "../../themes";
import { ExtensionPaneHost } from "./ExtensionPane";

for (const width of [30, 56]) {
  test(`Files pane updates the Viewed checkmark through the host at width ${width}`, async () => {
    const files = [
      createTestDiffFile({ id: "alpha", path: "src/alpha.ts", before: "a\n", after: "b\n" }),
    ];
    const fileViews = toReadOnlyFileViews(files);
    const theme = resolveTheme("github-dark-default", null);
    const keybindings = { matches: () => false, getKeys: () => [] };
    let setViewed!: (ids: ReadonlySet<string>) => void;
    function TestPane() {
      const [viewed, update] = useState<ReadonlySet<string>>(new Set());
      setViewed = update;
      return (
        <ExtensionPaneHost
          registered={getBundledUIRegistry().panes[0]!}
          files={files}
          fileViews={fileViews}
          viewedFileIds={viewed}
          selectedFileId="alpha"
          selectedHunkIndex={0}
          placement="left"
          theme={theme}
          width={width}
          height={10}
          currentLine={null}
          keybindings={keybindings}
          notify={() => {}}
          onSelectFile={() => {}}
          onSelectHunk={() => {}}
          onRevealLine={() => "none"}
        />
      );
    }
    const setup = await testRender(<TestPane />, { width: 60, height: 15 });
    const filenameRow = () => {
      const row = setup
        .captureCharFrame()
        .split("\n")
        .find((row) => row.includes("alpha.ts"));
      expect(row).toBeDefined();
      return row!;
    };
    try {
      await act(async () => {
        await setup.renderOnce();
      });
      expect(filenameRow()).not.toContain("✓");
      const originalColumn = filenameRow().indexOf("alpha.ts");
      await act(async () => {
        setViewed(new Set(["alpha"]));
      });
      await setup.renderOnce();
      expect(filenameRow()).toContain("✓ M alpha.ts");
      expect(filenameRow().indexOf("alpha.ts")).toBe(originalColumn);
      await act(async () => {
        setViewed(new Set());
      });
      await setup.renderOnce();
      expect(filenameRow()).not.toContain("✓");
      expect(filenameRow().indexOf("alpha.ts")).toBe(originalColumn);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
}
