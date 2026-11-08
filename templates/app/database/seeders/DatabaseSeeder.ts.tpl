import type { EntityManager } from "@mikro-orm/core";
import { Seeder } from "@mikro-orm/seeder";

// Register through the API; never ship shared accounts or plaintext passwords.
export class DatabaseSeeder extends Seeder {
  async run(_em: EntityManager): Promise<void> {}
}
