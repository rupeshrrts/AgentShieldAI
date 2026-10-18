import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Search,
  ChevronDown,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  FileCode,
  MoreVertical,
  X,
  Copy,
  Check,
  RotateCcw,
  ExternalLink,
  Lock,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Users,
  UserCheck,
  UserX,
  Ban,
  Download,
} from 'lucide-react';
import { SecurityEvent, UserRiskSummary } from '../types';
import { api } from '../services/api';
import { UserRiskDossier } from '../components/UserRiskDossier';

interface FilterOption {
  label: string;
  value: string;
}

/** Badge colour for a policy decision. */
export const actionBadgeClass = (action: string): string =>
  action === 'BLOCK'
    ? 'badge-block'
    : action === 'WARN'
    ? 'badge-warn'
    : action === 'REDACT'
    ? 'badge-redact'
    : action === 'MONITOR'
    ? 'badge-monitor'
    : 'badge-allow';

const APPLICATION_OPTIONS: FilterOption[] = [
  { label: 'All', value: 'All' },
  { label: 'Microsoft Copilot', value: 'Copilot' },
  { label: 'Google Gemini', value: 'Gemini' },
  { label: 'ChatGPT', value: 'ChatGPT' },
  { label: 'Claude', value: 'Claude' },
  { label: 'Perplexity', value: 'Perplexity' },
];

const ACCESS_TYPE_OPTIONS: FilterOption[] = [
  { label: 'All', value: 'All' },
  { label: 'Block', value: 'BLOCK' },
  { label: 'Warn', value: 'WARN' },
  { label: 'Redact', value: 'REDACT' },
  { label: 'Monitor', value: 'MONITOR' },
  { label: 'Allow', value: 'ALLOW' },
];

const TIME_FRAME_OPTIONS: FilterOption[] = [
  { label: 'Today', value: 'Today' },
  { label: 'Yesterday', value: 'Yesterday' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'All time', value: 'All' },
];

const DEFAULT_TIME_FRAME = '7d';

interface FilterPillProps {
  id: string;
  label: string;
  value: string;
  options: FilterOption[];
  isDefault: boolean;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onSelect: (value: string) => void;
}

