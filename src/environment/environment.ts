import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

export interface EnvironmentWriteOptions {
  /** Explicitly permit replacing an existing APP_KEY or output file. Defaults to false. */
  force?: boolean;
}

export interface ApplicationKeyUpdateResult {
  path: string;
  created: boolean;
}

export interface EnvironmentEncryptionResult {
  inputPath: string;
  outputPath: string;
  format: "bundle-env-v1";
}

/** This reports the supplied environment; it does not load or mutate process.env or .env. */
export function currentEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.APP_ENV || env.NODE_ENV || "development";
}

/** An explicit secret-returning API. Callers must not print this key unless explicitly requested. */
export function generateApplicationKey(): string {
  return `base64:${randomBytes(32).toString("base64")}`;
}

class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

function fail(message: string): never {
  throw new EnvironmentError(message);
}

// Never include input values, native error messages/causes, or decrypted content in errors.
async function sanitized<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError("Environment file operation failed; check project paths and permissions.");
  }
}

function validateOptions(options: EnvironmentWriteOptions): boolean {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Reflect.ownKeys(options).some(key => key !== "force")
    || (options.force !== undefined && typeof options.force !== "boolean")) {
    fail("Only the optional boolean force option is supported; paths are fixed to the project root.");
  }
  return options.force === true;
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function applicationKey(value: string): Buffer {
  // Only the canonical base64: encoding emitted by generateApplicationKey is supported.
  // Never accept passphrases, truncated keys, URL-safe encodings, or silent decoder coercion.
  if (typeof value !== "string" || !value.startsWith("base64:")) {
    fail("A canonical base64: encoded 32-byte key is required.");
  }
  const bytes = decodeBase64(value.slice(7));
  if (!bytes || bytes.length !== 32) fail("A canonical base64: encoded 32-byte key is required.");
  return bytes;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function validateRoot(root: string): Promise<string> {
  if (typeof root !== "string" || !root || root.includes("\0")) fail("An existing project directory is required.");
  const absolute = resolve(root);
  const base = parse(absolute).root;
  let parent = base;
  // Reject symlinks in the root itself AND its ancestors, rather than silently following them.
  for (const segment of absolute.slice(base.length).split(sep).filter(Boolean)) {
    parent = join(parent, segment);
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("Project root and parents must be real directories, not symlinks.");
  }
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) {
    fail("Project root and parents must be real directories, not symlinks.");
  }
  return absolute;
}

async function fileState(path: string): Promise<Stats | null> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("Environment paths must be regular files, not symlinks or other file types.");
  return info;
}

function sameState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}

async function assertUnchanged(path: string, expected: Stats | null): Promise<void> {
  const actual = await fileState(path);
  if (expected === null ? actual !== null : actual === null || !sameState(expected, actual)) {
    fail("Environment file changed during the operation; retry without concurrent file edits.");
  }
}

async function readRegular(path: string, state: Stats): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || !sameState(state, actual)) fail("Environment input changed during the operation.");
    const content = await handle.readFile();
    if (!sameState(actual, await handle.stat())) fail("Environment input changed during the operation.");
    return content;
  } finally {
    await handle.close();
  }
}

interface FileSnapshot { path: string; state: Stats | null }

/**
 * Publish a fully written 0600 file. link() makes absent-target publication exclusive;
 * rename() atomically replaces an explicitly authorized, revalidated existing target.
 * As with ordinary local generators, an untrusted process must not concurrently rename
 * project directories. Node does not expose directory-fd-relative rename/link operations.
 */
async function atomicWrite(root: string, destination: FileSnapshot, content: Buffer | string, input?: FileSnapshot): Promise<void> {
  await validateRoot(root);
  await assertUnchanged(destination.path, destination.state);
  if (input) await assertUnchanged(input.path, input.state);
  const temporary = join(root, `.bundle-env-${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const temporaryState = await handle.stat();
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await validateRoot(root);
    await assertUnchanged(destination.path, destination.state);
    if (input) await assertUnchanged(input.path, input.state);
    if (destination.state === null) {
      // Unlike rename(), link() can never clobber a target created after validation.
      await link(temporary, destination.path);
    } else {
      await rename(temporary, destination.path);
    }
  } finally {
    // Do not delete an entry substituted for our exclusively created temporary file.
    try {
      const info = await lstat(temporary);
      if (info.dev === temporaryState.dev && info.ino === temporaryState.ino && info.isFile()) await unlink(temporary);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function utf8(content: Buffer): string {
  try {
    // Keep any BOM so updates can preserve it exactly.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    fail("APP_KEY updates require a valid UTF-8 environment file.");
  }
}

/** A deliberately conservative, single-line dotenv subset, never a shell evaluator. */
function replaceKey(content: Buffer, key: string, force: boolean): string {
  const original = utf8(content);
  const bom = original.startsWith("﻿") ? "﻿" : "";
  const text = original.slice(bom.length);
  if (/\r(?!\n)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail("Unsupported environment file syntax; no APP_KEY update was written.");
  const pieces = text.split(/(\r\n|\n)/);
  let found = -1;
  let replacement = "";
  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index]!;
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const assignment = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/.exec(line);
    if (!assignment) fail("Unsupported environment file syntax; no APP_KEY update was written.");
    const value = assignment[4]!;
    let quote = "";
    let suffix = "";
    if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')([ \t]*(?:#.*)?)$/.exec(value);
      if (!quoted) fail("Unsupported environment file syntax; multiline values are not supported for APP_KEY updates.");
      quote = value[0]!;
      suffix = quoted[2]!;
    } else {
      const unquoted = /^(.*?)([ \t]*(?:#.*)?)$/.exec(value)!;
      if (/["'`]/.test(unquoted[1]!) || unquoted[1]!.endsWith("\\")) {
        fail("Unsupported environment file syntax; no APP_KEY update was written.");
      }
      suffix = unquoted[2]!;
    }
    if (assignment[2] !== "APP_KEY") continue;
    if (found !== -1) fail("Duplicate APP_KEY definitions are not supported; no update was written.");
    found = index;
    replacement = `${assignment[1]}APP_KEY${assignment[3]}${quote}${key}${quote}${suffix}`;
  }
  if (found !== -1) {
    if (!force) fail("APP_KEY already exists; explicit force is required to replace it.");
    pieces[found] = replacement;
    return bom + pieces.join("");
  }
  const newline = /\r\n|\n/.exec(text)?.[0] ?? "\n";
  if (!text) return `${bom}APP_KEY=${key}${newline}`;
  return bom + text + (text.endsWith("\n") ? "" : newline) + `APP_KEY=${key}` + (text.endsWith("\n") ? newline : "");
}

