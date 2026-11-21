/** Values the tool definition needs at registration. No mpl imports, so loading the extension stays cheap. */

import { homedir } from "node:os"
import { join } from "node:path"

/** Charts are written to <root>/<YYYY-MM-DD>/; answers may only display PNGs under it. */
export const MPL_CHARTS_ROOT = join(homedir(), ".pi", "agent", "work", "charts")

/** Theme for a spec without one, by pi's appearance. */
export const MPL_APPEARANCE_THEMES = {
  dark: "gruvbox-dark",
  light: "gruvbox-light",
} as const
/** Fallback when pi's appearance is unknown (no UI) or renderChart is called directly. */
export const MPL_DEFAULT_THEME = MPL_APPEARANCE_THEMES.dark

/** Figure methods a spec may call as "fig.<name>". replay.ts checks each one exists on Figure. */
export const MPL_FIGURE_METHOD_NAMES = [
  "text",
  "suptitle",
  "supxlabel",
  "supylabel",
  "subplots_adjust",
  "autofmt_xdate",
  "tight_layout",
  "colorbar",
] as const
