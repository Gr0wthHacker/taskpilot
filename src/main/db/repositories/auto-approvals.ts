/**
 * Auto-approvals audit log.
 * Every auto-approved task is logged for traceability and reversibility.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { autoApprovals, type AutoApproval, type CreateAutoApproval } from '@/shared/schema-v2';
import { getDb } from '../index';

export function createAutoApproval(input: Omit<CreateAutoApproval, 'id' | 'auto_approved_at' | 'created_at'>): AutoApproval {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  const row = db
    .insert(autoApprovals)
    .values({
      id,
      task_id: input.task_id,
      suggestion_id: input.suggestion_id,
      reason: input.reason,
      risk_level: input.risk_level,
      operation_type: input.operation_type,
      auto_approved_at: now,
      user_reversed_at: null,
      created_at: now,
    })
    .returning()
    .get();

  return row;
}

export function getAutoApproval(id: string): AutoApproval | null {
  const db = getDb();
  return db
    .select()
    .from(autoApprovals)
    .where(eq(autoApprovals.id, id))
    .get() ?? null;
}

/**
 * Get all auto-approvals for a task.
 */
export function getAutoApprovalsForTask(taskId: string): AutoApproval[] {
  const db = getDb();
  return db
    .select()
    .from(autoApprovals)
    .where(eq(autoApprovals.task_id, taskId))
    .orderBy(desc(autoApprovals.auto_approved_at))
    .all();
}

/**
 * Mark an auto-approval as reversed (user undid it).
 */
export function reverseAutoApproval(id: string): AutoApproval | null {
  const db = getDb();

  db.update(autoApprovals)
    .set({ user_reversed_at: new Date().toISOString() })
    .where(eq(autoApprovals.id, id))
    .run();

  return getAutoApproval(id);
}

/**
 * Get unreversed auto-approvals.
 */
export function getActiveAutoApprovals(limit: number = 100): AutoApproval[] {
  const db = getDb();
  return db
    .select()
    .from(autoApprovals)
    .where(isNull(autoApprovals.user_reversed_at))
    .orderBy(desc(autoApprovals.auto_approved_at))
    .limit(limit)
    .all();
}