/** A filter shown as "Label: value ▾" with a dropdown of choices. */
const FilterPill: React.FC<FilterPillProps> = ({ id, label, value, options, isDefault, openId, setOpenId, onSelect }) => {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className={`filter-pill ${isDefault ? '' : 'active'}`} onClick={() => setOpenId(openId === id ? null : id)} aria-expanded={openId === id}>
        <span className="filter-pill-label">{label}</span>
        <span className="filter-pill-value">{current}</span>
        <ChevronDown size={14} />
      </button>
      {openId === id && (
        <div className="filter-menu" role="listbox">
          {options.map((opt) => (
            <button key={opt.value} type="button" role="option" aria-selected={value === opt.value} className={value === opt.value ? 'selected' : ''}
              onClick={() => { onSelect(opt.value); setOpenId(null); }}>
              <span>{opt.label}</span>
              {value === opt.value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

interface SecurityEventsProps {
  onBackToOverview?: () => void;
}

export const SecurityEvents: React.FC<SecurityEventsProps> = ({ onBackToOverview }) => {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<SecurityEvent | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Filter Pill States
  const [department, setDepartment] = useState('All');
  const [application, setApplication] = useState('All');
  const [accessType, setAccessType] = useState('All');
  const [timeFrame, setTimeFrame] = useState(DEFAULT_TIME_FRAME);
  const [selectedUserFilter, setSelectedUserFilter] = useState('All');
  const [search, setSearch] = useState('');

  // User Risk & Investigation States
  const [viewMode, setViewMode] = useState<'prompts' | 'users'>('prompts');
  const [userSummaries, setUserSummaries] = useState<UserRiskSummary[]>([]);
  const [selectedUserDossier, setSelectedUserDossier] = useState<UserRiskSummary | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Dropdown open states
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // Sorting
  const [sortBy, setSortBy] = useState<string>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
        setActiveMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadUserSummaries = async () => {
    setLoadingUsers(true);
    try {
      const summaries = await api.getUsersSummary();
      setUserSummaries(summaries);
    } catch (err) {
      console.error('Failed to load employee risk summaries:', err);
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadEvents = async () => {
    setLoading(true);
    try {
      const data = await api.getEvents({
        department: department !== 'All' ? department : undefined,
        application: application !== 'All' ? application : undefined,
        accessType: accessType !== 'All' ? accessType : undefined,
        timeFrame: timeFrame !== 'All' ? timeFrame : undefined,
        user_id: selectedUserFilter !== 'All' ? selectedUserFilter : undefined,
        search: search.trim() || undefined,
        sortBy,
        sortOrder,
        pageSize: 50,
      });
      setEvents(data.items);
      setTotal(data.total);
    } catch (e) {
      console.error('Failed to load prompts audit events:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvents();
    loadUserSummaries();
  }, [department, application, accessType, timeFrame, selectedUserFilter, search, sortBy, sortOrder]);

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
  };

  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    try {
      await api.exportEventsCsv({
        application: application !== 'All' ? application : undefined,
        accessType: accessType !== 'All' ? accessType : undefined,
        timeFrame: timeFrame !== 'All' ? timeFrame : undefined,
        user_id: selectedUserFilter !== 'All' ? selectedUserFilter : undefined,
        search: search.trim() || undefined,
        sortBy,
        sortOrder,
      });
    } catch (e: any) {
      alert(e.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleCopyPrompt = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const hasActiveFilters = department !== 'All' || application !== 'All' || accessType !== 'All' || timeFrame !== DEFAULT_TIME_FRAME || selectedUserFilter !== 'All' || search !== '';

  const handleResetFilters = () => {
    setDepartment('All');
    setApplication('All');
    setAccessType('All');
    setTimeFrame(DEFAULT_TIME_FRAME);
    setSelectedUserFilter('All');
    setSearch('');
  };

  const renderSortIcon = (column: string) => {
    if (sortBy !== column) {
      return <ArrowUpDown size={12} style={{ opacity: 0.35, marginLeft: '4px' }} />;
    }
    return sortOrder === 'asc'
      ? <ArrowUp size={12} style={{ color: 'var(--color-primary)', marginLeft: '4px' }} />
      : <ArrowDown size={12} style={{ color: 'var(--color-primary)', marginLeft: '4px' }} />;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }} ref={dropdownRef}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          {onBackToOverview && (
            <button type="button" className="icon-btn-outline" onClick={onBackToOverview} title="Back to overview" aria-label="Back to overview">
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            <h1 className="page-title">{viewMode === 'prompts' ? 'Prompt activity' : 'Employee risk'}</h1>
            <p className="page-subtitle">
              {viewMode === 'prompts'
                ? 'Every prompt AgentShield checked on AI sites: who sent it, where, which rule matched and what happened.'
                : 'Prompt patterns and risk per employee. Open a profile to warn, restrict or suspend.'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {hasActiveFilters && (
            <button type="button" onClick={handleResetFilters} className="btn-secondary btn-sm">
              <RotateCcw size={13} /> Reset filters
            </button>
          )}
          <button type="button" onClick={handleExport} className="btn-secondary btn-sm" disabled={exporting}
            title="Download the events matching the current filters (up to 50,000 rows)">
            <Download size={13} /> {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
        </div>
      </div>

      {/* View switch */}
      <div className="seg" role="tablist" style={{ alignSelf: 'flex-start' }}>
        <button type="button" role="tab" aria-selected={viewMode === 'prompts'} className={viewMode === 'prompts' ? 'active' : ''} onClick={() => setViewMode('prompts')}>
          <FileCode size={14} /> Prompts <span className="seg-count">{total}</span>
        </button>
        <button type="button" role="tab" aria-selected={viewMode === 'users'} className={viewMode === 'users' ? 'active' : ''} onClick={() => setViewMode('users')}>
          <Users size={14} /> Employees <span className="seg-count">{userSummaries.length}</span>
        </button>
      </div>

      {/* Filters */}
      <div className="glass-panel filter-bar">
        <div className="search-field">
          <Search size={16} />
          <input
            className="input"
            type="text"
            placeholder="Search prompts, employees, rules or sites"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search events"
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <FilterPill id="timeFrame" label="Time" value={timeFrame} options={TIME_FRAME_OPTIONS} isDefault={timeFrame === DEFAULT_TIME_FRAME}
            openId={openDropdown} setOpenId={setOpenDropdown} onSelect={setTimeFrame} />
          <FilterPill id="accessType" label="Decision" value={accessType} options={ACCESS_TYPE_OPTIONS} isDefault={accessType === 'All'}
            openId={openDropdown} setOpenId={setOpenDropdown} onSelect={setAccessType} />
          <FilterPill id="application" label="App" value={application} options={APPLICATION_OPTIONS} isDefault={application === 'All'}
            openId={openDropdown} setOpenId={setOpenDropdown} onSelect={setApplication} />
          <FilterPill id="user" label="Employee" value={selectedUserFilter}
            options={[{ label: 'All', value: 'All' }, ...userSummaries.map((u) => ({ label: u.user_id, value: u.user_id }))]}
            isDefault={selectedUserFilter === 'All'} openId={openDropdown} setOpenId={setOpenDropdown} onSelect={setSelectedUserFilter} />
        </div>
      </div>

      {/* Conditional View: Employee Risk Profiles vs Prompts Table */}
      {viewMode === 'users' ? (
        <div className="glass-panel" style={{ overflow: 'hidden', borderRadius: '12px' }}>
          {/* Quick Metrics Bar for Users */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '12px',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-subtle)',
          }}>
            <div style={{ padding: '12px', background: '#ffffff', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Employees seen</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-main)', marginTop: '4px' }}>{userSummaries.length}</div>
            </div>
            <div style={{ padding: '12px', background: 'var(--color-danger-bg)', borderRadius: '8px', border: '1px solid var(--color-danger-border)' }}>
              <div style={{ fontSize: '11px', color: 'var(--color-danger-text)', textTransform: 'uppercase', fontWeight: 600 }}>High / Critical Risk Users</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--color-danger)', marginTop: '4px' }}>
                {userSummaries.filter(u => u.risk_level === 'CRITICAL' || u.risk_level === 'HIGH').length}
              </div>
            </div>
            <div style={{ padding: '12px', background: 'var(--color-danger-bg)', borderRadius: '8px', border: '1px solid var(--color-danger-border)' }}>
              <div style={{ fontSize: '11px', color: 'var(--color-danger-text)', textTransform: 'uppercase', fontWeight: 600 }}>Suspended Accounts</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--color-danger)', marginTop: '4px' }}>
                {userSummaries.filter(u => u.status === 'SUSPENDED').length}
              </div>
            </div>
            <div style={{ padding: '12px', background: 'var(--color-success-bg)', borderRadius: '8px', border: '1px solid var(--color-success-border)' }}>
              <div style={{ fontSize: '11px', color: 'var(--color-success-text)', textTransform: 'uppercase', fontWeight: 600 }}>Clean / Safe Compliance</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--color-success)', marginTop: '4px' }}>
                {userSummaries.filter(u => u.risk_level === 'LOW').length}
              </div>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px 18px', fontWeight: 600 }}>Employee User ID</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600 }}>Blocked site visits</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600 }}>Risk Status</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600 }}>Governance Action</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600 }}>Good vs Bad Prompts</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600 }}>Total Prompts</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600 }}>Last Active</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, textAlign: 'center' }}>Inspect & Action</th>
                </tr>
              </thead>
              <tbody>
                {userSummaries.map((u) => {
                  const goodPct = u.total_prompts > 0 ? Math.round((u.good_prompts / u.total_prompts) * 100) : 100;
                  const badPct = u.total_prompts > 0 ? Math.round((u.bad_prompts / u.total_prompts) * 100) : 0;
                  const isSuspended = u.status === 'SUSPENDED';

                  return (
                    <tr
                      key={u.user_id}
                      style={{ borderBottom: '1px solid var(--border-subtle)', transition: 'background 0.15s ease' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-hover)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '14px 18px', fontWeight: 700, color: 'var(--color-primary)' }}>
                        <span
                          style={{ cursor: 'pointer', textDecoration: 'underline' }}
                          onClick={() => setSelectedUserDossier(u)}
                        >
                          {u.user_id}
                        </span>
                      </td>
                      <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                        {u.blocked_sites_count ?? 0}
                      </td>
                      <td style={{ padding: '14px 18px' }}>
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '3px 8px',
                          borderRadius: '12px',
                          background: u.risk_level === 'CRITICAL' || u.risk_level === 'HIGH' ? 'var(--color-danger-bg)' : u.risk_level === 'MEDIUM' ? 'var(--color-warning-bg)' : 'var(--color-success-bg)',
                          color: u.risk_level === 'CRITICAL' || u.risk_level === 'HIGH' ? 'var(--color-danger-text)' : u.risk_level === 'MEDIUM' ? 'var(--color-warning-text)' : 'var(--color-success-text)',
                          border: `1px solid ${u.risk_level === 'CRITICAL' || u.risk_level === 'HIGH' ? 'var(--color-danger-border)' : u.risk_level === 'MEDIUM' ? 'var(--color-warning-border)' : 'var(--color-success-border)'}`,
                        }}>
                          {u.risk_level}
                        </span>
                      </td>
                      <td style={{ padding: '14px 18px' }}>
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '3px 8px',
                          borderRadius: '12px',
                          background: isSuspended ? 'var(--color-danger-bg)' : u.status === 'RESTRICTED' ? 'var(--color-warning-bg)' : u.status === 'WARNED' ? 'var(--color-warning-bg)' : 'var(--color-success-bg)',
                          color: isSuspended ? 'var(--color-danger-text)' : u.status === 'RESTRICTED' ? 'var(--color-warning-text)' : u.status === 'WARNED' ? 'var(--color-warning-text)' : 'var(--color-success-text)',
                          border: `1px solid ${isSuspended ? 'var(--color-danger-border)' : u.status === 'RESTRICTED' ? 'var(--color-warning-border)' : u.status === 'WARNED' ? 'var(--color-warning-border)' : 'var(--color-success-border)'}`,
                        }}>
                          {u.status}
                        </span>
                      </td>
                      <td style={{ padding: '14px 18px', minWidth: '180px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
                          <span style={{ color: 'var(--color-success-text)', fontWeight: 600 }}>{u.good_prompts} Clean ({goodPct}%)</span>
                          <span style={{ color: 'var(--color-danger-text)', fontWeight: 600 }}>{u.bad_prompts} Bad ({badPct}%)</span>
                        </div>
                        <div style={{ width: '100%', height: '6px', background: 'var(--border-subtle)', borderRadius: '3px', overflow: 'hidden', display: 'flex' }}>
                          <div style={{ width: `${goodPct}%`, background: 'var(--color-success)' }} />
                          <div style={{ width: `${badPct}%`, background: 'var(--color-danger)' }} />
                        </div>
                      </td>
                      <td style={{ padding: '14px 18px', color: 'var(--text-main)', fontWeight: 700 }}>{u.total_prompts}</td>
                      <td style={{ padding: '14px 18px', color: 'var(--text-muted)', fontSize: '12px' }}>
                        {u.latest_activity ? new Date(u.latest_activity).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ padding: '14px 18px', textAlign: 'center' }}>
                        <button
                          onClick={() => setSelectedUserDossier(u)}
                          style={{
                            background: 'var(--color-primary-bg)',
                            border: '1px solid var(--color-primary-border)',
                            color: 'var(--color-primary)',
                            borderRadius: '6px',
                            padding: '6px 12px',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Inspect & Take Action
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Prompts Table */
        <div className="glass-panel" style={{ overflow: 'hidden', borderRadius: '12px' }}>
          {events.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{
                  background: 'var(--bg-subtle)',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-muted)',
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}>
                <th
                  onClick={() => handleSort('user')}
                  style={{ padding: '12px 18px', fontWeight: 600, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    User {renderSortIcon('user')}
                  </span>
                </th>
                <th
                  onClick={() => handleSort('action')}
                  style={{ padding: '12px 18px', fontWeight: 600, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    Decision {renderSortIcon('action')}
                  </span>
                </th>
                <th
                  onClick={() => handleSort('application')}
                  style={{ padding: '12px 18px', fontWeight: 600, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    Application {renderSortIcon('application')}
                  </span>
                </th>
                <th
                  onClick={() => handleSort('prompt')}
                  style={{ padding: '12px 18px', fontWeight: 600, cursor: 'pointer', userSelect: 'none', minWidth: '280px' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    Prompt Preview {renderSortIcon('prompt')}
                  </span>
                </th>
                <th
                  onClick={() => handleSort('dlp_engine')}
                  style={{ padding: '12px 18px', fontWeight: 600, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    Rule {renderSortIcon('dlp_engine')}
                  </span>
                </th>
                <th style={{ padding: '12px 18px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Reason given
                </th>
                <th
                  onClick={() => handleSort('date')}
                  style={{ padding: '12px 18px', fontWeight: 600, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    Date {renderSortIcon('date')}
                  </span>
                </th>
                <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: 'center', width: '50px' }}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((evt) => {
                const userDisplay = evt.user_id || 'unknown';
                const applicationDisplay = evt.application || evt.site || '—';
                const promptDisplay = evt.prompt_preview || `Text not stored (${evt.outcome.replace(/_/g, ' ')})`;
                const dlpDisplay = evt.rule_id;
                const reasonDisplay = evt.justification || '—';
                const dateDisplay = new Date(evt.occurred_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                });

                const isBlocked = evt.action === 'BLOCK';
                const isWarned = evt.action === 'WARN';
                const isRedacted = evt.action === 'REDACT';

                return (
                  <tr
                    key={evt.id}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-hover)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* User */}
                    <td style={{ padding: '14px 18px', color: 'var(--color-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <span
                        title="Click to inspect this employee's complete dossier & take action"
                        style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '3px' }}
                        onClick={() => {
                          const found = userSummaries.find((u) => u.user_id === evt.user_id);
                          if (found) {
                            setSelectedUserDossier(found);
                          } else {
                            setSelectedUserDossier({
                              user_id: evt.user_id || 'unknown',
                              total_prompts: 1,
                              good_prompts: evt.action === 'ALLOW' ? 1 : 0,
                              bad_prompts: evt.action !== 'ALLOW' ? 1 : 0,
                              blocked_count: evt.action === 'BLOCK' ? 1 : 0,
                              warned_count: evt.action === 'WARN' ? 1 : 0,
                              redacted_count: evt.action === 'REDACT' ? 1 : 0,
                              status: 'ACTIVE',
                              risk_level: evt.action === 'BLOCK' ? 'HIGH' : 'LOW',
                              latest_activity: evt.occurred_at,
                            });
                          }
                        }}
                      >
                        {userDisplay.length > 20 ? `${userDisplay.slice(0, 18)}...` : userDisplay}
                      </span>
                    </td>

                    {/* Decision */}
                    <td style={{ padding: '14px 18px', whiteSpace: 'nowrap' }}>
                      <span className={actionBadgeClass(evt.action)} style={{ fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '4px' }}>
                        {evt.action}
                      </span>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>{evt.outcome.replace(/_/g, ' ')}</div>
                    </td>

                    {/* Application */}
                    <td style={{ padding: '14px 18px', color: 'var(--text-main)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {applicationDisplay}
                    </td>

                    {/* Prompt Preview Snippet */}
                    <td
                      style={{
                        padding: '14px 18px',
                        maxWidth: '360px',
                        cursor: 'pointer',
                      }}
                      onClick={() => setSelectedEvent(evt)}
                      title="Click to inspect full prompt"
                    >
                      <div style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        fontFamily: evt.category === 'SECRET' ? 'var(--font-mono)' : 'inherit',
                        fontSize: evt.category === 'SECRET' ? '12px' : '12.5px',
                        color: 'var(--text-main)',
                        background: 'var(--bg-subtle)',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        border: '1px solid var(--border-subtle)',
                        lineHeight: 1.4,
                      }}>
                        {promptDisplay}
                      </div>
                    </td>

                    {/* DLP Engine */}
                    <td style={{ padding: '14px 18px', whiteSpace: 'nowrap' }}>
                      {dlpDisplay === '-' ? (
                        <span style={{ color: 'var(--text-faint)', fontSize: '12px' }}>—</span>
                      ) : (
                        <span
                          style={{
                            fontSize: '11.5px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '4px',
                            background: isBlocked
                              ? 'var(--color-danger-bg)'
                              : isWarned
                              ? 'var(--color-warning-bg)'
                              : isRedacted
                              ? 'var(--color-primary-bg)'
                              : 'var(--color-success-bg)',
                            color: isBlocked
                              ? 'var(--color-danger-text)'
                              : isWarned
                              ? 'var(--color-warning-text)'
                              : isRedacted
                              ? 'var(--color-primary-text)'
                              : 'var(--color-success-text)',
                            border: `1px solid ${
                              isBlocked
                                ? 'var(--color-danger-border)'
                                : isWarned
                                ? 'var(--color-warning-border)'
                                : isRedacted
                                ? 'var(--color-primary-border)'
                                : 'var(--color-success-border)'
                            }`,
                          }}
                        >
                          {dlpDisplay}
                        </span>
                      )}
                    </td>

                    {/* Employee's reason for proceeding past a warning */}
                    <td style={{ padding: '14px 18px', color: 'var(--text-secondary)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={evt.justification || ''}>
                      {reasonDisplay}
                    </td>

                    {/* Date */}
                    <td style={{ padding: '14px 18px', color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap' }}>
                      {dateDisplay}
                    </td>

                    {/* Action 3-dots Menu */}
                    <td style={{ padding: '14px 16px', textAlign: 'center', position: 'relative' }}>
                      <button
                        onClick={() => setActiveMenuId(activeMenuId === evt.id ? null : evt.id)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--text-muted)',
                          cursor: 'pointer',
                          padding: '4px',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <MoreVertical size={16} />
                      </button>

                      {activeMenuId === evt.id && (
                        <div style={{
                          position: 'absolute',
                          right: '20px',
                          top: '36px',
                          background: '#ffffff',
                          border: '1px solid var(--border-default)',
                          borderRadius: '8px',
                          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                          zIndex: 200,
                          minWidth: '180px',
                          padding: '4px',
                          textAlign: 'left',
                        }}>
                          <button
                            onClick={() => {
                              setSelectedEvent(evt);
                              setActiveMenuId(null);
                            }}
                            style={{
                              width: '100%',
                              padding: '8px 12px',
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text-main)',
                              fontSize: '12px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              borderRadius: '4px',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-hover)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                          >
                            <ExternalLink size={13} color="var(--color-primary)" />
                            Inspect Telemetry
                          </button>

                          <button
                            onClick={() => {
                              const found = userSummaries.find((u) => u.user_id === evt.user_id);
                              if (found) {
                                setSelectedUserDossier(found);
                              } else {
                                setSelectedUserDossier({
                                  user_id: evt.user_id || 'unknown',
                                  total_prompts: 1,
                                  good_prompts: evt.action === 'ALLOW' ? 1 : 0,
                                  bad_prompts: evt.action !== 'ALLOW' ? 1 : 0,
                                  blocked_count: evt.action === 'BLOCK' ? 1 : 0,
                                  warned_count: evt.action === 'WARN' ? 1 : 0,
                                  redacted_count: evt.action === 'REDACT' ? 1 : 0,
                                  status: 'ACTIVE',
                                  risk_level: evt.action === 'BLOCK' ? 'HIGH' : 'LOW',
                                  latest_activity: evt.occurred_at,
                                });
                              }
                              setActiveMenuId(null);
                            }}
                            style={{
                              width: '100%',
                              padding: '8px 12px',
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--color-primary)',
                              fontSize: '12px',
                              fontWeight: 600,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              borderRadius: '4px',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-hover)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                          >
                            <Users size={13} />
                            User Dossier & Actions
                          </button>

                          {evt.prompt_preview && (
                            <button
                              onClick={() => {
                                handleCopyPrompt(evt.prompt_preview || '', evt.id);
                                setActiveMenuId(null);
                              }}
                              style={{
                                width: '100%',
                                padding: '8px 12px',
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-main)',
                                fontSize: '12px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                borderRadius: '4px',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-hover)')}
                              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                            >
                              <Copy size={13} />
                              Copy Prompt Text
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
          )}

        {events.length === 0 && loading && (
          <div className="empty-state"><p>Loading events...</p></div>
        )}

        {events.length === 0 && !loading && (
          <div className="empty-state">
            <div className="empty-state-icon">{hasActiveFilters ? <Search size={22} /> : <ShieldCheck size={22} />}</div>
            <h3>{hasActiveFilters ? 'No events match these filters' : 'No AI activity yet'}</h3>
            <p>
              {hasActiveFilters
                ? 'Nothing was recorded for this combination. Try a longer time frame or clear the filters.'
                : 'Prompts appear here once a connected browser uses an AI site. Each entry shows the employee, the site, the rule that matched and what AgentShield did.'}
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
              {timeFrame !== 'All' && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => setTimeFrame('All')}>Show all time</button>
              )}
              {hasActiveFilters && (
                <button type="button" className="btn-secondary btn-sm" onClick={handleResetFilters}><RotateCcw size={13} /> Reset filters</button>
              )}
            </div>
          </div>
        )}

        {events.length > 0 && (
          <div className="table-foot">
            <span>Showing <strong>{events.length}</strong> of <strong>{total}</strong> events</span>
            <span>Sent by connected browsers</span>
          </div>
        )}
      </div>
      )}

      {/* Forensic Inspection Modal */}
      {selectedEvent && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.45)',
          backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px',
        }}>
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: '640px',
              padding: '26px',
              background: '#ffffff',
              border: '1px solid var(--border-default)',
              borderRadius: '16px',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: '0 20px 45px -10px rgba(0, 0, 0, 0.18)',
            }}
          >
            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <ShieldAlert size={22} color="var(--color-primary)" />
                <div>
                  <h3 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-main)' }}>Prompt Inspection & Telemetry</h3>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>ID: {selectedEvent.id}</span>
                </div>
              </div>
              <button
                onClick={() => setSelectedEvent(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Prompt Content Card */}
            <div style={{ marginBottom: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  User Prompt Payload
                </span>
                {selectedEvent.prompt_preview && (
                  <button
                    onClick={() => handleCopyPrompt(selectedEvent.prompt_preview || '', selectedEvent.id)}
                    className="btn-secondary"
                    style={{ padding: '3px 8px', fontSize: '11px' }}
                  >
                    {copiedId === selectedEvent.id ? <Check size={12} /> : <Copy size={12} />}
                    {copiedId === selectedEvent.id ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
              <div style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '14px',
                fontFamily: selectedEvent.category === 'SECRET' ? 'var(--font-mono)' : 'inherit',
                fontSize: '13px',
                color: 'var(--text-main)',
                whiteSpace: 'pre-wrap',
                maxHeight: '180px',
                overflowY: 'auto',
                lineHeight: 1.5,
              }}>
                {selectedEvent.prompt_preview || 'Prompt text was not stored for this event (privacy setting in Deployment & Settings).'}
              </div>
            </div>

            {/* Forensic Attribute Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12.5px', marginBottom: '18px' }}>
              <div style={{ padding: '10px 14px', background: 'var(--bg-subtle)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Employee</div>
                <div style={{ color: 'var(--text-main)', fontWeight: 600, marginTop: '2px' }}>{selectedEvent.user_id || 'unknown'}</div>
              </div>

              <div style={{ padding: '10px 14px', background: 'var(--bg-subtle)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Website</div>
                <div style={{ color: 'var(--text-main)', fontWeight: 600, marginTop: '2px' }}>{selectedEvent.site}</div>
              </div>

              <div style={{ padding: '10px 14px', background: 'var(--bg-subtle)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>AI Application / Site</div>
                <div style={{ color: 'var(--text-main)', fontWeight: 600, marginTop: '2px' }}>{selectedEvent.application || selectedEvent.site}</div>
              </div>

              <div style={{ padding: '10px 14px', background: 'var(--bg-subtle)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Reason given by employee</div>
                <div style={{ color: 'var(--text-main)', fontWeight: 600, marginTop: '2px' }}>{selectedEvent.justification || '—'}</div>
              </div>

              <div style={{ padding: '10px 14px', background: 'var(--bg-subtle)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Rule & category</div>
                <div style={{ color: 'var(--color-primary)', fontWeight: 600, marginTop: '2px' }}>
                  {selectedEvent.rule_id} ({selectedEvent.category}, {selectedEvent.severity})
                </div>
              </div>

              <div style={{ padding: '10px 14px', background: 'var(--bg-subtle)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Policy Action & Outcome</div>
                <div style={{ marginTop: '2px' }}>
                  <strong style={{
                    color: selectedEvent.action === 'BLOCK' ? 'var(--color-danger)' : selectedEvent.action === 'WARN' ? 'var(--color-warning)' : 'var(--color-success)'
                  }}>
                    {selectedEvent.action}
                  </strong>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>({selectedEvent.outcome})</span>
                </div>
              </div>
            </div>

            {/* Timestamp & System Version */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              background: 'var(--bg-subtle)',
              borderRadius: '8px',
              fontSize: '11.5px',
              color: 'var(--text-muted)',
              marginBottom: '18px',
              border: '1px solid var(--border-subtle)',
            }}>
              <span>Timestamp: <strong style={{ color: 'var(--text-main)' }}>{new Date(selectedEvent.occurred_at).toUTCString()}</strong></span>
              <span>Client Version: <strong style={{ color: 'var(--text-main)' }}>v{selectedEvent.extension_version}</strong></span>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                className="btn-secondary"
                onClick={() => setSelectedEvent(null)}
                style={{ padding: '8px 18px', fontSize: '13px' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Risk & Governance Dossier Modal */}
      {selectedUserDossier && (
        <UserRiskDossier
          user={selectedUserDossier}
          onClose={() => setSelectedUserDossier(null)}
          onActionApplied={() => {
            loadUserSummaries();
            loadEvents();
          }}
        />
      )}
    </div>
  );
};