/**
 * Create/update only root/.env with a supplied canonical key. No key is returned or logged.
 * Existing APP_KEY (including an empty one) needs force; duplicates/multiline/ambiguous
 * dotenv syntax are refused without writes. This scaffolds APP_KEY only: it does not
 * install an application encryption, authentication, or key-rotation subsystem.
 */
export async function updateApplicationKey(root: string, key: string, options: EnvironmentWriteOptions = {}): Promise<ApplicationKeyUpdateResult> {
  return sanitized(async () => {
    const force = validateOptions(options);
    applicationKey(key);
    const directory = await validateRoot(root);
    const path = join(directory, ".env");
    const state = await fileState(path);
    const content = state ? await readRegular(path, state) : Buffer.alloc(0);
    const updated = replaceKey(content, key, force);
    await atomicWrite(directory, { path, state }, updated);
    return { path, created: state === null };
  });
}

const header = { format: "bundle-env", version: 1, cipher: "aes-256-gcm" } as const;
const authenticatedHeader = Buffer.from(JSON.stringify(header), "utf8");
const envelopeFields = ["format", "version", "cipher", "nonce", "tag", "ciphertext"];

function encrypt(content: Buffer, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(authenticatedHeader);
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  return JSON.stringify({ ...header, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }) + "\n";
}

function decrypt(content: Buffer, key: Buffer): Buffer {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(utf8(content));
  } catch {
    fail("Encrypted environment envelope is invalid or unsupported.");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).length !== envelopeFields.length
    || envelopeFields.some(field => !Object.hasOwn(envelope, field))
    || envelope.format !== header.format || envelope.version !== header.version || envelope.cipher !== header.cipher) {
    fail("Encrypted environment envelope is invalid or unsupported.");
  }
  const nonce = decodeBase64(envelope.nonce);
  const tag = decodeBase64(envelope.tag);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (!nonce || nonce.length !== 12 || !tag || tag.length !== 16 || !ciphertext) {
    fail("Encrypted environment envelope is invalid or unsupported.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(authenticatedHeader);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail("Environment decryption failed authentication; no output was written.");
  }
}

async function transformEnvironment(root: string, suppliedKey: string, options: EnvironmentWriteOptions, decrypting: boolean): Promise<EnvironmentEncryptionResult> {
  return sanitized(async () => {
    const force = validateOptions(options);
    const key = applicationKey(suppliedKey);
    const directory = await validateRoot(root);
    const inputPath = join(directory, decrypting ? ".env.encrypted" : ".env");
    const outputPath = join(directory, decrypting ? ".env" : ".env.encrypted");
    const inputState = await fileState(inputPath);
    const outputState = await fileState(outputPath);
    if (!inputState) fail("The required environment input file does not exist.");
    if (outputState && !force) fail("Environment output already exists; explicit force is required to replace it.");
    const content = await readRegular(inputPath, inputState);
    const output = decrypting ? decrypt(content, key) : encrypt(content, key);
    await atomicWrite(directory, { path: outputPath, state: outputState }, output, { path: inputPath, state: inputState });
    return { inputPath, outputPath, format: "bundle-env-v1" };
  });
}

/**
 * Encrypt root/.env to root/.env.encrypted with an explicitly supplied 32-byte key.
 * AES-256-GCM uses a fresh 12-byte nonce and authenticates the version/cipher header.
 * This is Bundle's versioned envelope, NOT Laravel-compatible ciphertext. The input
 * is retained, output requires force to replace, and results contain no secrets.
 */
export async function encryptEnvironment(root: string, key: string, options: EnvironmentWriteOptions = {}): Promise<EnvironmentEncryptionResult> {
  return transformEnvironment(root, key, options, false);
}

/** Authenticate the Bundle envelope before atomically publishing .env; retain .env.encrypted. */
export async function decryptEnvironment(root: string, key: string, options: EnvironmentWriteOptions = {}): Promise<EnvironmentEncryptionResult> {
  return transformEnvironment(root, key, options, true);
}
