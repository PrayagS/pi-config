# custom-provider-bedrock-inference-profiles

Pi extension that registers Claude models backed by AWS Bedrock application inference profile ARNs.

Purpose: keep Pi's built-in Bedrock capability checks working by registering standard Bedrock model IDs, then swapping request `modelId` to configured inference profile ARN right before API call.

## Supported env vars

- `PI_BEDROCK_OPUS_4_5_INFERENCE_PROFILE_ARN`
- `PI_BEDROCK_OPUS_4_6_INFERENCE_PROFILE_ARN`
- `PI_BEDROCK_OPUS_4_7_INFERENCE_PROFILE_ARN`
- `PI_BEDROCK_SONNET_INFERENCE_PROFILE_ARN`
- `PI_BEDROCK_HAIKU_INFERENCE_PROFILE_ARN`

Optional:

- `PI_BEDROCK_DISABLE_ADAPTIVE_THINKING=1`
- `PI_BEDROCK_INFERENCE_PROFILES_DEBUG=1`

## What it handles

- model registration for Claude Opus, Sonnet, Haiku variants
- capability flags for reasoning, prompt caching, thinking signatures, interleaved thinking
- payload rewriting from standard Bedrock model ID to ARN
- Bedrock beta header tweaks for specific model families
