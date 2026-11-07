import type { Command } from "commander";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { checkedRouteFile } from "../http/route-definitions.ts";
import { defineChannels, isDefinedChannels, type ChannelDefinitions } from "../broadcasting/definitions.ts";

const NO_CHANNELS: ChannelDefinitions = Object.freeze([]);

/** Load only the explicit trusted root channels.ts registry; absent registration is empty. */
export async function loadApplicationChannels(root: string): Promise<ChannelDefinitions> {
  const canonicalRoot = await realpath(root);
  let file: string;
  try { file = await checkedRouteFile(canonicalRoot, "channels.ts"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return NO_CHANNELS;
    throw error;
  }
  const source = await import(pathToFileURL(file).href);
  if (!isDefinedChannels(source.default)) throw new Error("channels.ts must default export defineChannels([...])");
  return defineChannels(source.default);
}

export function registerChannels(program: Command, context: { root: string; output: (text: string) => void }): void {
  program.command("channel:list").description("List registered broadcast channel names")
    .option("--json", "Print structured channel metadata")
    .action(async (options: { json?: boolean }) => {
      const channels = await loadApplicationChannels(context.root);
      context.output(options.json ? JSON.stringify({ channels }, null, 2) : channels.length ? channels.map(channel => channel.name).join("\n") : "No channels.");
    });
}
