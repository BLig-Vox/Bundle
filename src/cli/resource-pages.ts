import { resourceManifestNames, resourceManifest, resourcePath } from "./resource-manifest.ts";

export function resourcePageManifest(names: string[]): string {
  return `// Bundle static resource page manifest v1. Automatic edits require this exact format.
import type { ComponentType } from "react";
import type { PageProps } from "./ResourcePage.tsx";
${names.map(name => `import ${name}Page from "./resource-pages/${name}.tsx";\n`).join("")}
export const resourcePages: readonly { name: string; hash: string; Page: ComponentType<PageProps> }[] = [
${names.map(name => `  { name: "${name}", hash: "#${resourcePath(name).slice(4)}", Page: ${name}Page },\n`).join("")}];
`;
}
export function resourcePageManifestNames(source: string): string[] | null {
  const names = [...source.matchAll(/^import ([A-Z][A-Za-z0-9]*)Page from "\.\/resource-pages\/\1\.tsx";$/gm)].map(m => m[1]!);
  return resourceManifestNames(resourceManifest(names)) && source === resourcePageManifest(names) ? names : null;
}
export function resourcePageSource(name: string, fields: { key: string; type: string; optional: boolean }[]) {
  return `import { ResourcePage as _ResourcePage, validRecord as _validRecord, type Field as _Field, type PageProps as _PageProps } from "../ResourcePage.tsx";

// Editable resource page. Keep response validation at this network boundary.
export type ${name}Row = {
  id: number;
${fields.map(f => `  ${f.key}: ${f.type === "text" || f.type === "string" ? "string" : f.type === "boolean" ? "boolean" : "number"}${f.optional ? " | null" : ""};`).join("\n")}
};
const fields = ${JSON.stringify(fields.map(f => ({ key: f.key, type: f.type, nullable: f.optional })), null, 2)} as const satisfies readonly _Field[];
const validate = (value: unknown): value is ${name}Row => _validRecord(value, fields);
export default function ${name}Page(props: _PageProps) {
  return <_ResourcePage<${name}Row> {...props} name="${name}" path="${resourcePath(name)}" fields={fields} validate={validate} />;
}
`;
}
