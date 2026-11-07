import { BigIntType, raw, SqlEntityManager, SqlitePlatform } from '@mikro-orm/sqlite';
import { checkPruningAbort, pruningArray, pruningEntries, pruningName, pruningRecord, type PruningDefinitions } from './pruning-definitions.ts';

export interface PruningOptions { pretend?: boolean; force?: boolean; models?: readonly string[]; chunkSize?: number; limit?: number; signal?: AbortSignal }
export interface PruningResult { pretend: boolean; models: readonly { name: string; matched: number; selected: number; deleted: number }[] }

/** Uses native bulk delete; hooks do not run and earlier chunks remain committed on failure. */
export async function pruneModels(manager: SqlEntityManager, definitions: PruningDefinitions, options: PruningOptions): Promise<PruningResult> {
  let owned: SqlEntityManager | undefined;
  try {
    const input = pruningRecord(options, ['pretend', 'force', 'models', 'chunkSize', 'limit', 'signal']);
    if ((input.pretend !== undefined && typeof input.pretend !== 'boolean') || (input.force !== undefined && typeof input.force !== 'boolean')) throw new Error();
    const pretend = input.pretend === true;
    if (!pretend && input.force !== true) throw new Error();
    const chunkSize = input.chunkSize ?? 100; const limit = input.limit ?? 1000;
    if (!Number.isSafeInteger(chunkSize) || (chunkSize as number) < 1 || (chunkSize as number) > 1000 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 10000) throw new Error();
    const signal = input.signal ?? new AbortController().signal;
    if (!(signal instanceof AbortSignal)) throw new Error();
    checkPruningAbort(signal);
    const entries = pruningEntries(definitions);
    let selected = entries;
    if (input.models !== undefined) {
      const names = pruningArray(input.models, 32);
      if (!names.length || names.some(name => !pruningName(name)) || new Set(names).size !== names.length || names.some(name => !entries.some(entry => entry.name === name))) throw new Error();
      selected = entries.filter(entry => names.includes(entry.name));
    }
    if (!(manager instanceof SqlEntityManager)) throw new Error();
    owned = manager.fork({ clear: true });
    const prepared: { name: string; model: any; pk: string; column: string; sqliteBigInt: boolean; predicate: any }[] = [];
    for (const entry of selected) {
      checkPruningAbort(signal);
      const meta = owned.getMetadata().get(entry.model);
      if (meta.class !== entry.model || meta.primaryKeys.length !== 1) throw new Error();
      const pk = meta.primaryKeys[0]!; const prop = meta.properties[pk];
      if (!prop || prop.kind !== 'scalar' || prop.persist === false || prop.fieldNames.length !== 1 || !['string', 'number', 'bigint'].includes(prop.runtimeType)) throw new Error();
      const nativeBigInt = !!prop.customType && Object.getPrototypeOf(prop.customType) === BigIntType.prototype;
      if (prop.customType && !nativeBigInt) throw new Error();
      const predicate = await entry.where(signal); checkPruningAbort(signal);
      if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate) || ![Object.prototype, null].includes(Object.getPrototypeOf(predicate))) throw new Error();
      prepared.push({ name: entry.name, model: entry.model, pk, column: prop.fieldNames[0]!, sqliteBigInt: nativeBigInt && owned.getPlatform() instanceof SqlitePlatform, predicate });
    }
    const results: { name: string; matched: number; selected: number; deleted: number }[] = [];
    for (const item of prepared) {
      checkPruningAbort(signal);
      const matched = await owned.count(item.model, item.predicate); checkPruningAbort(signal);
      if (!Number.isSafeInteger(matched) || matched < 0) throw new Error();
      if (pretend) { results.push({ name: item.name, matched, selected: Math.min(matched, limit as number), deleted: 0 }); continue; }
      const builder = owned.createQueryBuilder<any>(item.model);
      const platform = owned.getPlatform();
      const selectedKey = item.sqliteBigInt
        ? raw(`cast(${platform.quoteIdentifier(builder.alias)}.${platform.quoteIdentifier(item.column)} as text) as ${platform.quoteIdentifier('__pruning_key')}`)
        : item.pk;
      const qb = builder.select([selectedKey]).where(item.predicate).orderBy({ [item.pk]: 'asc' }).limit(limit as number);
      await qb.applyFilters(); checkPruningAbort(signal);
      const rows = await qb.execute('all', true); checkPruningAbort(signal);
      const ids = rows.map((row: any) => {
        if (!item.sqliteBigInt) return row[item.pk];
        const value = row.__pruning_key;
        if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new Error();
        return BigInt(value);
      });
      if (ids.some((id: unknown) => !['string', 'number', 'bigint'].includes(typeof id) || (typeof id === 'number' && !Number.isSafeInteger(id))) || new Set(ids).size !== ids.length) throw new Error();
      let deleted = 0;
      for (let index = 0; index < ids.length; index += chunkSize as number) {
        checkPruningAbort(signal);
        const slice = ids.slice(index, index + (chunkSize as number));
        const affected = await owned.transactional(async tx => {
          checkPruningAbort(signal);
          const count = await tx.nativeDelete(item.model, { $and: [item.predicate, { [item.pk]: { $in: slice } }] });
          checkPruningAbort(signal); return count;
        });
        checkPruningAbort(signal);
        if (!Number.isSafeInteger(affected) || affected < 0 || affected > slice.length) throw new Error();
        deleted += affected;
      }
      results.push({ name: item.name, matched, selected: ids.length, deleted });
    }
    checkPruningAbort(signal);
    return { pretend, models: results };
  } catch { throw new Error('Unable to prune models'); }
  finally { owned?.clear(); }
}
