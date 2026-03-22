import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let cachedOutput: string | null = null;

  pi.on("before_agent_start", async (event, ctx) => {
    if (cachedOutput === null) {
      const result = await pi.exec("beans", ["prime"]);
      if (result.code !== 0) {
        ctx.ui.notify(`beans prime failed: ${result.stderr}`, "error");
        return;
      }
      cachedOutput = result.stdout.trim();
    }

    return {
      systemPrompt: event.systemPrompt + "\n\n" + cachedOutput,
    };
  });

  // Reset cache on all session transitions so beans prime re-runs
  const resetCache = async () => {
    cachedOutput = null;
  };

  pi.on("session_start", resetCache);
  pi.on("session_switch", resetCache);
  pi.on("session_fork", resetCache);
  pi.on("session_tree", resetCache);
  pi.on("session_compact", resetCache);
}
