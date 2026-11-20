import { describe, expect, test } from "bun:test";
import { resolveFileLayout, resolveResponsiveLayout } from "./responsive";

// Policy thresholds: >=220 full, >=160 medium with a sidebar, >=120 split without one.
const TIGHT_WIDTH = 100;
const NARROW_SPLIT_WIDTH = 140;
const MEDIUM_WIDTH = 180;
const FULL_WIDTH = 240;

describe("resolveResponsiveLayout — auto", () => {
  test("chooses unified with no sidebar on tight terminals", () => {
    expect(resolveResponsiveLayout("auto", TIGHT_WIDTH)).toEqual({
      viewport: "tight",
      layout: "unified",
      showSidebar: false,
    });
  });

  test("keeps split after the sidebar disappears on narrow terminals", () => {
    expect(resolveResponsiveLayout("auto", NARROW_SPLIT_WIDTH)).toEqual({
      viewport: "tight",
      layout: "split",
      showSidebar: false,
    });
  });

  test("chooses split with a compact-capable sidebar on medium terminals", () => {
    expect(resolveResponsiveLayout("auto", MEDIUM_WIDTH)).toEqual({
      viewport: "medium",
      layout: "split",
      showSidebar: true,
    });
  });

  test("chooses split with a sidebar on full-width terminals", () => {
    expect(resolveResponsiveLayout("auto", FULL_WIDTH)).toEqual({
      viewport: "full",
      layout: "split",
      showSidebar: true,
    });
  });
});

describe("resolveResponsiveLayout — explicit overrides", () => {
  test("keeps split even on a tight terminal while hiding the sidebar", () => {
    expect(resolveResponsiveLayout("split", TIGHT_WIDTH)).toEqual({
      viewport: "tight",
      layout: "split",
      showSidebar: false,
    });
  });

  test("keeps unified even on a full-width terminal and still shows the sidebar there", () => {
    expect(resolveResponsiveLayout("unified", FULL_WIDTH)).toEqual({
      viewport: "full",
      layout: "unified",
      showSidebar: true,
    });
  });

  test("shows the sidebar at medium and full widths for explicit modes", () => {
    expect(resolveResponsiveLayout("split", MEDIUM_WIDTH).showSidebar).toBe(true);
    expect(resolveResponsiveLayout("unified", MEDIUM_WIDTH).showSidebar).toBe(true);
    expect(resolveResponsiveLayout("split", FULL_WIDTH).showSidebar).toBe(true);
  });
});

describe("resolveResponsiveLayout — viewport bucket boundaries", () => {
  test("classifies exactly at the medium and full minimum widths", () => {
    // Sidebar visibility remains bucketed at 160; full chrome starts at 220.
    expect(resolveResponsiveLayout("auto", 159).viewport).toBe("tight");
    expect(resolveResponsiveLayout("auto", 160).viewport).toBe("medium");
    expect(resolveResponsiveLayout("auto", 219).viewport).toBe("medium");
    expect(resolveResponsiveLayout("auto", 220).viewport).toBe("full");
  });

  test("the sidebar cutoff no longer changes the split layout", () => {
    expect(resolveResponsiveLayout("auto", 159)).toMatchObject({
      layout: "split",
      showSidebar: false,
    });
    expect(resolveResponsiveLayout("auto", 160)).toMatchObject({
      layout: "split",
      showSidebar: true,
    });
  });

  test("auto switches from unified to split at its narrower independent cutoff", () => {
    expect(resolveResponsiveLayout("auto", 119)).toMatchObject({
      layout: "unified",
      showSidebar: false,
    });
    expect(resolveResponsiveLayout("auto", 120)).toMatchObject({
      layout: "split",
      showSidebar: false,
    });
  });
});

describe("resolveFileLayout", () => {
  test("Smart selects one layout for the whole file independently of terminal width", () => {
    for (const width of [80, 120, 240]) {
      const fallback = resolveResponsiveLayout("smart", width).layout;
      expect(resolveFileLayout("smart", fallback, { stats: { additions: 2, deletions: 0 } })).toBe(
        "unified",
      );
      expect(resolveFileLayout("smart", fallback, { stats: { additions: 0, deletions: 2 } })).toBe(
        "unified",
      );
      expect(resolveFileLayout("smart", fallback, { stats: { additions: 2, deletions: 2 } })).toBe(
        "split",
      );
      expect(resolveFileLayout("smart", fallback, { stats: { additions: 0, deletions: 0 } })).toBe(
        "unified",
      );
    }
  });
  test("explicit modes override file content and Auto keeps its responsive fallback", () => {
    const added = { stats: { additions: 2, deletions: 0 } };
    const mixed = { stats: { additions: 2, deletions: 2 } };
    expect(resolveFileLayout("split", "unified", added)).toBe("split");
    expect(resolveFileLayout("unified", "split", mixed)).toBe("unified");
    expect(resolveFileLayout("auto", "split", added)).toBe("split");
    expect(resolveFileLayout("auto", "unified", mixed)).toBe("unified");
  });
});
