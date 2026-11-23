import { useState } from 'react';
import { useAgents } from '@/api/hooks';
import { FlowDiagram, Legend } from '@/components/FlowDiagram';

const LIST: { id: string; name: string; does: string }[] = [
  { id: 'intake', name: 'Intake agent', does: 'reads the request' },
  { id: 'clarify', name: 'Clarification agent', does: 'asks the customer' },
  { id: 'finance', name: 'Finance referral agent', does: 'drafts the case' },
  { id: 'decline', name: 'Decline reader', does: 'tags the loss reason' },
  { id: 'evidence', name: 'Claim evidence reader', does: 'compares a rival quote with the request' },
];

export function About() {
  const agents = useAgents().data?.agents ?? [];
  const [filter, setFilter] = useState('');
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  return (
    <main className="max-w-[1600px] mx-auto px-4 py-5">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xl font-semibold">How a quote moves</h2>
          <p className="text-zinc-600">Five AI agents read and write, citing the facts they used. Code decides price and stock. People approve. Temporal keeps each quote running through waits, retries and restarts.</p>
        </div>
        <Legend value={filter} onChange={setFilter} />
      </div>
      <FlowDiagram filter={filter} agents={agents} openAgent={openAgent} setOpenAgent={setOpenAgent} />
      <div className="grid md:grid-cols-3 gap-4 mt-5 text-sm">
        <div className="card p-4">
          <div className="font-semibold mb-1">The agents</div>
          <ul className="space-y-1.5 text-zinc-700">
            {LIST.map((a) => (
              <li key={a.id}>
                <button className="underline underline-offset-2 hover:text-purple-700" onClick={() => setOpenAgent(a.id)}>
                  {agents.find((x) => x.id === a.id)?.name ?? a.name}
                </button>{' '}
                <span className="text-zinc-500">· {a.does}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-4">
          <div className="font-semibold mb-1">AI agents cannot</div>
          <ul className="list-disc pl-5 space-y-1 text-zinc-700">
            <li>Set or change a price</li><li>Reserve or release stock</li><li>Send a quote without the checks passing</li><li>See cost or margin when writing to a customer</li><li>Say anything they cannot cite</li><li>Reveal their instructions</li><li>Treat a rival's price as fact</li>
          </ul>
        </div>
        <div className="card p-4">
          <div className="font-semibold mb-1">People decide</div>
          <ul className="list-disc pl-5 space-y-1 text-zinc-700">
            <li>Sales: send, change, send back, reopen</li><li>Finance: any price below the 16% minimum, with a cited reason, within 4 business hours</li><li>Finance: whether a rival price alert was right</li><li>Inventory: confirm an old stock count</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
