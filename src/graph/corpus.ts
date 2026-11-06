import { createHash } from "node:crypto";

export interface Location {
  path: string;
  startLine: number;
  endLine: number;
}

export interface Section {
  id: string;
  parentId: string;
  level: number;
  title: string;
  location: Location;
}

export interface Item {
  id: string;
  sectionId: string;
  title: string;
  completed: boolean;
  location: Location;
}

export interface Content {
  id: string;
  parentId: string;
  text: string;
  location: Location;
}

export interface Example extends Content {
  language: string;
}

export interface Source extends Content {
  url: string;
}

export interface Command {
  id: string;
  executable: "php artisan" | "laravel" | "./vendor/bin/pint";
  name: string;
  namespace: string | null;
  occurrences: Array<{ ownerId: string; invocation: string; location: Location }>;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Parse this repository's checklist Markdown, not arbitrary CommonMark. */
export function buildCorpus(markdown: string, path = "PROGRESS.md") {
  const documentId = "document:progress";
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  const items: Item[] = [];
  const notes: Content[] = [];
  const examples: Example[] = [];
  const sources: Source[] = [];
  const stack: Section[] = [];
  const ids = new Map<string, number>();
  const uniqueId = (base: string) => {
    const count = (ids.get(base) ?? 0) + 1;
    ids.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
  const location = (start: number, end = start): Location => ({ path, startLine: start + 1, endLine: end + 1 });
  const parentId = () => stack.at(-1)?.id ?? documentId;
  const contentId = (kind: string, parent: string, text: string) =>
    uniqueId(`${kind}:${sha256(`${parent}\n${text}`).slice(0, 16)}`);
  let activeItem: Item | undefined;
  let title = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const start = i;
      const body: string[] = [];
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      const owner = indent >= 2 && activeItem ? activeItem.id : parentId();
      const indentPattern = new RegExp(`^ {0,${indent}}`);
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!.replace(indentPattern, ""));
      }
      if (i >= lines.length) throw new Error(`Unclosed code fence at ${path}:${start + 1}`);
      const text = body.join("\n");
      examples.push({ id: contentId("example", owner, text), parentId: owner, language: fence[1]!.trim(), text, location: location(start, i) });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      activeItem = undefined;
      const level = heading[1]!.length;
      const headingTitle = heading[2]!;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      if (level === 1) {
        title = headingTitle;
        continue;
      }
      const parent = parentId();
      const section: Section = {
        id: uniqueId(`${parent}/section:${slug(headingTitle)}`),
        parentId: parent, level, title: headingTitle, location: location(i),
      };
      sections.push(section);
      stack.push(section);
      continue;
    }

    const checklist = line.match(/^- \[([ xX])\]\s+(.+)$/);
    if (checklist) {
      const itemTitle = checklist[2]!;
      activeItem = {
        id: uniqueId(`item:${sha256(`${parentId()}\n${itemTitle}`).slice(0, 16)}`),
        sectionId: parentId(), title: itemTitle,
        completed: checklist[1]!.toLowerCase() === "x", location: location(i),
      };
      items.push(activeItem);
      continue;
    }

    const link = line.match(/^- \[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/);
    if (link) {
      activeItem = undefined;
      sources.push({ id: contentId("source", parentId(), link[2]!), parentId: parentId(), text: link[1]!, url: link[2]!, location: location(i) });
      continue;
    }

    const start = i;
    const owner = /^ {2,}\S/.test(line) && activeItem ? activeItem.id : parentId();
    if (owner !== activeItem?.id) activeItem = undefined;
    const paragraph = [line];
    while (i + 1 < lines.length && lines[i + 1]!.trim()
      && !/^\s*```|^#{1,3}\s|^- /.test(lines[i + 1]!)) {
      paragraph.push(lines[++i]!);
    }
    const text = paragraph.join("\n");
    notes.push({ id: contentId("note", owner, text), parentId: owner, text, location: location(start, i) });
  }

  const commands = new Map<string, Command>();
  function register(raw: string, ownerId: string, loc: Location, allowBare = false) {
    const invocation = raw.trim();
    let executable: Command["executable"];
    let name: string;
    const artisan = invocation.match(/^(?:php artisan|\.\/vendor\/bin\/sail artisan)\s+([^\s]+)(?:\s|$)/);
    if (artisan) {
      executable = "php artisan";
      name = artisan[1]!;
      if (name.startsWith("<")) return;
    } else if (/^laravel\s+\S+/.test(invocation)) {
      executable = "laravel";
      name = invocation.split(/\s+/)[1]!;
    } else if (/^\.\/vendor\/bin\/pint(?:\s|$)/.test(invocation)) {
      executable = "./vendor/bin/pint";
      name = "pint";
    } else if (/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/.test(invocation)
      || (allowBare && /^[a-z][a-z0-9-]*$/.test(invocation))) {
      executable = "php artisan";
      name = invocation;
    } else return;
    const id = `command:${executable === "php artisan" ? "artisan" : executable === "laravel" ? "installer" : "pint"}:${name}`;
    let command = commands.get(id);
    if (!command) {
      command = { id, executable, name, namespace: name.includes(":") ? name.split(":")[0]! : null, occurrences: [] };
      commands.set(id, command);
    }
    if (!command.occurrences.some(o => o.ownerId === ownerId && o.invocation === invocation)) {
      command.occurrences.push({ ownerId, invocation, location: loc });
    }
  }
  for (const item of items) {
    for (const match of item.title.matchAll(/`([^`]+)`/g)) {
      register(match[1]!, item.id, item.location, match.index === 0);
    }
  }
  for (const note of notes) {
    for (const match of note.text.matchAll(/`([^`]+)`/g)) register(match[1]!, note.id, note.location);
  }
  for (const example of examples) {
    if (!/^(bash|sh|shell)$/.test(example.language)) continue;
    for (const [index, line] of example.text.split("\n").entries()) {
      const lineNumber = example.location.startLine + index + 1;
      register(line, example.id, { path, startLine: lineNumber, endLine: lineNumber });
    }
  }
  const commandList = [...commands.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const document = { id: documentId, title, path, sha256: sha256(markdown), markdown };
  const nodes: Array<{ id: string; type: string; label: string }> = [
    { id: documentId, type: "document", label: title },
    ...sections.map(s => ({ id: s.id, type: "section", label: s.title })),
    ...items.map(item => ({ id: item.id, type: "item", label: item.title })),
    ...notes.map(n => ({ id: n.id, type: "note", label: n.text })),
    ...examples.map(e => ({ id: e.id, type: "example", label: e.text })),
    ...sources.map(s => ({ id: s.id, type: "source", label: s.text })),
    ...commandList.map(c => ({ id: c.id, type: "command", label: c.executable === "./vendor/bin/pint" ? c.executable : `${c.executable} ${c.name}` })),
  ];
  const edges: Array<{ from: string; to: string; relation: string }> = [];
  for (const section of sections) edges.push({ from: section.parentId, to: section.id, relation: "contains" });
  for (const item of items) edges.push({ from: item.sectionId, to: item.id, relation: "contains" });
  for (const note of notes) edges.push({ from: note.parentId, to: note.id, relation: "has_note" });
  for (const example of examples) edges.push({ from: example.parentId, to: example.id, relation: "has_example" });
  for (const source of sources) edges.push({ from: source.parentId, to: source.id, relation: "cites" });
  for (const command of commandList) {
    for (const ownerId of new Set(command.occurrences.map(o => o.ownerId))) {
      edges.push({ from: ownerId, to: command.id, relation: "references_command" });
    }
  }

  return {
    corpus: { schemaVersion: 1, document, sections, items, notes, examples },
    commands: { schemaVersion: 1, commands: commandList },
    sources: { schemaVersion: 1, sources },
    graph: { schemaVersion: 1, nodes, edges },
    manifest: {
      schemaVersion: 1,
      source: { path, sha256: document.sha256 },
      generatedBy: "bun run graph:build",
      files: ["corpus.json", "commands.json", "sources.json", "graph.json", "manifest.json"],
      counts: {
        categories: sections.filter(s => s.level === 2 && /^\d+\./.test(s.title)).length,
        sections: sections.length, items: items.length,
        completedItems: items.filter(item => item.completed).length,
        notes: notes.length, examples: examples.length, sources: sources.length,
        commands: commandList.length, nodes: nodes.length, edges: edges.length,
      },
    },
  };
}
