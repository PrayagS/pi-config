/**
 * Test script for Bedrock Application Inference Profile extension
 * Run: npx tsx test.ts [model-id] [--thinking]
 *
 * Requires at least one ARN env var to be set:
 *   PI_BEDROCK_OPUS_4_5_INFERENCE_PROFILE_ARN,
 *   PI_BEDROCK_OPUS_4_6_INFERENCE_PROFILE_ARN,
 *   PI_BEDROCK_OPUS_4_7_INFERENCE_PROFILE_ARN,
 *   PI_BEDROCK_SONNET_INFERENCE_PROFILE_ARN, or
 *   PI_BEDROCK_HAIKU_INFERENCE_PROFILE_ARN
 *
 * Examples:
 *   PI_BEDROCK_SONNET_INFERENCE_PROFILE_ARN="arn:aws:bedrock:..." npx tsx test.ts
 *   PI_BEDROCK_OPUS_4_7_INFERENCE_PROFILE_ARN="arn:aws:bedrock:..." npx tsx test.ts anthropic.claude-opus-4-7 --thinking
 *   PI_BEDROCK_OPUS_4_5_INFERENCE_PROFILE_ARN="arn:aws:bedrock:..." npx tsx test.ts anthropic.claude-opus-4-5-20251101-v1:0 --thinking
 */

import {
  type Api,
  type Context,
  type Model,
  registerApiProvider,
  streamSimple,
} from "@mariozechner/pi-ai"
import { streamBedrockProfile } from "./index.js"

const ALL_MODELS = [
  {
    id: "anthropic.claude-opus-4-5-20251101-v1:0",
    name: "Claude Opus 4.5 (Profile)",
    envVar: "PI_BEDROCK_OPUS_4_5_INFERENCE_PROFILE_ARN",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "anthropic.claude-opus-4-6-v1",
    name: "Claude Opus 4.6 (Profile)",
    envVar: "PI_BEDROCK_OPUS_4_6_INFERENCE_PROFILE_ARN",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7 (Profile)",
    envVar: "PI_BEDROCK_OPUS_4_7_INFERENCE_PROFILE_ARN",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "anthropic.claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Profile)",
    envVar: "PI_BEDROCK_SONNET_INFERENCE_PROFILE_ARN",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic.claude-haiku-4-5-20251001-v1:0",
    name: "Claude Haiku 4.5 (Profile)",
    envVar: "PI_BEDROCK_HAIKU_INFERENCE_PROFILE_ARN",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
]

const MODEL_MAP = new Map(ALL_MODELS.map((m) => [m.id, m]))

async function main() {
  const modelId = process.argv[2] || "anthropic.claude-sonnet-4-6"
  const useThinking = process.argv.includes("--thinking")

  const cfg = MODEL_MAP.get(modelId)
  if (!cfg) {
    console.error(`Unknown model: ${modelId}`)
    console.error("Available:", ALL_MODELS.map((m) => m.id).join(", "))
    process.exit(1)
  }

  const arn = process.env[cfg.envVar]
  if (!arn) {
    console.error(`${cfg.envVar} is not set. Export it first:`)
    console.error(
      `  export ${cfg.envVar}="arn:aws:bedrock:us-east-1:123456:application-inference-profile/abc"`
    )
    process.exit(1)
  }

  // Register the bedrock-profiles-api provider
  registerApiProvider({
    api: "bedrock-profiles-api" as Api,
    stream: streamBedrockProfile,
    streamSimple: streamBedrockProfile,
  })

  // Create model
  const model: Model<Api> = {
    id: cfg.id,
    name: cfg.name,
    api: "bedrock-profiles-api" as Api,
    provider: "bedrock-profiles",
    reasoning: cfg.reasoning,
    input: cfg.input,
    cost: cfg.cost,
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
  }

  const context: Context = {
    messages: [
      {
        role: "user",
        content: "Say hello in exactly 3 words.",
        timestamp: Date.now(),
      },
    ],
  }

  console.log(`Model: ${model.id}, ARN: ${arn}, Thinking: ${useThinking}`)

  const stream = streamSimple(model, context, {
    maxTokens: 100,
    reasoning: useThinking ? "low" : undefined,
  })

  for await (const event of stream) {
    if (event.type === "thinking_start") console.log("[Thinking]")
    else if (event.type === "thinking_delta") process.stdout.write(event.delta)
    else if (event.type === "thinking_end") console.log("\n[/Thinking]\n")
    else if (event.type === "text_delta") process.stdout.write(event.delta)
    else if (event.type === "error")
      console.error("\nError:", event.error.errorMessage)
    else if (event.type === "done")
      console.log("\n\nDone!", event.reason, event.message.usage)
  }
}

main().catch(console.error)
