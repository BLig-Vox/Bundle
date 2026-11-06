import type { EntityManager } from "@mikro-orm/core";
import { Seeder } from "@mikro-orm/seeder";
import { User } from "../../src/models/User.ts";
import { Post } from "../../src/models/Post.ts";

/** Explicit opt-in demo data. Stable unique keys make repeated runs idempotent. */
export class DatabaseSeeder extends Seeder {
  override async run(em: EntityManager): Promise<void> {
    // Upserts bypass constructor defaults; supply timestamps explicitly.
    const now = new Date();
    const author = await em.upsert(User, {
      email: "demo@example.test", name: "Demo Author", createdAt: now, updatedAt: now,
    }, { onConflictFields: ["email"], onConflictExcludeFields: ["createdAt"] });
    await em.upsert(Post, {
      slug: "hello-bundle", title: "Hello, Bundle", body: "Code-first persistence powered by MikroORM.", author,
      createdAt: now, updatedAt: now,
    }, { onConflictFields: ["slug"], onConflictExcludeFields: ["createdAt"] });
  }
}
