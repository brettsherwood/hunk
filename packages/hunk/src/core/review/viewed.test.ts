import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import { applyReviewIntent, planReviewIntent, ReviewIntentPlanningError } from "./intents";
import { reduceReviewState } from "./reducer";
import {
  isReviewFileViewed,
  reconcileViewedReviewFileKeys,
  selectVisibleReviewFiles,
} from "./selectors";
import { createReviewStore } from "./store";

describe("viewed file review state", () => {
  test("marks and unmarks idempotently without changing review selection or notes", () => {
    const note = createTestStoredNote({ id: "user:1", fileKey: "alpha", source: "user" });
    const state = { ...createTestReviewState(), userNotes: [note], filter: "beta" };
    const viewed = reduceReviewState(state, {
      type: "files/set-viewed",
      fileKey: "alpha",
      viewed: true,
    });
    expect(state.viewedFileKeys).toEqual([]);
    expect(viewed.viewedFileKeys).toEqual(["alpha"]);
    expect(isReviewFileViewed(viewed, "alpha")).toBe(true);
    expect(viewed.selection).toBe(state.selection);
    expect(viewed.userNotes).toBe(state.userNotes);
    expect(viewed.filter).toBe("beta");
    expect(selectVisibleReviewFiles(viewed).map((file) => file.key)).toEqual(["beta"]);
    expect(
      reduceReviewState(viewed, { type: "files/set-viewed", fileKey: "alpha", viewed: true }),
    ).toBe(viewed);
    const unviewed = reduceReviewState(viewed, {
      type: "files/set-viewed",
      fileKey: "alpha",
      viewed: false,
    });
    expect(unviewed.viewedFileKeys).toEqual([]);
    expect(
      reduceReviewState(unviewed, { type: "files/set-viewed", fileKey: "alpha", viewed: false }),
    ).toBe(unviewed);
  });

  test("rejects unknown file intents and leaves direct absent-file actions unchanged", () => {
    const state = createTestReviewState();
    expect(() =>
      planReviewIntent(state, { type: "files/set-viewed", fileKey: "absent", viewed: true }),
    ).toThrow(ReviewIntentPlanningError);
    expect(
      reduceReviewState(state, { type: "files/set-viewed", fileKey: "absent", viewed: true }),
    ).toBe(state);
  });

  test("keeps unchanged content across reordered files and replacement runtime ids", () => {
    const previous = createTestReviewDocument(["alpha", "beta"]);
    const next = createTestReviewDocument(["beta", "alpha"]);
    next.files[1]!.runtimeId = "replacement-alpha";
    expect(reconcileViewedReviewFileKeys(["alpha"], previous, next)).toEqual(["alpha"]);
  });

  test("resets changed or removed content even when neither file has a source fetcher", () => {
    const state = {
      ...createTestReviewState(["alpha", "beta", "removed"]),
      viewedFileKeys: ["alpha", "beta", "removed"],
    };
    const document = createTestReviewDocument([
      { key: "alpha", contentIdentity: "changed" },
      "beta",
      "new",
    ]);
    expect(state.document.files[0]!.sourceIdentity).toBeUndefined();
    expect(document.files[0]!.sourceIdentity).toBeUndefined();
    expect(
      reduceReviewState(state, { type: "document/reconcile", document }).viewedFileKeys,
    ).toEqual(["beta"]);
  });

  test("does not reset viewed when only backing source identity changes", () => {
    const state = {
      ...createTestReviewState([{ key: "alpha", sourceIdentity: "old-source" }]),
      viewedFileKeys: ["alpha"],
    };
    const document = createTestReviewDocument([{ key: "alpha", sourceIdentity: "new-source" }]);
    expect(
      reduceReviewState(state, { type: "document/reconcile", document }).viewedFileKeys,
    ).toEqual(["alpha"]);
  });

  test("publishes one revision per change and does not notify for an identical marker", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha"]));
    let notifications = 0;
    store.subscribe(() => notifications++);
    applyReviewIntent(store, { type: "files/set-viewed", fileKey: "alpha", viewed: true });
    applyReviewIntent(store, { type: "files/set-viewed", fileKey: "alpha", viewed: true });
    expect(store.getSnapshot().stateRevision).toBe(1);
    expect(notifications).toBe(1);
  });
});
