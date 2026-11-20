import type { DiffFile } from "../../core/changeset/model";
import type { LayoutMode, ResolvedLayout } from "../../core/run/commandInputs";

export type ResponsiveViewport = "full" | "medium" | "tight";

/** Keep two diff columns until each side would fall below roughly 60 terminal cells. */
const AUTO_SPLIT_MIN_WIDTH = 120;
const SIDEBAR_VIEWPORT_MIN_WIDTH = 160;
const FULL_VIEWPORT_MIN_WIDTH = 220;

export interface ResponsiveLayout {
  viewport: ResponsiveViewport;
  layout: ResolvedLayout;
  showSidebar: boolean;
}

/** Bucket terminal widths into the viewport classes the app layout cares about. */
function resolveResponsiveViewport(viewportWidth: number): ResponsiveViewport {
  if (viewportWidth >= FULL_VIEWPORT_MIN_WIDTH) {
    return "full";
  }

  if (viewportWidth >= SIDEBAR_VIEWPORT_MIN_WIDTH) {
    return "medium";
  }

  return "tight";
}

/** Resolve the effective layout after combining the explicit mode with viewport size. */
export function resolveResponsiveLayout(
  requestedLayout: LayoutMode,
  viewportWidth: number,
): ResponsiveLayout {
  const viewport = resolveResponsiveViewport(viewportWidth);

  if (requestedLayout === "split") {
    return {
      viewport,
      layout: "split",
      showSidebar: viewport !== "tight",
    };
  }

  if (requestedLayout === "unified") {
    return {
      viewport,
      layout: "unified",
      showSidebar: viewport !== "tight",
    };
  }

  return {
    viewport,
    layout: viewportWidth >= AUTO_SPLIT_MIN_WIDTH ? "split" : "unified",
    showSidebar: viewport !== "tight",
  };
}

/** Resolve one file's concrete layout while keeping Auto's viewport policy unchanged. */
export function resolveFileLayout(
  requestedMode: LayoutMode,
  fallbackLayout: ResolvedLayout,
  file: Pick<DiffFile, "stats">,
): ResolvedLayout {
  if (requestedMode === "smart") {
    return file.stats.additions > 0 && file.stats.deletions > 0 ? "split" : "unified";
  }
  return requestedMode === "auto" ? fallbackLayout : requestedMode;
}
