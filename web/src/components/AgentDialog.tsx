import type { AgentInfo } from '@/api/contract';
import { SheetDialog } from './Sheet';

export function AgentDialog({ agent, onClose, container }: { agent: AgentInfo | null; onClose: () => void; container?: HTMLElement | null }) {
  const meta: [string, string][] = agent
    ? [
        ['Model', `${agent.model ?? 'not configured'}. Temperature ${agent.temperature}.`],
        ['Prompt version', agent.promptVersion],
        ['Code', agent.file],
        ['Tools', agent.tools.length ? agent.tools.map((t) => `${t.name} (${t.description})`).join('; ') : 'None'],
        ['Can see', agent.sees],
        ['Returns', agent.returns],
        ['If it fails', agent.onFailure],
      ]
    : [];
  return (
    <SheetDialog open={!!agent} onOpenChange={(o) => !o && onClose()} title={agent?.name ?? ''} subtitle={agent?.job}
      width="w-[min(760px,94vw)]" container={container}>
      {agent && (
        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-auto">
          <div className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
            {meta.map(([l, v]) => (
              <div key={l} className="contents">
                <div className="text-zinc-500">{l}</div>
                <div>{v}</div>
              </div>
            ))}
          </div>
          <section>
            <h3 className="set-h">Grounding</h3>
            <div className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <div className="text-zinc-500">Must cite</div><div>{agent.cites}</div>
              <div className="text-zinc-500">If data is missing</div><div>{agent.abstains}</div>
              <div className="text-zinc-500">Checked by</div><div>Code, after every call. Output that fails goes to a code template or a person.</div>
            </div>
          </section>
          <section>
            <h3 className="set-h">System prompt</h3>
            <pre className="whitespace-pre-wrap text-[13px] leading-relaxed bg-zinc-950 text-zinc-100 rounded-lg p-4 font-mono">{agent.systemPrompt}</pre>
          </section>
          <section>
            <h3 className="set-h">Message it receives</h3>
            <pre className="whitespace-pre-wrap text-[13px] bg-zinc-100 rounded-lg p-4 font-mono">{agent.userTemplate}</pre>
          </section>
        </div>
      )}
    </SheetDialog>
  );
}
