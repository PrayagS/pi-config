import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installContextSummary } from "./src/extension.js";

export default function contextSummary(pi: ExtensionAPI): void {
  installContextSummary(pi);
}
