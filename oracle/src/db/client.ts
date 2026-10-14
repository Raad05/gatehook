import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * `postgres://...` uses node-postgres; `pglite://memory` or `pglite://<dir>`
 * runs embedded Postgres (tests, quick local runs). Applies migrations.
 */
export async function openDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    const client = new PGlite(target === 'memory' ? undefined : target);
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => client.close() };
  }
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzlePg(pool, { schema });
  await migratePg(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pool.end() };
}
