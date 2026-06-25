import { useEffect, useState } from "react";
import type { IDockviewHeaderActionsProps } from "dockview";
import { syncPopoutChrome } from "../lib/popout";

/** Tab-bar controls on the right of every group header: maximize and pop-out-to-window.
 * Pops the group's ACTIVE panel into its own OS window via Dockview's popout group,
 * mirroring the theme chrome so it doesn't render colorless.
 */
export function RightHeaderActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, activePanel } = props;
  const [maximized, setMaximized] = useState(() => containerApi.hasMaximizedGroup());

  useEffect(() => {
    const d = containerApi.onDidMaximizedGroupChange(() =>
      setMaximized(containerApi.hasMaximizedGroup()),
    );
    return () => d.dispose();
  }, [containerApi]);

  const popOut = () => {
    if (!activePanel) return;
    let unsync: (() => void) | undefined;
    void containerApi.addPopoutGroup(activePanel, {
      onDidOpen: ({ window }) => {
        unsync = syncPopoutChrome(window);
      },
      onWillClose: () => {
        unsync?.();
        unsync = undefined;
      },
    });
  };

  const toggleMax = () => {
    if (!activePanel) return;
    if (containerApi.hasMaximizedGroup()) containerApi.exitMaximizedGroup();
    else containerApi.maximizeGroup(activePanel);
  };

  const btn =
    "flex h-6 w-6 items-center justify-center rounded text-term-muted hover:bg-term-border/60 hover:text-term-text";

  return (
    <div className="flex h-full items-center gap-0.5 px-1.5">
      <button onClick={toggleMax} title={maximized ? "Restore" : "Maximize"} className={btn}>
        {maximized ? "▣" : "▢"}
      </button>
      <button onClick={popOut} title="Open in new window" className={btn}>
        ⧉
      </button>
    </div>
  );
}
