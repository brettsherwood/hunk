/** Keep file disclosure local while viewed marks follow the shared review store. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";

interface FileDisclosureOverride {
  collapsed: boolean;
  viewed: boolean;
}

export interface FileReviewPresentationOptions {
  files: readonly DiffFile[];
  /** Stable file key and content identity, independent of runtime ids and source loading. */
  identityByFileId: ReadonlyMap<string, string>;
  viewedFileIds: ReadonlySet<string>;
  /** Read intervening shared-store commands before React publishes their snapshot. */
  isFileViewed?: (fileId: string) => boolean;
  draftFileId?: string;
}

/** Preserve explicit disclosure across unchanged reloads and protect open note composers. */
export function useFileReviewPresentation(options: FileReviewPresentationOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const overridesRef = useRef(new Map<string, FileDisclosureOverride>());
  const [revision, setRevision] = useState(0);

  const isCollapsed = useCallback((fileId: string) => {
    const current = optionsRef.current;
    if (current.draftFileId === fileId) return false;
    const identity = current.identityByFileId.get(fileId);
    if (!identity) return false;
    const viewed = current.isFileViewed?.(fileId) ?? current.viewedFileIds.has(fileId);
    const override = overridesRef.current.get(identity);
    return override?.viewed === viewed ? override.collapsed : viewed;
  }, []);

  /** Commit disclosure synchronously so a burst of commands sees its preceding changes. */
  const setCollapsed = useCallback((fileId: string, collapsed: boolean) => {
    const current = optionsRef.current;
    if (collapsed && current.draftFileId === fileId) return false;
    const identity = current.identityByFileId.get(fileId);
    if (!identity) return false;
    const viewed = current.isFileViewed?.(fileId) ?? current.viewedFileIds.has(fileId);
    const previous = overridesRef.current.get(identity);
    if (previous?.collapsed === collapsed && previous.viewed === viewed) return true;
    overridesRef.current.set(identity, { collapsed, viewed });
    setRevision((value) => value + 1);
    return true;
  }, []);

  const expandFile = useCallback(
    (fileId: string) => {
      setCollapsed(fileId, false);
    },
    [setCollapsed],
  );

  const toggleFileCollapsed = useCallback(
    (fileId: string) => {
      setCollapsed(fileId, !isCollapsed(fileId));
    },
    [isCollapsed, setCollapsed],
  );

  /** Let a changed viewed mark choose its default disclosure rather than an older caret override. */
  const resetFileDisclosure = useCallback((fileId: string) => {
    const identity = optionsRef.current.identityByFileId.get(fileId);
    if (identity && overridesRef.current.delete(identity)) setRevision((value) => value + 1);
  }, []);

  useLayoutEffect(() => {
    const retained = new Set(options.identityByFileId.values());
    for (const identity of overridesRef.current.keys()) {
      if (!retained.has(identity)) overridesRef.current.delete(identity);
    }
    if (options.draftFileId) expandFile(options.draftFileId);
  }, [expandFile, options.draftFileId, options.identityByFileId]);

  const collapsedFileIds = useMemo(
    () => new Set(options.files.filter((file) => isCollapsed(file.id)).map((file) => file.id)),
    [
      isCollapsed,
      options.draftFileId,
      options.files,
      options.identityByFileId,
      options.viewedFileIds,
      revision,
    ],
  );

  return { collapsedFileIds, isCollapsed, expandFile, toggleFileCollapsed, resetFileDisclosure };
}
