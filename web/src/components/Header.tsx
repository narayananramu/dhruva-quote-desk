import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import type { Role, Session } from '@/api/contract';
import { SettingsDialog } from './SettingsDialog';
import { PhoneCallDialog } from './PhoneCallDialog';

const TABS: { role: Role; to: string; label: string }[] = [
  { role: 'sales', to: '/sales', label: 'Sales' },
  { role: 'finance', to: '/finance', label: 'Finance' },
  { role: 'inventory', to: '/inventory', label: 'Inventory' },
  { role: 'customer', to: '/customer', label: 'Customer' },
];

export function Header({ session }: { session: Session }) {
  const loc = useLocation();
  const [settings, setSettings] = useState(false);
  const [phone, setPhone] = useState(false);
  const onSales = loc.pathname.startsWith('/sales');
  const staff = session.roles.some((r) => r !== 'customer');
  return (
    <header className="bg-white border-b border-zinc-200">
      <div className="max-w-6xl mx-auto px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-zinc-900 text-white grid place-items-center text-sm font-bold" aria-hidden="true">D</div>
          <span className="font-semibold">Quote Desk</span>
        </div>
        <nav className="bg-zinc-100 rounded-lg p-1 flex gap-1" aria-label="Role">
          {TABS.filter((t) => session.roles.includes(t.role)).map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => `tab inline-flex items-center ${isActive ? 'active' : ''}`}>
              {t.label}
            </NavLink>
          ))}
        </nav>
        {staff && (
          <NavLink to="/audit" className={({ isActive }) => `link ${isActive ? 'font-bold' : ''}`}>
            Audit trail
          </NavLink>
        )}
        <div className="ml-auto flex items-center gap-3">
          {onSales && session.roles.includes('sales') && (
            <button className="link" onClick={() => setPhone(true)}>
              + Phone call
            </button>
          )}
          <NavLink to="/about" className="btn btn-sm">
            About
          </NavLink>
          {staff && (
            <button className="btn btn-sm !px-2" onClick={() => setSettings(true)} aria-label="Settings" title="Settings">
              ⚙ Settings
            </button>
          )}
        </div>
      </div>
      {staff && <SettingsDialog open={settings} onOpenChange={setSettings} />}
      {session.roles.includes('sales') && <PhoneCallDialog open={phone} onOpenChange={setPhone} accounts={session.accounts} />}
    </header>
  );
}
