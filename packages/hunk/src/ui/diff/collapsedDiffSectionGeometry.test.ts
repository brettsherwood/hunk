import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { collapsedDiffSectionGeometry } from "./diffSectionGeometry";
import {
  buildInStreamFileHeaderHeights,
  buildFileSectionLayouts,
  findHeaderOwningFileSection,
} from "../lib/fileSectionLayout";
import { buildFileRenderWindow } from "../lib/fileRenderWindow";
import { buildLineCursors } from "../lib/lineCursors";
import { buildReviewVerticalStops } from "../lib/reviewVerticalStops";

describe("collapsed review geometry", () => {
  test("all collapsed files remain addressable and windowed when the file gap is zero", () => {
    const files = ["first", "second", "third"].map((id) =>
      createTestDiffFile({ id, path: `${id}.ts`, before: "old\n", after: "new\n" }),
    );
    const collapsed = new Set(files.map((file) => file.id));
    const geometries = files.map(collapsedDiffSectionGeometry);
    const layouts = buildFileSectionLayouts(
      files,
      geometries.map((geometry) => geometry.bodyHeight),
      buildInStreamFileHeaderHeights(files, collapsed),
      0,
    );

    expect(
      layouts.map((layout) => [layout.headerTop, layout.bodyTop, layout.sectionBottom]),
    ).toEqual([
      [0, 1, 1],
      [1, 2, 2],
      [2, 3, 3],
    ]);
    expect([0, 1, 2].map((row) => findHeaderOwningFileSection(layouts, row)?.fileId)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(
      buildFileRenderWindow({ fileSectionLayouts: layouts, scrollTop: 0, viewportHeight: 3 })
        .mountedFileIndices,
    ).toEqual([0, 1, 2]);
    expect(buildLineCursors(files, geometries)).toEqual([]);
    expect(buildReviewVerticalStops(files, geometries, [])).toEqual([]);
    expect(geometries[0]?.hunkSpans).toBe(files[0]!.metadata.hunks);
  });
});
