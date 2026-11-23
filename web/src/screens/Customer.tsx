import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { CustomerMessage } from '@/api/contract';
import { rawPost } from '@/api/client';
import { useMessages, usePostMessage } from '@/api/hooks';
import { Tag } from '@/components/Chip';
import { PillList, PillTrigger, Tabs } from '@/components/ui/tabs';
import { fmtTime } from '@/lib/format';
import { useSessionValue } from '@/lib/session';

// Prefills from the mockup (setCo and API_REQ), per company.
const NEW_MAIL: Record<string, { subject: string; body: string }> = {
  'ACC-104': { subject: 'RFQ: 25mm bearings', body: 'Need a firm quote for 200 units of the 25mm bearing, delivery to Pune by 5 Dec.' },
  'ACC-318': { subject: 'RFQ: VLV-50 valves', body: 'Need 120 × VLV-50 delivered to Chennai by 28 Nov. Please quote.' },
  'ACC-211': { subject: 'RFQ: VLV-40 valves', body: 'Please quote 50 × VLV-40 at ₹900 each. A competitor has offered less.' },
};
const API_REQ: Record<string, object> = {
  'ACC-104': { account: 'ACC-104', part: 'BRG-25-SS', quantity: 200, quote_type: 'firm', deliver_to: 'Pune', deliver_by: '2026-12-05' },
  'ACC-318': { account: 'ACC-318', part: 'VLV-50', quantity: 120, quote_type: 'firm', deliver_to: 'Chennai', deliver_by: '2026-11-28' },
  'ACC-211': { account: 'ACC-211', part: 'VLV-40', quantity: 50, quote_type: 'firm', target_price_inr: 900 },
};

