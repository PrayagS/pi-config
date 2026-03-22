/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig, getLastSeatbeltProfile } from "@carderne/sandbox-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@mariozechner/pi-coding-agent";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["/Users"],
		allowRead: [".", "~/.config", "~/.local"],
		allowWrite: [".", "/tmp"],
		allowGitConfig: true,
	},
};

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function mergeArrays(base: string[] | undefined, override: string[] | undefined): string[] {
	return [...new Set([...(base ?? []), ...(override ?? [])])];
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = {
			allowedDomains: mergeArrays(base.network?.allowedDomains, overrides.network.allowedDomains),
			deniedDomains: mergeArrays(base.network?.deniedDomains, overrides.network.deniedDomains),
		};
	}
	if (overrides.filesystem) {
		result.filesystem = {
			denyRead: mergeArrays(base.filesystem?.denyRead, overrides.filesystem.denyRead),
			allowRead: mergeArrays(base.filesystem?.allowRead, overrides.filesystem.allowRead),
			allowWrite: mergeArrays(base.filesystem?.allowWrite, overrides.filesystem.allowWrite),
			denyWrite: mergeArrays(base.filesystem?.denyWrite, overrides.filesystem.denyWrite),
			allowGitConfig: overrides.filesystem.allowGitConfig ?? base.filesystem?.allowGitConfig,
		};
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;

	// Session-only path additions (not persisted to config files)
	const sessionAllowRead: string[] = [];
	const sessionAllowWrite: string[] = [];

	/** Build the effective runtime config by merging file config + session additions */
	function getEffectiveConfig(cwd: string): SandboxConfig {
		const config = loadConfig(cwd);
		if (sessionAllowRead.length > 0) {
			config.filesystem = {
				...config.filesystem,
				allowRead: mergeArrays(config.filesystem?.allowRead, sessionAllowRead),
			};
		}
		if (sessionAllowWrite.length > 0) {
			config.filesystem = {
				...config.filesystem,
				allowWrite: mergeArrays(config.filesystem?.allowWrite, sessionAllowWrite),
			};
		}
		return config;
	}

	/** Push the effective config into the running SandboxManager */
	function syncRuntimeConfig(cwd: string): void {
		if (!sandboxInitialized) return;
		const config = getEffectiveConfig(cwd);
		SandboxManager.updateConfig({
			network: config.network,
			filesystem: config.filesystem,
		});
	}

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
			);
			ctx.ui.notify("Sandbox initialized", "info");
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	pi.registerCommand("sandbox", {
		description: "Manage sandbox: /sandbox, /sandbox toggle, /sandbox add <path>, /sandbox remove <path>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";

			if (subcommand === "toggle") {
				if (sandboxEnabled) {
					// Disable
					if (sandboxInitialized) {
						try {
							await SandboxManager.reset();
						} catch {
							// Ignore cleanup errors
						}
					}
					sandboxEnabled = false;
					sandboxInitialized = false;
					ctx.ui.setStatus("sandbox", "");
					ctx.ui.notify("Sandbox disabled", "info");
				} else {
					// Enable
					const config = getEffectiveConfig(ctx.cwd);
					const platform = process.platform;
					if (platform !== "darwin" && platform !== "linux") {
						ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
						return;
					}

					try {
						const configExt = config as unknown as {
							ignoreViolations?: Record<string, string[]>;
							enableWeakerNestedSandbox?: boolean;
						};

						await SandboxManager.initialize({
							network: config.network,
							filesystem: config.filesystem,
							ignoreViolations: configExt.ignoreViolations,
							enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
						});

						sandboxEnabled = true;
						sandboxInitialized = true;

						const networkCount = config.network?.allowedDomains?.length ?? 0;
						const writeCount = config.filesystem?.allowWrite?.length ?? 0;
						ctx.ui.setStatus(
							"sandbox",
							ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
						);
						ctx.ui.notify("Sandbox enabled", "info");
					} catch (err) {
						ctx.ui.notify(
							`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
							"error",
						);
					}
				}
				return;
			}

			if (subcommand === "add") {
				const pathArg = parts.slice(1).join(" ");
				if (!pathArg) {
					ctx.ui.notify("Usage: /sandbox add <path>", "warning");
					return;
				}
				if (!sandboxEnabled) {
					ctx.ui.notify("Sandbox is disabled. Enable it first with /sandbox toggle", "warning");
					return;
				}

				const choice = await ctx.ui.select(`Grant access for "${pathArg}"`, [
					"Allow read",
					"Allow write",
					"Allow read + write",
				]);
				if (!choice) return;

				if (choice.includes("read")) {
					if (!sessionAllowRead.includes(pathArg)) sessionAllowRead.push(pathArg);
				}
				if (choice.includes("write")) {
					if (!sessionAllowWrite.includes(pathArg)) sessionAllowWrite.push(pathArg);
				}

				syncRuntimeConfig(ctx.cwd);

				const granted = choice.replace("Allow ", "");
				ctx.ui.notify(`Granted ${granted} access for "${pathArg}" (session only)`, "info");
				return;
			}

			if (subcommand === "remove") {
				const pathArg = parts.slice(1).join(" ");
				if (!pathArg) {
					ctx.ui.notify("Usage: /sandbox remove <path>", "warning");
					return;
				}
				if (!sandboxEnabled) {
					ctx.ui.notify("Sandbox is disabled", "warning");
					return;
				}

				const readIdx = sessionAllowRead.indexOf(pathArg);
				const writeIdx = sessionAllowWrite.indexOf(pathArg);

				if (readIdx === -1 && writeIdx === -1) {
					ctx.ui.notify(
						`"${pathArg}" is not in session allowances. Only session-added paths can be removed.`,
						"warning",
					);
					return;
				}

				const removed: string[] = [];
				if (readIdx !== -1) {
					sessionAllowRead.splice(readIdx, 1);
					removed.push("read");
				}
				if (writeIdx !== -1) {
					sessionAllowWrite.splice(writeIdx, 1);
					removed.push("write");
				}

				syncRuntimeConfig(ctx.cwd);

				ctx.ui.notify(`Removed ${removed.join(" + ")} access for "${pathArg}"`, "info");
				return;
			}

			// Default: show configuration
			const config = getEffectiveConfig(ctx.cwd);
			const lines = [
				`Sandbox: ${sandboxEnabled ? "enabled" : "disabled"}`,
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Read: ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
				`  Allow Git Config: ${config.filesystem?.allowGitConfig ?? false}`,
				...(sessionAllowRead.length > 0 ? [`  Session Read: ${sessionAllowRead.join(", ")}`] : []),
				...(sessionAllowWrite.length > 0 ? [`  Session Write: ${sessionAllowWrite.join(", ")}`] : []),
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
