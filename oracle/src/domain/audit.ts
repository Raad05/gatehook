import type { Db } from '../db/client.ts';
import { schema } from '../db/client.ts';

export async function audit(db: Db, actor: string, event: string, subject: string | null, data?: unknown) {
  await db.insert(schema.auditLog).values({ actor, event, subject, data: data ?? null });
}