export function Customer() {
  const session = useSessionValue();
  const { account } = useParams();
  const nav = useNavigate();
  const code = account ?? session.accounts[0]?.code;
  const [ch, setCh] = useState('mail');

  return (
    <>
      <div className="max-w-6xl mx-auto px-4 pt-5 flex flex-wrap items-center gap-3">
        <select className="co-sel" aria-label="Company" value={code} onChange={(e) => nav(`/customer/${e.target.value}`)}>
          {session.accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
        </select>
        <Tabs value={ch} onValueChange={setCh}>
          <PillList aria-label="Channel">
            <PillTrigger value="mail">Mail</PillTrigger>
            <PillTrigger value="chat">Chat</PillTrigger>
            <PillTrigger value="api">API</PillTrigger>
          </PillList>
        </Tabs>
      </div>
      {code ? (
        ch === 'mail' ? <Mail key={code} code={code} /> : ch === 'chat' ? <Chat key={code} code={code} /> : <Api key={code} code={code} />
      ) : null}
    </>
  );
}

function Mail({ code }: { code: string }) {
  const { data } = useMessages(code);
  const post = usePostMessage(code);
  const mails = useMemo(() => (data?.messages ?? []).filter((m) => m.mail).sort((a, b) => b.at - a.at), [data]);
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const prefill = NEW_MAIL[code] ?? { subject: '', body: '' };
  const [subject, setSubject] = useState(prefill.subject);
  const [body, setBody] = useState(prefill.body);
  const current = compose ? null : mails.find((m) => m.id === open) ?? mails[0] ?? null;

  return (
    <main className="max-w-6xl mx-auto px-4 py-5 grid md:grid-cols-[320px_1fr] gap-5 items-start">
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-200 flex items-center justify-between">
          <h2 className="font-semibold">Inbox</h2>
          <button className="btn btn-sm" onClick={() => { setCompose(true); setSubject(prefill.subject); setBody(prefill.body); }}>New email</button>
        </div>
        <div>
          {mails.map((m, i) => (
            <button key={m.id} className={`row ${i < mails.length - 1 ? 'border-b border-zinc-100' : ''}`} aria-current={!compose && current?.id === m.id}
              onClick={() => { setCompose(false); setOpen(m.id); }}>
              <div className="flex justify-between"><b>Dhruva Components</b><span className="note">{fmtTime(m.at)}</span></div>
              <div>{m.mail!.subject}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card p-6">
        {compose ? (
          <form onSubmit={(e) => {
            e.preventDefault();
            post.mutate({ channel: 'mail', subject, text: body }, { onSuccess: () => { setCompose(false); setOpen(null); } });
          }}>
            <h2 className="text-xl font-semibold mb-4">New email</h2>
            <label className="lbl" htmlFor="to">To</label><input id="to" className="input mb-3" value="quotes@dhruva.example" readOnly />
            <label className="lbl" htmlFor="subj">Subject</label><input id="subj" className="input mb-3" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <label className="lbl" htmlFor="body">Message</label>
            <textarea id="body" className="input h-28" value={body} onChange={(e) => setBody(e.target.value)} />
            <button className="btn btn-primary mt-2" disabled={post.isPending || !body.trim()}>Send</button>
          </form>
        ) : current ? (
          <MailView key={current.id} m={current} code={code} />
        ) : null}
      </div>
    </main>
  );
}

function MailView({ m, code }: { m: CustomerMessage; code: string }) {
  const post = usePostMessage(code);
  const mail = m.mail!;
  const [text, setText] = useState(m.kind === 'quote' ? 'We accept.' : '');
  return (
    <div>
      <h2 className="text-xl font-semibold">{mail.subject}</h2>
      <div className="note mb-4">From {mail.from} · {fmtTime(m.at)}</div>
      {mail.rows.length ? (
        <table className="text-[.95rem] w-full max-w-md">
          <tbody>
            {mail.rows.map((r) => (
              <tr key={r.label}><td className="py-1 text-zinc-500">{r.label}</td><td className={r.strong ? 'font-semibold' : ''}>{r.value}</td></tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {mail.paragraphs.map((p, i) => <p key={i} className={i > 0 || mail.rows.length ? 'mt-2' : ''}>{p}</p>)}
      {m.reply ? (
        <div className={`${mail.rows.length ? 'mt-6' : 'mt-4'} border-l-4 border-zinc-200 pl-3 text-zinc-600`}>
          <div className="note">You replied · {fmtTime(m.reply.at)}</div>
          {m.reply.text}
        </div>
      ) : m.canReply ? (
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) post.mutate({ channel: 'mail', text: text.trim(), replyTo: m.id }); }}>
          <textarea className="input h-20 mt-6" aria-label="Reply" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary mt-2" disabled={post.isPending || !text.trim()}>Reply</button>
        </form>
      ) : null}
    </div>
  );
}

function Chat({ code }: { code: string }) {
  const { data } = useMessages(code);
  const post = usePostMessage(code);
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const msgs = (data?.messages ?? []).filter((m) => m.chat).sort((a, b) => a.at - b.at);
  useEffect(() => {
    if (log.current) log.current.scrollTop = 1e6;
  }, [msgs.length]);
  return (
    <main className="max-w-3xl mx-auto px-4 py-5">
      <div className="card flex flex-col h-[520px]">
        <div className="px-5 py-3 border-b border-zinc-200 font-semibold">Dhruva Components</div>
        <div ref={log} className="flex-1 overflow-auto p-5 space-y-3">
          {msgs.map((m) => {
            const mine = m.direction === 'in';
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : ''}`}>
                <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${mine ? 'bg-zinc-900 text-white rounded-br-sm' : 'bg-zinc-100 rounded-bl-sm'}`}>
                  {m.chat}
                  <div className={`text-[11px] mt-1 ${mine ? 'text-zinc-400' : 'text-zinc-500'}`}>{fmtTime(m.at)}</div>
                </div>
              </div>
            );
          })}
        </div>
        <form className="p-3 border-t border-zinc-200 flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim();
          if (!v) return;
          post.mutate({ channel: 'chat', text: v }, { onSuccess: () => setText('') });
        }}>
          <input className="input" placeholder="Message" aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary" disabled={post.isPending}>Send</button>
        </form>
      </div>
    </main>
  );
}

/** The tab belongs to one company: a body without an account is sent as that company's request. */
function withAccount(body: string, code: string): string {
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v) && !('account' in v)) return JSON.stringify({ account: code, ...v });
  } catch {
    // not JSON: the API answers 400
  }
  return body;
}

function Api({ code }: { code: string }) {
  const [req, setReq] = useState(JSON.stringify(API_REQ[code] ?? { account: code }, null, 2));
  const [res, setRes] = useState<{ status: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const statusText = (s: number) => (s === 202 ? '202 Accepted' : s === 200 ? '200 OK' : s === 0 ? 'No connection' : String(s));
  return (
    <main className="max-w-6xl mx-auto px-4 py-5 grid md:grid-cols-2 gap-5 items-start">
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-sm"><Tag tone="gray" className="mr-2">POST</Tag>/v1/rfq</div>
        </div>
        <textarea className="input font-mono !text-sm h-72" aria-label="Request body" value={req} onChange={(e) => setReq(e.target.value)} />
        <button className="btn btn-primary mt-3" disabled={busy}
          onClick={async () => { setBusy(true); setRes(await rawPost('/v1/rfq', withAccount(req, code))); setBusy(false); }}>
          Send request
        </button>
      </div>
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Response</div>
          {res ? <Tag tone={res.status >= 200 && res.status < 300 ? 'green' : 'red'}>{statusText(res.status)}</Tag> : null}
        </div>
        <pre className={`bg-zinc-50 border border-zinc-200 rounded-lg p-3 text-sm font-mono h-72 overflow-auto whitespace-pre-wrap ${res ? '' : 'text-zinc-500'}`}>
          {res ? res.text : 'No request sent yet.'}
        </pre>
      </div>
    </main>
  );
}
