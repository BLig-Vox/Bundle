import { EntitySchema, type MigrateOptions, type MikroORM, type Transaction } from "@mikro-orm/core";
import { Migrator, MigrationStorage } from "@mikro-orm/migrations";

class HistoryRow {
  id!: number;
  name!: string;
  executedAt!: Date;
  batch!: number;
}

/** Extend the native history table, keeping native ORM commands interoperable. */
export class BatchMigrationStorage extends MigrationStorage {
  batch = 1;
  private master?: Transaction;
  private batchColumnEnsured = false;

  override getTableName() {
    const { tableName, schemaName } = super.getTableName();
    const entity = new EntitySchema({
      class: HistoryRow, tableName, schema: schemaName,
      properties: {
        id: { type: "number", fieldName: "id", primary: true, autoincrement: true },
        name: { type: "string", fieldName: "name" },
        executedAt: { type: Date, fieldName: "executed_at", defaultRaw: "current_timestamp" },
        batch: { type: "number", fieldName: "batch", default: 1 },
      },
    }).init();
    entity.meta.sync();
    return { tableName, schemaName, entity };
  }

  override async ensureTable() {
    await super.ensureTable();
    if (this.batchColumnEnsured) return;
    const { tableName, schemaName } = this.getTableName();
    const tables = await this.driver.createEntityManager().getKysely().introspection.getTables();
    const table = tables.find(table => table.name === tableName && (!schemaName || table.schema === schemaName));
    if (!table?.columns.some(column => column.name === "batch")) {
      const quoted = this.driver.getPlatform().quoteIdentifier.bind(this.driver.getPlatform());
      const name = schemaName ? `${quoted(schemaName)}.${quoted(tableName)}` : quoted(tableName);
      await this.driver.getConnection().execute(`alter table ${name} add column ${quoted("batch")} integer not null default 1`);
    }
    this.batchColumnEnsured = true;
  }

  override setMasterMigration(tx: Transaction) { super.setMasterMigration(tx); this.master = tx; }
  override unsetMasterMigration() { super.unsetMasterMigration(); this.master = undefined; }

  override async logMigration(params: { name: string }, tx?: Transaction) {
    await this.ensureTable();
    const { entity } = this.getTableName();
    await this.driver.nativeInsert(entity, { name: this.getMigrationName(params.name), batch: this.batch }, { ctx: tx ?? this.master });
  }
}

export class BundleMigrator extends Migrator {
  static override register(orm: MikroORM) {
    orm.config.registerExtension("@mikro-orm/migrator", () => new BundleMigrator(orm.em as ConstructorParameters<typeof Migrator>[0]));
  }
  protected override createStorage() { return new BatchMigrationStorage(this.driver, this.options); }
  override getStorage() { return this.storage as BatchMigrationStorage; }
  override async up(options?: string | string[] | MigrateOptions) {
    const executed = await this.getExecuted();
    this.getStorage().batch = Math.max(0, ...executed.map(row => Number((row as typeof row & { batch?: number }).batch ?? 1))) + 1;
    return super.up(options);
  }
}
