import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TSMigrationGenerator } from "@mikro-orm/migrations";

/** MikroORM's default generator overwrites same-second filenames; Bundle never does. */
export class SafeMigrationGenerator extends TSMigrationGenerator {
  override async generate(diff: { up: string[]; down: string[] }, path?: string, name?: string): Promise<[string, string]> {
    const directory = resolve(this.driver.config.get("baseDir"), path ?? this.options.pathTs ?? this.options.path!);
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-T:]|\.\d{3}z$/gi, "");
    const className = this.namingStrategy.classToMigrationName(timestamp, name);
    const filename = `${this.options.fileName!(timestamp, name)}.ts`;
    const content = await this.generateMigrationFile(className, diff);
    // If the filename already exists, fail before the migrator updates its snapshot.
    await writeFile(resolve(directory, filename), content, { flag: "wx" });
    return [content, filename];
  }
}
