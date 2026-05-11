import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { createWebSearchTool } from "./search"
import { webFetchTool } from "./fetch"

export default function piWebTools(pi: ExtensionAPI) {
  pi.registerTool(createWebSearchTool(pi))
  pi.registerTool(webFetchTool)
}
