import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { webExtractTool } from "./extract"
import { webFetchTool } from "./fetch"
import { createWebSearchTool } from "./search"

export default function piWebTools(pi: ExtensionAPI) {
  pi.registerTool(createWebSearchTool(pi))
  pi.registerTool(webFetchTool)
  pi.registerTool(webExtractTool)
}
