import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig } from "../src/config.js";

const directories: string[] = [];
async function location() {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-summary-config-"));
  directories.push(directory);
  return { directory, file: join(directory, "settings.json") };
}
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

describe("configuration", () => {
  test("missing settings use automatic defaults without writing a file", async () => {
    const { file, directory } = await location();
    const loaded = await loadConfig(file);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.config.mode).toBe("auto");
    expect(loaded.warning).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });
  test("invalid or unreadable settings fail closed without modifying their bytes", async () => {
    const { file } = await location();
    await writeFile(file, '{"unexpected":true}');
    const loaded = await loadConfig(file);
    expect(loaded.config.enabled).toBe(false);
    expect(loaded.warning).toContain("disabled");
    expect(await readFile(file, "utf8")).toBe('{"unexpected":true}');
    expect((await loadConfig(join(file, "not-a-file"))).config.enabled).toBe(false);
  });
  test("atomic explicit save roundtrips strict settings, private mode, no temporary files", async () => {
    const { file, directory } = await location();
    const config = validateConfig({ mode: "manual", model: "provider/model/variant", allowedTools: [" read ", "read", "bash"] });
    await saveConfig(file, config);
    expect((await loadConfig(file)).config).toEqual(config);
    expect(config.allowedTools).toEqual(["read", "bash"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });
  test("concurrent explicit writes remain complete and serialized", async () => {
    const { file, directory } = await location();
    await Promise.all([saveConfig(file, validateConfig({ mode: "manual" })), saveConfig(file, validateConfig({ enabled: false }))]);
    expect((await loadConfig(file)).config).toEqual(validateConfig({ enabled: false }));
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });
  test("invalid saves leave an existing file unchanged", async () => {
    const { file } = await location();
    await saveConfig(file, validateConfig({}));
    const before = await readFile(file, "utf8");
    await expect(saveConfig(file, { ...DEFAULT_CONFIG, maxSessionCalls: -1 })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(before);
  });
  test("validation rejects unknown/inherited keys, nonobjects, invalid enums and budgets", () => {
    for (const value of [null, [], "auto", new Date(), { constructor: "unsafe" }, JSON.parse('{"__proto__":{}}'), { typo: 1 }, { enabled: "true" }, { mode: "later" }, { model: "unqualified" }, { reasoning: "extreme" }, { maxSessionCalls: 0 }, { maxInputChars: Infinity }, { maxSourcesPerBatch: 1.5 }, { maxBatchesPerRun: 9 }, { timeoutMs: 1 }, { minBatchChars: 5000, maxInputChars: 1000 }, { minSavingsRatio: NaN }, { minSavingsRatio: 1 }, { allowedTools: [1] }, { protectedTools: [""] }]) {
      expect(() => validateConfig(value)).toThrow();
    }
    expect(validateConfig(Object.create(null))).toEqual(DEFAULT_CONFIG);
  });
  test("returned settings never share mutable default tool arrays", () => {
    const config = validateConfig({});
    config.allowedTools.push("write");
    expect(DEFAULT_CONFIG.allowedTools).not.toContain("write");
    expect(validateConfig({}).allowedTools).not.toContain("write");
  });
});
