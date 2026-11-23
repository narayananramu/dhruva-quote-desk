import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useLogin } from '@/api/hooks';
import { setUser } from '@/api/client';

export function Login() {
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('DHRUVA-DEMO');
  const login = useLogin();
  const nav = useNavigate();
  const qc = useQueryClient();
  const enter = (c?: string) =>
    login.mutate(c, {
      onSuccess: (s) => {
        setUser(s.user);
        qc.setQueryData(['session'], s);
        nav('/sales');
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
        <button className="btn btn-primary btn-lg w-full" disabled={login.isPending} onClick={() => enter()}>Enter as Professor</button>
        <button className="link mt-4 !text-sm" onClick={() => setShowCode((v) => !v)} aria-expanded={showCode} aria-controls="codebox">Use access code</button>
        {showCode && (
          <form id="codebox" className="text-left mt-2" onSubmit={(e) => { e.preventDefault(); enter(code.trim()); }}>
            <label className="lbl" htmlFor="code">Access code</label>
            <input id="code" className="input mb-3 font-mono" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="btn w-full" disabled={login.isPending}>Sign in</button>
          </form>
        )}
        {login.error ? <p className="mt-3 text-sm font-semibold text-red-800" role="alert">{login.error.message}</p> : null}
      </div>
    </div>
  );
}
