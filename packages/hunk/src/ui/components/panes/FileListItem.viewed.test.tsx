import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import { toReadOnlyFileViews } from "../../../extensions/events";
import { getBundledUIRegistry } from "../../../extensions/default/ui";
import { resolveTheme } from "../../themes";
import { ExtensionPaneHost } from "./ExtensionPane";

for (const width of [30, 56]) {
  test(`Files pane updates filename weight through the host at width ${width}`, async () => {
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
    const filenameAttributes = () => {
      const span = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("alpha.ts"));
      expect(span).toBeDefined();
      return span!.attributes;
    };
    try {
      await act(async () => {
        await setup.renderOnce();
      });
      expect(filenameAttributes() & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
      await act(async () => {
        setViewed(new Set(["alpha"]));
      });
      await setup.renderOnce();
      expect(filenameAttributes() & TextAttributes.BOLD).toBe(0);
      await act(async () => {
        setViewed(new Set());
      });
      await setup.renderOnce();
      expect(filenameAttributes() & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
}
