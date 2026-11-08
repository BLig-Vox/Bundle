import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frameworkRoot = fileURLToPath(new URL("../../", import.meta.url));
const templateRoot = join(frameworkRoot, "templates/app");
const templateFiles = [
  "database/migrations/sqlite/.gitkeep", "database/migrations/postgresql/.gitkeep", "database/migrations/mariadb/.gitkeep",
  ".env.example", ".gitignore", "README.md", "components.json", "database/seeders/DatabaseSeeder.ts",
  "index.html", "scripts/bundle.ts", "scripts/production.ts", "scripts/dev.ts", "scripts/work-once.ts", "src/jobs/registry.ts", "src/App.tsx", "src/ResourcePage.tsx", "src/ResourceNavigation.tsx", "src/resource-pages.tsx", "src/app.test.ts", "src/health.test.ts", "src/production.test.ts", "src/components/ui/button.tsx",
  "src/index.css", "src/lib/utils.ts", "src/main.tsx", "src/models/User.ts", "src/models/Session.ts", "src/models/BundleJob.ts", "src/queue.ts", "src/auth-attempt-limiter.test.ts", "src/auth-attempt-limiter.ts", "src/models/AuthAttemptBucket.ts", "src/auth.test.ts", "src/auth.ts", "src/routes/Auth.ts", "src/models/Note.ts", "src/notes.test.ts", "src/routes/Notes.ts", "src/routes/Health.ts",
  "src/web/router.ts", "src/web/routes.ts", "src/web/resources.ts", "tsconfig.app.json", "tsconfig.json", "tsconfig.node.json",
  "tsconfig.server.json", "vite.config.ts",
];

function packageSource(name: string) {
  return JSON.stringify({
    name, version: "0.0.0", private: true, type: "module", engines: { bun: ">=1.4.4" },
    scripts: {
      dev: "bun run scripts/dev.ts", "start:production": "bun run scripts/production.ts", build: "bun run typecheck && bun --bun vite build", preview: "bun --bun vite preview",
      "work:once": "bun run scripts/work-once.ts",
      typecheck: "tsc -p tsconfig.app.json && tsc -p tsconfig.node.json && tsc -p tsconfig.server.json",
      test: "bun test ./src", bundle: "bun run scripts/bundle.ts", server: "bun run bundle serve --mode routes",
      "db:migrate": "bun run bundle migrate",
    },
    dependencies: {
      bundle: `file:${frameworkRoot.replace(/\/$/, "")}`,
      "@mikro-orm/core": "7.2.7", "@mikro-orm/migrations": "7.2.7", "@mikro-orm/seeder": "7.2.7",
      "@radix-ui/react-slot": "1.4.0", "class-variance-authority": "0.7.1", clsx: "2.1.1",
      "lucide-react": "0.577.0", react: "19.3.0", "react-dom": "19.3.0", "tailwind-merge": "3.7.0",
    },
    devDependencies: {
      "@tailwindcss/vite": "4.3.3", "@types/bun": "1.4.4", "@types/react": "19.3.0", "@types/react-dom": "19.3.0",
      "@vitejs/plugin-react": "6.0.3", tailwindcss: "4.3.3", "tw-animate-css": "1.4.0", typescript: "7.0.2", vite: "8.3.4",
    },
  }, null, 2) + "\n";
}

async function assertRealRoot(root: string) {
  for (let path = root;; path = dirname(path)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("App root and ancestors must be real directories without symlinks.");
    if (dirname(path) === path) break;
  }
}

function existsError(name: string) { return new Error(`App destination already exists: ${name}. Choose another app name.`); }

/**
 * Stage every file before claiming the destination with exclusive mkdir. Rename
 * over ONLY our own empty reservation publishes the complete tree atomically.
 * Parent directories must be trusted against hostile concurrent replacement.
 * Caught failures clean staging/reservation; process death can leave either.
 */
export async function generateApp(root: string, name: string, io: {
  writeFile?: typeof writeFile; rename?: typeof rename;
} = {}): Promise<string> {
  if (!name || name.length > 64 || name.match(/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/)?.[0] !== name
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) {
    throw new Error("Use an ASCII app name of 1–64 letters, numbers and single hyphens, starting with a letter; reserved device names are forbidden.");
  }
  root = resolve(root);
  await assertRealRoot(root);
  const directory = name.toLowerCase();
  const destination = join(root, directory);
  try { await lstat(destination); throw existsError(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const staging = await mkdtemp(join(root, ".bundle-app-"));
  let reservation: Awaited<ReturnType<typeof lstat>> | undefined;
  let published = false;
  try {
    const files = await Promise.all(templateFiles.map(async file => [file, await readFile(join(templateRoot, `${file}.tpl`), "utf8")] as const));
    files.push(["package.json", packageSource(directory)]);
    for (const [file, source] of files) {
      const path = join(staging, file);
      await mkdir(dirname(path), { recursive: true });
      await (io.writeFile ?? writeFile)(path, source, { flag: "wx", mode: 0o644 });
    }
    // mkdtemp is private during staging; generated app has normal directory permissions.
    const { chmod } = await import("node:fs/promises");
    await chmod(staging, 0o755);
    try { await mkdir(destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw existsError(directory); throw error; }
    reservation = await lstat(destination);
    await (io.rename ?? rename)(staging, destination);
    published = true;
    return directory;
  } finally {
    if (!published && reservation) {
      const current = await lstat(destination).catch(() => undefined);
      if (current?.ino === reservation.ino && current?.dev === reservation.dev) {
        // rmdir never removes a populated destination or follows a symlink.
        const { rmdir } = await import("node:fs/promises");
        await rmdir(destination);
      }
    }
    await rm(staging, { recursive: true, force: true });
  }
}
