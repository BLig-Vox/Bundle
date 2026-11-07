import { expect, test } from 'bun:test';
import { EntitySchema, MikroORM } from '@mikro-orm/sqlite';
import { Migrator } from '@mikro-orm/migrations';
import { openDatabase } from './connection.ts';
import { uninstallMigrationHistory } from './history-uninstall.ts';

class MappedHistory { id!: number; name!: string; executedAt!: Date }
const schema = new EntitySchema({ class: MappedHistory, tableName: 'mikro_orm_migrations', properties: { id: { type: 'number', primary: true }, name: { type: 'string' }, executedAt: { type: Date, fieldName: 'executed_at' } } });
test('refuses configured tracking table when it is also a mapped application entity', async () => {
  const orm = await MikroORM.init({ dbName: ':memory:', entities: [schema], extensions: [Migrator], migrations: { migrationsList: [] } });
  try {
    await orm.migrator.getExecuted();
    await expect(uninstallMigrationHistory(orm, { force: true })).rejects.toThrow('Unable to uninstall migration history');
    expect(await orm.driver.execute("select name from sqlite_schema where name='mikro_orm_migrations'", [], 'all')).toHaveLength(1);
  } finally { await orm.close(true); }
});
test('abort observed after drop query rolls back the active history transaction', async () => {
  const orm = await openDatabase({ DB_DATABASE: ':memory:' }); const controller = new AbortController();
  try {
    await orm.migrator.getExecuted();
    orm.config.set('onQuery', sql => { if (/^drop table/i.test(sql)) controller.abort(); return sql; });
    await expect(uninstallMigrationHistory(orm, { force: true, signal: controller.signal })).rejects.toThrow('Unable to uninstall migration history');
    expect(controller.signal.aborted).toBe(true);
    expect(await orm.driver.execute("select name from sqlite_schema where name='mikro_orm_migrations'", [], 'all')).toHaveLength(1);
  } finally { await orm.close(true); }
});
test('active-lock refusal reads the inspected main schema explicitly', async () => {
  const orm = await openDatabase({ DB_DATABASE: ':memory:' }); const observed: string[] = [];
  try {
    await orm.migrator.getExecuted();
    await orm.driver.execute("create table bundle_migration_lock (id text, owner text)");
    await orm.driver.execute("insert into bundle_migration_lock values ('migrations','owner')");
    orm.config.set('onQuery', sql => { observed.push(sql); return sql; });
    await expect(uninstallMigrationHistory(orm, { force: true })).rejects.toThrow('Unable to uninstall migration history');
    expect(observed.some(sql => /^select 1 from main\.[`\"]?bundle_migration_lock/i.test(sql))).toBe(true);
    expect(observed.some(sql => /^drop table/i.test(sql))).toBe(false);
  } finally { await orm.close(true); }
});
test('unsupported server platform refuses before attempting connection', async () => {
  const orm = await openDatabase({ DB_CONNECTION: 'postgresql', DB_DATABASE: 'unused', DB_HOST: '127.0.0.1', DB_PORT: '1' }, undefined, false);
  try { await expect(uninstallMigrationHistory(orm, { pretend: true })).rejects.toThrow('Unable to uninstall migration history'); expect(await orm.driver.getConnection().isConnected()).toBe(false); }
  finally { await orm.close(true); }
});
