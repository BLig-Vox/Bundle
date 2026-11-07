import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { cacheConfiguration, clearConfiguration, loadConfiguration, publishConfiguration, type ConfigurationValue } from "../configuration/configuration.ts";
import { currentEnvironment, decryptEnvironment, encryptEnvironment, generateApplicationKey, updateApplicationKey } from "../environment/environment.ts";
import { publishConfigurationResources } from "../publication/publish.ts";

interface OperationsContext {
  root: string;
  env: Record<string, string | undefined>;
  output: (text: string) => void;
  signal?: AbortSignal;
}

const sensitive = /password|passwd|secret|token|credential|private|api.?key|app.?key|authorization|auth|dsn|url|uri/i;
function redact(value: ConfigurationValue, secrets: string[], key = ""): ConfigurationValue {
  if (sensitive.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, secrets, name)]));
  if (typeof value === "string") {
    if (/[a-z][a-z\d+.-]*:\/\/[^\s/@]+@/i.test(value) || secrets.some(secret => value.includes(secret))) return "[REDACTED]";
  }
  return value;
}

/** Register bounded Bundle operations; encrypted files use Bundle's own AES-256-GCM envelope. */
export function registerOperations(program: Command, context: OperationsContext): void {
  const { root, env, output } = context;
  const force = () => program.opts().force === true;
  const safeConfiguration = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch { throw new Error("Configuration operation failed; inspect trusted configuration and paths."); }
  };
  program.command("config:show [name]").description("Show configuration with sensitive fields redacted (optional dot path)").action(async (name?: string) => {
    const secrets = Object.entries({ ...process.env, ...env })
      .filter(([key, value]) => sensitive.test(key) && !!value)
      .map(([, value]) => value!);
    let value: ConfigurationValue = redact(await safeConfiguration(() => loadConfiguration(root)), secrets);
    if (name) {
      for (const part of name.split(".")) {
        if (!part || !value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part)) throw new Error("Configuration key not found.");
        value = value[part]!;
      }
    }
    output(JSON.stringify(value, null, 2));
  });
  program.command("config:cache").description("Cache trusted configuration modules; --force replaces an existing cache").action(async () => {
    try {
      await lstat(join(root, "bootstrap", "cache", "config.json"));
      if (!force()) throw new Error("Configuration cache exists; pass --force to replace it.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await safeConfiguration(() => cacheConfiguration(root, { overwrite: force() }));
    output("Configuration cached.");
  });
  program.command("config:clear").description("Remove the configuration cache").action(async () => {
    output(await clearConfiguration(root) ? "Configuration cache cleared." : "No configuration cache exists.");
  });
  program.command("config:publish").description("Publish built-in or explicitly selected configuration without overwriting")
    .option("--package <name>", "Select a package")
    .option("--tag <tag>", "Select a tag")
    .option("--all", "Select all configuration assets")
    .action(async (options: {package?: string; tag?: string; all?: boolean}) => {
      try {
        context.signal?.throwIfAborted();
        if (options.package !== undefined || options.tag !== undefined || options.all !== undefined) {
          const selection = { ...(options.package !== undefined ? {package: options.package} : {}), ...(options.tag !== undefined ? {tag: options.tag} : {}), ...(options.all !== undefined ? {all: options.all} : {}) };
          const result = await publishConfigurationResources({root, selection, signal: context.signal});
          context.signal?.throwIfAborted();
          output(JSON.stringify(result));
        } else {
          await publishConfiguration(root);
          context.signal?.throwIfAborted();
          output("Configuration published.");
        }
      } catch { throw new Error("Configuration publication failed."); }
    });
  program.command("env").description("Show the supplied application environment").action(() => output(currentEnvironment(env)));
  program.command("key:generate").description("Generate an APP_KEY in .env; --force replaces an existing key")
    .option("--show", "Print a new key without writing .env")
    .action(async (options: { show?: boolean }) => {
      const key = generateApplicationKey();
      if (options.show) output(key);
      else { await updateApplicationKey(root, key, { force: force() }); output("Application key updated."); }
    });
  for (const decrypt of [false, true]) {
    program.command(decrypt ? "env:decrypt" : "env:encrypt")
      .description(`${decrypt ? "Decrypt" : "Encrypt"} .env using Bundle AES-256-GCM (not Laravel ciphertext); --force replaces output`)
      .option("--key <key>", "Canonical base64: 32-byte key; alternatively set BUNDLE_ENV_ENCRYPTION_KEY")
      .action(async (options: { key?: string }) => {
        const key = options.key ?? env.BUNDLE_ENV_ENCRYPTION_KEY;
        if (!key) throw new Error("An encryption key is required via --key or BUNDLE_ENV_ENCRYPTION_KEY.");
        await (decrypt ? decryptEnvironment : encryptEnvironment)(root, key, { force: force() });
        output(decrypt ? "Environment decrypted." : "Environment encrypted.");
      });
  }
}
