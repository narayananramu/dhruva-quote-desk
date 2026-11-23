import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { createActivities } from './activities';
import { REVIEW_QUEUE_ID, TASK_QUEUE } from './config';
import { modelIdsFromEnv, modelsFromEnv } from './models';
import { Store } from './store';
import { costConfig } from './usage';

/** Live worker against `temporal server start-dev`. Agents use the models chosen by env (QUOTE_MODEL=mock needs no key). */
export async function startWorker(store: Store) {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const costs = costConfig();
  const ids = modelIdsFromEnv();
  const client = new Client({ connection: await Connection.connect({ address }) });
  const worker = await Worker.create({
    connection: await NativeConnection.connect({ address }),
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
    activities: createActivities({ store, models: modelsFromEnv(), costs, queue: { client, workflowId: REVIEW_QUEUE_ID, taskQueue: TASK_QUEUE } }),
  });
  console.log(`worker on "${TASK_QUEUE}" (stage ${costs.stage}); models ${JSON.stringify(ids)}`);
  return worker;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = await startWorker(new Store(process.env.QUOTE_DB ?? 'quote-agent.db'));
  await worker.run();
}
