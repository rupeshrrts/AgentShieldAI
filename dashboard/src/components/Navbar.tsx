import React from 'react';
import { LogOut } from 'lucide-react';
import { UserSession } from '../types';

interface NavbarProps {
  session: UserSession | null;
  onLogout: () => void;
  policyVersion?: number;
}

export const Navbar: React.FC<NavbarProps> = ({ session, onLogout, policyVersion }) => {
  const initial = (session?.email || '?').charAt(0).toUpperCase();

  return (
    <header className="topbar">
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <img src="/logo.png" alt="" width={32} height={32} />
        <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-main)', letterSpacing: '-0.3px' }}>AgentShield</span>
        <span style={{ width: '1px', height: '18px', background: 'var(--border-subtle)', margin: '0 4px' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{session?.organization_name || '—'}</span>
      </div>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        {policyVersion !== undefined && (
          <span className="chip" title="Highest policy version; increases every time a rule changes">
            Policy v{policyVersion}
          </span>
        )}

        {session && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="avatar" aria-hidden="true">{initial}</div>
            <div style={{ lineHeight: 1.25 }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-main)' }}>{session.email}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{session.role.toLowerCase()}</div>
            </div>
            <button onClick={onLogout} title="Sign out" aria-label="Sign out" className="icon-btn">
              <LogOut size={16} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
