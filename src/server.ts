import { Client, Connection } from '@temporalio/client';
import { createServer } from 'node:http';
import { createApi } from './api';
import { REVIEW_QUEUE_ID, TASK_QUEUE } from './config';
import { modelIdsFromEnv } from './models';
import { Store } from './store';

/** HTTP API on :3000. Shares the SQLite file with the worker (WAL). Resets the demo on first boot. */
const store = new Store(process.env.QUOTE_DB ?? 'quote-agent.db');
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
const port = Number(process.env.PORT ?? 3000);
const api = createApi({ client: new Client({ connection }), store, taskQueue: TASK_QUEUE, queueId: REVIEW_QUEUE_ID, modelIds: modelIdsFromEnv() });
createServer(api).listen(port, () => console.log(`API on http://localhost:${port}`));
// A restarted Temporal dev server forgets its workflows while the SQLite file keeps the quotes: reset then too.
if (store.isEmpty() || process.env.RESET_ON_BOOT === '1' || (await api.orphaned())) {
  console.log('resetting demo data');
  await api.reset();
  console.log('demo ready');
}
