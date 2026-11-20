import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import {
  useFileReviewPresentation,
  type FileReviewPresentationOptions,
} from "./useFileReviewPresentation";

/** Observe disclosure with replaceable runtime ids, identities, and semantic viewed marks. */
async function renderTestFilePresentation(options: FileReviewPresentationOptions) {
  let presentation!: ReturnType<typeof useFileReviewPresentation>;
  let replace!: (next: FileReviewPresentationOptions) => void;
  function Harness() {
    const [current, setCurrent] = useState(options);
    replace = setCurrent;
    presentation = useFileReviewPresentation(current);
    return null;
  }
  const setup = await testRender(<Harness />, { width: 30, height: 4 });
  await act(async () => setup.renderOnce());
  return { setup, current: () => presentation, replace };
}

/** Build one file's presentation inputs without binding persisted disclosure to its runtime id. */
function testOptions(id: string, identity: string, viewed = true): FileReviewPresentationOptions {
  return {
    files: [createTestDiffFile({ id, path: "review.ts", before: "old\n", after: "new\n" })],
    identityByFileId: new Map([[id, identity]]),
    viewedFileIds: new Set(viewed ? [id] : []),
  };
}

describe("useFileReviewPresentation", () => {
  test("preserves an opened viewed file across runtime-id replacement and retires changed content", async () => {
    const harness = await renderTestFilePresentation(testOptions("first", "key:content-a"));
    try {
      expect(harness.current().isCollapsed("first")).toBe(true);
      await act(async () => harness.current().expandFile("first"));
      await act(async () => harness.replace(testOptions("reloaded", "key:content-a")));
      expect(harness.current().isCollapsed("reloaded")).toBe(false);
      await act(async () => harness.replace(testOptions("changed", "key:content-b", false)));
      expect(harness.current().collapsedFileIds.size).toBe(0);
      // A retired content generation cannot resurrect its old disclosure override later.
      await act(async () => harness.replace(testOptions("restored", "key:content-a")));
      expect(harness.current().isCollapsed("restored")).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("new viewed marks replace caret overrides and synchronous command bursts see each toggle", async () => {
    let viewed = false;
    const options = { ...testOptions("file", "key:content", false), isFileViewed: () => viewed };
    const harness = await renderTestFilePresentation(options);
    try {
      await act(async () => {
        harness.current().toggleFileCollapsed("file");
        expect(harness.current().isCollapsed("file")).toBe(true);
        harness.current().toggleFileCollapsed("file");
        expect(harness.current().isCollapsed("file")).toBe(false);
      });
      viewed = true;
      expect(harness.current().isCollapsed("file")).toBe(true);
      await act(async () => harness.current().expandFile("file"));
      expect(harness.current().isCollapsed("file")).toBe(false);
      viewed = false;
      expect(harness.current().isCollapsed("file")).toBe(false);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps a draft visible and leaves its file open after composition ends", async () => {
    const options = testOptions("file", "key:content");
    const harness = await renderTestFilePresentation(options);
    try {
      await act(async () => harness.replace({ ...options, draftFileId: "file" }));
      await act(async () => harness.current().toggleFileCollapsed("file"));
      expect(harness.current().isCollapsed("file")).toBe(false);
      await act(async () => harness.replace(options));
      expect(harness.current().isCollapsed("file")).toBe(false);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });
});
