import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useLogin } from '@/api/hooks';
import { api, setCode as saveCode, setUser } from '@/api/client';

export function Login() {
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('');
  const [codeOnly, setCodeOnly] = useState(false);
  useEffect(() => {
    api<{ codeRequired?: boolean }>('GET', '/health').then((h) => setCodeOnly(!!h.codeRequired)).catch(() => {});
  }, []);
  const login = useLogin();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const qc = useQueryClient();
  const enter = (c?: string) =>
    login.mutate(c, {
      onSuccess: (s) => {
        saveCode(c ?? null);
        setUser(s.user);
        qc.setQueryData(['session'], s);
        nav(from && from !== '/' && !from.startsWith('/login') ? from : '/sales', { replace: true });
      },
    });
  return (
    <div className="max-w-md mx-auto mt-14 px-4">
      <div className="card p-7 text-center">
        <div className="flex items-center justify-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-md bg-zinc-900 text-white grid place-items-center text-sm font-bold" aria-hidden="true">D</div>
          <span className="font-semibold text-lg">Dhruva Quote Desk</span>
        </div>
        <p className="note mb-6">Class demo. All customers and prices are made up.</p>
        {codeOnly ? (
          <form className="text-left" onSubmit={(e) => { e.preventDefault(); enter(code.trim()); }}>
            <label className="lbl" htmlFor="code6">Access code</label>
            <input id="code6" className="input mb-3 font-mono text-center text-lg tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code"
              maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            <button className="btn btn-primary btn-lg w-full" disabled={login.isPending || code.length !== 6}>Sign in</button>
          </form>
        ) : (<>
        <button className="btn btn-primary btn-lg w-full" disabled={login.isPending} onClick={() => enter()}>Enter as Professor</button>
        <button className="link mt-4 !text-sm" onClick={() => setShowCode((v) => !v)} aria-expanded={showCode} aria-controls="codebox">Use access code</button>
        {showCode && (
          <form id="codebox" className="text-left mt-2" onSubmit={(e) => { e.preventDefault(); enter(code.trim()); }}>
            <label className="lbl" htmlFor="code">Access code</label>
            <input id="code" className="input mb-3 font-mono" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="btn w-full" disabled={login.isPending}>Sign in</button>
          </form>
        )}
        </>)}
        {login.error ? <p className="mt-3 text-sm font-semibold text-red-800" role="alert">{login.error.message}</p> : null}
      </div>
    </div>
  );
}
