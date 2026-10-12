import type { User } from '../db/index.js';
import { draftAction, performAction, type DraftView, type PendingView } from '../actions/perform.js';
import { getAction } from '../actions/registry.js';

/**
 * preview: the user is still typing. Only read actions execute; everything else becomes a draft
 *          (no side effects at all — typing "freeze my ca…" never freezes a card).
 * commit:  the user submitted. Read actions execute; every change becomes a pending action awaiting the user.
 */
export type AgentMode = 'preview' | 'commit';

export type RunOutcome =
  | { status: 'done'; action: string; risk: 'read' | 'auto'; result: unknown }
  | { status: 'needs_confirmation'; action: string; risk: 'confirm'; pending: PendingView }
  | { status: 'draft'; action: string; risk: 'auto' | 'confirm'; draft: DraftView };

export type TraceStep = { tool: string; input: unknown; outcome: RunOutcome };

/** Executes registry actions for one agent run, recording a trace (used to build cacheable plans). */
export class ActionRunner {
  readonly trace: TraceStep[] = [];
  readonly drafts = new Map<string, DraftView>();
  readonly pendingIds: string[] = [];

  constructor(
    readonly user: User,
    readonly mode: AgentMode,
  ) {}

  async run(tool: string, input: unknown): Promise<RunOutcome> {
    const def = getAction(tool);
    let outcome: RunOutcome;
    if (this.mode === 'preview' && def.risk !== 'read') {
      const draft = await draftAction(this.user, tool, input);
      this.drafts.set(draft.id, draft);
      outcome = { status: 'draft', action: tool, risk: draft.risk, draft };
    } else {
      outcome = await performAction(this.user, tool, input);
      if (outcome.status === 'needs_confirmation') this.pendingIds.push(outcome.pending.id);
    }
    this.trace.push({ tool, input, outcome });
    return outcome;
  }

  /** Ids the final UI must show a confirmation block for (pending actions and drafts). */
  confirmableIds(): string[] {
    return [...this.pendingIds, ...this.drafts.keys()];
  }
}

/** What the model sees after an action (keeps instructions short to save tokens). */
export function observationFor(outcome: RunOutcome): unknown {
  if (outcome.status === 'needs_confirmation') {
    return { ...outcome, instruction: `Render {"type":"confirmation","pendingId":"${outcome.pending.id}"} so the user can approve.` };
  }
  if (outcome.status === 'draft') {
    return {
      status: 'draft',
      action: outcome.action,
      summary: outcome.draft.summary,
      draftId: outcome.draft.id,
      instruction: `Preview only (user still typing). Render {"type":"confirmation","pendingId":"${outcome.draft.id}"}; it runs only if the user presses it.`,
    };
  }
  return outcome;
}
