export type { Extractor, ExtractResult } from "./types"

export { jina } from "./jina"
export { firecrawl } from "./firecrawl"
export { parallel } from "./parallel"
export { tavily } from "./tavily"
export { exa } from "./exa"
export { you } from "./you"
export { markdownNew } from "./markdown-new"

import { jina } from "./jina"
import { firecrawl } from "./firecrawl"
import { parallel } from "./parallel"
import { tavily } from "./tavily"
import { exa } from "./exa"
import { you } from "./you"
import { markdownNew } from "./markdown-new"
import type { Extractor } from "./types"

export const apiExtractors: Extractor[] = [
  jina,
  firecrawl,
  parallel,
  exa,
  tavily,
  you,
  markdownNew,
]
