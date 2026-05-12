import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { createWebExtractTool } from "./extract"
import { webFetchTool } from "./fetch"
import { createWebSearchTool } from "./search"

export default function piWebTools(pi: ExtensionAPI) {
  pi.registerTool(createWebSearchTool(pi))
  pi.registerTool(webFetchTool)
  pi.registerTool(createWebExtractTool(pi))
}
