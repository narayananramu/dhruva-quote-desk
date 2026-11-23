import { allHandlersFinished, condition, continueAsNew, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';

/** Who must act next on an RFQ. */
export type Role = 'customer' | 'sales' | 'finance' | 'inventory';

export interface QueueEntry {
  rfqId: string;
  account: string;
  status: string;
  waitingOn: Role | null; // null means the RFQ is finished and leaves the queue
  version: number;
  updatedAt: number;
}

export const queueUpdateSignal = defineSignal<[QueueEntry]>('queueUpdate');
export const queueQuery = defineQuery<QueueEntry[]>('queue');

const MAX_UPDATES = 500; // bound history; carry the open entries into a fresh run

/**
 * Long-running entity workflow holding the review queue. RFQ workflows feed it through an
 * activity (signal-with-start); the API reads it with a query. No queue state lives outside Temporal.
 */
export async function reviewQueueWorkflow(open: QueueEntry[]): Promise<void> {
  const entries = new Map(open.map((e) => [e.rfqId, e]));
  let updates = 0;
  setHandler(queueQuery, () => [...entries.values()].sort((a, b) => a.updatedAt - b.updatedAt));
  setHandler(queueUpdateSignal, (e) => {
    updates += 1;
    if (e.waitingOn) entries.set(e.rfqId, e);
    else entries.delete(e.rfqId);
  });
  await condition(() => updates >= MAX_UPDATES && allHandlersFinished());
  await continueAsNew<typeof reviewQueueWorkflow>([...entries.values()]);
}
