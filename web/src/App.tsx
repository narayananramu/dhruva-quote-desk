import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, getUser, setUnauthorizedHandler, setUser } from '@/api/client';
import { useSession } from '@/api/hooks';
import { Header } from '@/components/Header';
import { SessionContext } from '@/lib/session';
import { About } from '@/screens/About';
import { Audit } from '@/screens/Audit';
import { Customer } from '@/screens/Customer';
import { Finance } from '@/screens/Finance';
import { Inventory } from '@/screens/Inventory';
import { Login } from '@/screens/Login';
import { Sales } from '@/screens/Sales';

function Guard() {
  const user = getUser();
  const loc = useLocation();
  const back = { from: loc.pathname + loc.search };
  const session = useSession(!!user);
  if (!user) return <Navigate to="/login" replace state={back} />;
  if (!session.data) {
    if (!session.error) return null;
    if (session.error instanceof ApiError && session.error.status === 401) {
      setUser(null);
      return <Navigate to="/login" replace state={back} />;
    }
    return (
      <main className="max-w-md mx-auto px-4 py-16 text-center">
        <p className="text-zinc-700" role="alert">{session.error.message}</p>
        <button className="btn btn-primary mt-4" disabled={session.isFetching} onClick={() => session.refetch()}>Try again</button>
      </main>
    );
  }
  return (
    <SessionContext.Provider value={session.data}>
      <Header session={session.data} />
      <Outlet />
    </SessionContext.Provider>
  );
}

function Home() {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  const to = user.startsWith('customer:') ? `/customer/${user.slice(9)}` : user === 'finance' ? '/finance' : user === 'inventory' ? '/inventory' : '/sales';
  return <Navigate to={to} replace />;
}

export function App() {
  const nav = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      qc.clear();
      const from = window.location.pathname + window.location.search;
      nav('/login', { replace: true, state: from.startsWith('/login') ? undefined : { from } });
    });
  }, [nav, qc]);
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Guard />}>
        <Route path="/sales/:rfqId?" element={<Sales />} />
        <Route path="/finance" element={<Finance />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/customer/:account?" element={<Customer />} />
        <Route path="/audit/:rfqId?" element={<Audit />} />
        <Route path="/about" element={<About />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
