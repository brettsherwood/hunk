import type { DiffFile } from "../../../core/changeset/model";
import { MouseButton, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import {
  fileHeaderReviewControls,
  fileHeaderStats,
  fitFileHeaderLabel,
  type FileHeaderReviewPresentation,
} from "../../lib/fileHeader";
import type { AppTheme } from "../../themes";

interface DiffFileHeaderRowProps {
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  theme: AppTheme;
  onSelect?: () => void;
  reviewPresentation?: FileHeaderReviewPresentation;
  canCollapse?: boolean;
  onToggleViewed?: () => void;
  onToggleCollapsed?: () => void;
  onPointerActionStart?: () => void;
}

/** Render one file header row in the review stream or sticky overlay. */
export function DiffFileHeaderRow({
  file,
  headerLabelWidth,
  headerStatsWidth,
  theme,
  onSelect,
  reviewPresentation,
  canCollapse = true,
  onToggleViewed,
  onToggleCollapsed,
  onPointerActionStart,
}: DiffFileHeaderRowProps) {
  const { additionsText, deletionsText } = fileHeaderStats(file);
  const controls = fileHeaderReviewControls(reviewPresentation);
  const { filename, stateLabel } = fitFileHeaderLabel(
    file,
    Math.max(0, headerLabelWidth - controls.width),
  );

  /** Give control clicks ownership before the surrounding pane can acquire a text drag. */
  const beginControl = (event: TuiMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button === MouseButton.LEFT) onPointerActionStart?.();
  };
  const activateControl = (event: TuiMouseEvent, action?: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button === MouseButton.LEFT) action?.();
  };

  return (
    <box
      style={{
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
      }}
      onMouseUp={(event) => {
        if (event.button === MouseButton.LEFT) onSelect?.();
      }}
    >
      {/* Clicking the file header jumps the main stream selection without collapsing to a single-file view. */}
      <box style={{ flexDirection: "row" }}>
        {reviewPresentation ? (
          <box
            style={{ height: 1, width: 2 }}
            onMouseDown={beginControl}
            onMouseUp={(event) =>
              activateControl(event, canCollapse ? onToggleCollapsed : undefined)
            }
          >
            <text fg={canCollapse ? theme.muted : theme.border}>{controls.disclosure}</text>
          </box>
        ) : null}
        <text fg={theme.text}>{filename}</text>
        {stateLabel && <text fg={theme.muted}>{stateLabel}</text>}
      </box>
      <box
        style={{
          width: headerStatsWidth + (reviewPresentation ? controls.viewed.length : 0),
          height: 1,
          flexShrink: 0,
          flexDirection: "row",
          justifyContent: "flex-end",
        }}
      >
        {reviewPresentation ? (
          <box
            style={{ height: 1, width: controls.viewed.length, flexShrink: 0 }}
            onMouseDown={beginControl}
            onMouseUp={(event) =>
              activateControl(
                event,
                canCollapse || reviewPresentation.viewed ? onToggleViewed : undefined,
              )
            }
          >
            <text fg={reviewPresentation.viewed ? theme.accent : theme.muted}>
              {controls.viewed}
            </text>
          </box>
        ) : null}
        {/* Pad counts inside their own column so their width cannot move Viewed. */}
        <box
          style={{
            width: headerStatsWidth,
            height: 1,
            flexShrink: 0,
            flexDirection: "row",
            justifyContent: "flex-end",
          }}
        >
          <text fg={theme.badgeAdded}>{additionsText}</text>
          <text fg={theme.muted}> </text>
          <text fg={theme.badgeRemoved}>{deletionsText}</text>
          <text fg={theme.muted}> </text>
        </box>
      </box>
    </box>
  );
}
