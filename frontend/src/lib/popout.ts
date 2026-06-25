/** Mirror the terminal's theme chrome into a Dockview popout window.
 *
 * Dockview copies the parent document's CSS *rules* into the popout window, but not the
 * `<html>` attributes our theme tokens hang off (`data-theme`, `data-scheme`, `dir`,
 * `lang`) nor the inline `--term-accent` override. Without them the copied
 * `:root[data-theme="dark"] { --term-bg: … }` rules never match and the window renders
 * colorless. We copy those attributes on open and keep them in sync while the window
 * lives, so toggling theme / scheme / accent / language updates the popout too.
 */

import { useSettings } from "../state/settings";

const MIRRORED_ATTRS = ["data-theme", "data-scheme", "dir", "lang"] as const;

export function syncPopoutChrome(win: Window): () => void {
  const src = document.documentElement;

  const apply = () => {
    const dst = win.document?.documentElement;
    if (!dst) return;
    for (const attr of MIRRORED_ATTRS) {
      const v = src.getAttribute(attr);
      if (v != null) dst.setAttribute(attr, v);
      else dst.removeAttribute(attr);
    }
    const accent = src.style.getPropertyValue("--term-accent");
    if (accent) dst.style.setProperty("--term-accent", accent);
    else dst.style.removeProperty("--term-accent");
  };

  apply();
  // zustand vanilla subscribe — fires on any settings change (theme/scheme/accent/lang).
  const unsub = useSettings.subscribe(apply);
  return unsub;
}
