import React from 'react';
import {
  LayoutDashboard,
  Sliders,
  ShieldAlert,
  FlaskConical,
  Info,
  Globe,
  Settings,
  Monitor,
  ScrollText,
  PlayCircle,
  KeyRound,
  Users as UsersIcon,
  CreditCard,
  Download as DownloadIcon,
  Building2,
  Gauge,
  Plug,
  UserCircle2,
  Lock,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { EndpointSummary } from '../types';

export type NavTab =
  | 'overview'
  | 'policies'
  | 'domains'
  | 'events'
  | 'endpoints'
  | 'audit'
  | 'sandbox'
  | 'deployment'
  | 'demo'
  | 'limitations'
  | 'users'
  | 'activation'
  | 'account'
  | 'download'
  | 'usage'
  | 'api'
  | 'profile'
  | 'company';

interface SidebarProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  eventCount?: number;
  policyCount?: number;
  domainCount?: number;
  endpoints?: EndpointSummary | null;
  demoMode?: boolean;
  role?: string;
  accountType?: string;
  /** Pages that need a plan first (shown with a lock; opening one explains how to unlock it) */
  lockedTabs?: NavTab[];
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  eventCount,
  policyCount,
  domainCount,
  endpoints,
  demoMode,
  role,
  accountType,
  lockedTabs = [],
}) => {
  type NavItem = { id: NavTab; label: string; icon: React.ReactNode; badge?: string | number; section?: string; soon?: boolean };
  const isEmployee = role === 'EMPLOYEE';
  const isIndividual = accountType === 'INDIVIDUAL';
  const accountItems: NavItem[] = [
    { id: 'account', label: 'Account & plan', icon: <CreditCard size={18} />, section: 'Get started' },
    { id: 'download', label: 'Download', icon: <DownloadIcon size={18} /> },
    { id: 'activation', label: isIndividual ? 'Connect browser' : 'My activation', icon: <KeyRound size={18} /> },
  ];
  // Individual accounts: a personal dashboard; company management is "coming soon"
  const individualItems: NavItem[] = [
    ...accountItems,
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} />, section: 'Monitor' },
    { id: 'events', label: 'Security alerts', icon: <ShieldAlert size={18} />, badge: eventCount },
    { id: 'usage', label: 'Usage & credits', icon: <Gauge size={18} /> },
    { id: 'policies', label: 'Protection rules', icon: <Sliders size={18} />, badge: policyCount, section: 'Settings' },
    { id: 'domains', label: 'Website controls', icon: <Globe size={18} />, badge: domainCount },
    { id: 'api', label: 'API connections', icon: <Plug size={18} /> },
    { id: 'profile', label: 'Profile & security', icon: <UserCircle2 size={18} /> },
    { id: 'sandbox', label: 'Test a prompt', icon: <FlaskConical size={18} />, section: 'Help' },
    { id: 'limitations', label: 'Coverage & limits', icon: <Info size={18} /> },
    { id: 'company', label: 'Company workspace', icon: <Building2 size={18} />, section: 'Teams', soon: true },
  ];
  const navItems: NavItem[] = isEmployee
    ? accountItems
    : isIndividual
    ? individualItems
    : [
        ...accountItems,
        { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} />, section: 'Monitor' },
        { id: 'events', label: 'Prompts & Risk Events', icon: <ShieldAlert size={18} />, badge: eventCount },
        { id: 'endpoints', label: 'Protected Browsers', icon: <Monitor size={18} />, badge: endpoints ? `${endpoints.online}/${endpoints.total}` : undefined },
        { id: 'audit', label: 'Admin Audit Log', icon: <ScrollText size={18} /> },
        { id: 'policies', label: 'Data Protection Rules', icon: <Sliders size={18} />, badge: policyCount, section: 'Configure' },
        { id: 'domains', label: 'Website Controls', icon: <Globe size={18} />, badge: domainCount },
        ...(role === 'ADMIN' ? [{ id: 'users' as NavTab, label: 'Users & Devices', icon: <UsersIcon size={18} /> }] : []),
        { id: 'deployment', label: 'Deployment & Settings', icon: <Settings size={18} /> },
        { id: 'usage', label: 'Usage & credits', icon: <Gauge size={18} /> },
        { id: 'api', label: 'API connections', icon: <Plug size={18} /> },
        { id: 'sandbox', label: 'Test a Prompt', icon: <FlaskConical size={18} />, section: 'Help' },
        ...(demoMode ? [{ id: 'demo' as NavTab, label: 'Guided Demo', icon: <PlayCircle size={18} /> }] : []),
        { id: 'limitations', label: 'Coverage & Limits', icon: <Info size={18} /> },
      ];

  const online = endpoints?.online ?? 0;
  const total = endpoints?.total ?? 0;
  const statusColor = total === 0 ? 'var(--color-warning)' : online > 0 ? 'var(--color-success)' : 'var(--color-danger)';
  const statusText =
    total === 0 ? 'No browsers activated yet' : `${online} of ${total} browsers online`;
  const statusSub =
    total === 0
      ? isIndividual ? 'Download the extension and connect your browser' : 'Invite people in Users & Devices; they activate their browser'
      : `Online = checked in during the last 15 minutes`;

  return (
    <aside className="sidebar">
      {navItems.map((item) => {
        const isActive = activeTab === item.id;
        const locked = lockedTabs.includes(item.id);
        return (
          <React.Fragment key={item.id}>
            {item.section && <div className="nav-section">{item.section}</div>}
            <button
              onClick={() => onTabChange(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`nav-item${isActive ? ' active' : ''}${locked ? ' nav-locked' : ''}`}
              title={locked ? 'Choose a plan in Account & plan to unlock' : undefined}
            >
              {isActive && (
                <motion.span
                  layoutId="nav-active"
                  className="nav-active-bg"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </span>

              {locked ? <Lock size={13} className="nav-lock" aria-label="Locked" /> : item.badge !== undefined && <span className="nav-badge">{item.badge}</span>}
              {item.soon && !locked && <span className="soon-badge">Soon</span>}
            </button>
          </React.Fragment>
        );
      })}

      {!isEmployee && (
      <div style={{ marginTop: 'auto', paddingTop: '16px' }}>
        <button
          onClick={() => onTabChange(isIndividual ? 'activation' : 'endpoints')}
          className="status-card"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--text-main)', marginBottom: '4px' }}>
            <span className={online > 0 ? 'pulse-indicator' : undefined} style={{ width: '8px', height: '8px', borderRadius: '50%', background: statusColor, boxShadow: `0 0 0 3px color-mix(in srgb, ${statusColor} 18%, transparent)` }} />
            <span>{statusText}</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>{statusSub}</div>
        </button>
      </div>
      )}
    </aside>
  );
};
