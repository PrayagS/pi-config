/**
 * AWS Bedrock Application Inference Profile Extension
 *
 * Works around the built-in Bedrock provider's model ID substring checks by
 * registering models with standard Bedrock model IDs (so capability checks for
 * adaptive thinking, prompt caching, thinking signatures, etc. all pass), then
 * swapping the modelId to the actual ARN via onPayload right before the API call.
 *
 * Set one or more env vars to register models:
 *   PI_BEDROCK_OPUS_INFERENCE_PROFILE_ARN=arn:aws:bedrock:region:account:application-inference-profile/<uuid>
 *   PI_BEDROCK_SONNET_INFERENCE_PROFILE_ARN=arn:aws:bedrock:region:account:application-inference-profile/<uuid>
 *   PI_BEDROCK_HAIKU_INFERENCE_PROFILE_ARN=arn:aws:bedrock:region:account:application-inference-profile/<uuid>
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-bedrock-inference-profiles
 */

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Model Definitions
// =============================================================================

interface ProfileModel {
	/** Standard Bedrock model ID — ensures built-in capability checks pass */
	id: string;
	name: string;
	envVar: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

const PROFILE_MODELS: ProfileModel[] = [
	{
		id: "anthropic.claude-opus-4-6-v1",
		name: "Claude Opus 4.6 (Profile)",
		envVar: "PI_BEDROCK_OPUS_INFERENCE_PROFILE_ARN",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "anthropic.claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Profile)",
		envVar: "PI_BEDROCK_SONNET_INFERENCE_PROFILE_ARN",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "anthropic.claude-haiku-4-5-20251001-v1:0",
		name: "Claude Haiku 4.5 (Profile)",
		envVar: "PI_BEDROCK_HAIKU_INFERENCE_PROFILE_ARN",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
];

// Map from model ID to the env var that holds its ARN
const MODEL_ENV_MAP = new Map(PROFILE_MODELS.map((m) => [m.id, m.envVar]));

const DEBUG = process.env.PI_BEDROCK_INFERENCE_PROFILES_DEBUG === "1";
const TAG = "[bedrock-inference-profiles]";

// =============================================================================
// Capability Checks (mirrors amazon-bedrock.ts logic)
// =============================================================================

function isClaudeModel(modelId: string): boolean {
	return modelId.includes("anthropic.claude") || modelId.includes("anthropic/claude");
}

function checksAdaptiveThinking(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6")
	);
}

function checksPromptCaching(model: ProfileModel): boolean {
	if (model.cost.cacheRead || model.cost.cacheWrite) return true;
	const id = model.id.toLowerCase();
	if (id.includes("claude") && (id.includes("-4-") || id.includes("-4."))) return true;
	if (id.includes("claude-3-7-sonnet")) return true;
	if (id.includes("claude-3-5-haiku")) return true;
	return false;
}

function checksThinkingSignature(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return id.includes("anthropic.claude") || id.includes("anthropic/claude");
}

function checksInterleavedThinking(modelId: string): boolean {
	// Interleaved thinking is enabled when Claude is detected but adaptive thinking is NOT supported
	return isClaudeModel(modelId) && !checksAdaptiveThinking(modelId);
}

function logCapabilityChecks(model: ProfileModel): void {
	const id = model.id;
	console.log(`${TAG} ${model.name} (${id})`);
	console.log(`${TAG}   Claude detected:       ${isClaudeModel(id)}`);
	console.log(`${TAG}   Adaptive thinking:      ${checksAdaptiveThinking(id)}`);
	console.log(`${TAG}   Prompt caching:         ${checksPromptCaching(model)}`);
	console.log(`${TAG}   Thinking signature:     ${checksThinkingSignature(id)}`);
	console.log(`${TAG}   Interleaved thinking:   ${checksInterleavedThinking(id)}`);
}

// =============================================================================
// Stream Function
// =============================================================================

/**
 * Wraps the built-in Bedrock streaming by:
 * 1. Setting api to "bedrock-converse-stream" so the built-in provider handles the call
 * 2. Injecting an onPayload callback that replaces modelId with the actual ARN
 */
export function streamBedrockProfile(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const envVar = MODEL_ENV_MAP.get(model.id);
			if (!envVar) throw new Error(`Unknown model: ${model.id}`);

			const arn = process.env[envVar];
			if (!arn) throw new Error(`${envVar} is not set`);

			// Delegate to the built-in Bedrock provider by setting the correct api
			const delegateModel: Model<Api> = { ...model, api: "bedrock-converse-stream" as Api };

			// Wrap onPayload to intercept, log, and replace modelId with the actual ARN
			const originalOnPayload = options?.onPayload;
			const wrappedOptions: SimpleStreamOptions = {
				...options,
				onPayload: (commandInput: unknown) => {
					const payload = commandInput as Record<string, unknown>;

					if (DEBUG) {
						const additional = payload.additionalModelRequestFields as Record<string, unknown> | undefined;
						console.log(`${TAG} onPayload intercepted:`);
						console.log(`${TAG}   modelId (before swap):   ${payload.modelId}`);
						console.log(`${TAG}   modelId (after swap):    ${arn}`);
						if (additional) {
							console.log(`${TAG}   thinking config:         ${JSON.stringify(additional.thinking)}`);
							if (additional.output_config) {
								console.log(`${TAG}   output_config:           ${JSON.stringify(additional.output_config)}`);
							}
							if (additional.anthropic_beta) {
								console.log(`${TAG}   anthropic_beta:          ${JSON.stringify(additional.anthropic_beta)}`);
							}
						} else {
							console.log(`${TAG}   thinking config:         (none — reasoning not requested)`);
						}

						// Check for cache points in system/messages
						const system = payload.system as unknown[] | undefined;
						const hasCacheInSystem = system?.some(
							(b: any) => b.cachePoint !== undefined,
						);
						const messages = payload.messages as unknown[] | undefined;
						const lastMsg = messages?.[messages.length - 1] as Record<string, unknown> | undefined;
						const lastMsgContent = lastMsg?.content as unknown[] | undefined;
						const hasCacheInMessages = lastMsgContent?.some(
							(b: any) => b.cachePoint !== undefined,
						);
						console.log(`${TAG}   cache point (system):    ${!!hasCacheInSystem}`);
						console.log(`${TAG}   cache point (messages):  ${!!hasCacheInMessages}`);
					}

					payload.modelId = arn;
					originalOnPayload?.(commandInput);
				},
			};

			const innerStream = streamSimple(delegateModel, context, wrappedOptions);

			for await (const event of innerStream) stream.push(event);
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Apply default AWS profile if AWS_PROFILE is not explicitly set.
	// Set PI_BEDROCK_AWS_PROFILE in your shell rc / env to use a fixed profile
	// without having to export AWS_PROFILE every session.
	if (!process.env.AWS_PROFILE) {
		const fallback = process.env.PI_BEDROCK_AWS_PROFILE ?? "default";
		process.env.AWS_PROFILE = fallback;
		if (DEBUG) console.log(`${TAG} AWS_PROFILE not set — using fallback: "${fallback}"`);
	}

	// Only register models whose ARN env var is set
	const configuredModels = PROFILE_MODELS.filter((m) => process.env[m.envVar]);

	if (configuredModels.length === 0) {
		console.warn(
			"[bedrock-inference-profiles] No ARN env vars configured. Set PI_BEDROCK_OPUS_INFERENCE_PROFILE_ARN, PI_BEDROCK_SONNET_INFERENCE_PROFILE_ARN, or PI_BEDROCK_HAIKU_INFERENCE_PROFILE_ARN.",
		);
		return;
	}

	if (DEBUG) {
		console.log(`${TAG} Capability check results for synthetic model IDs:`);
		for (const m of configuredModels) {
			logCapabilityChecks(m);
			console.log(`${TAG}   ARN:                    ${process.env[m.envVar]}`);
		}
		console.log(`${TAG} Set PI_BEDROCK_INFERENCE_PROFILES_DEBUG=0 to suppress these logs.`);
	}

	pi.registerProvider("bedrock-inference-profiles", {
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		apiKey: "AWS_PROFILE",
		api: "bedrock-inference-profiles-api" as Api,
		models: configuredModels.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
		streamSimple: streamBedrockProfile,
	});
}
