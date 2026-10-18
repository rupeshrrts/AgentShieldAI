import React, { useState, useEffect } from 'react';
import {
  X,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Ban,
  RotateCcw,
  Download,
  Search,
  ExternalLink,
  Copy,
  Check,
  UserCheck,
  UserX,
  FileText,
  Clock,
  Layers,
  ArrowRight
} from 'lucide-react';
import { SecurityEvent, UserRiskSummary } from '../types';
import { api } from '../services/api';

interface UserRiskDossierProps {
  user: UserRiskSummary;
  onClose: () => void;
  onActionApplied: () => void;
}

export const UserRiskDossier: React.FC<UserRiskDossierProps> = ({
  user,
  onClose,
  onActionApplied,
}) => {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<'ALL' | 'BAD' | 'GOOD'>('ALL');
  const [search, setSearch] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Administrative action modal
  const [confirmAction, setConfirmAction] = useState<'SUSPEND' | 'RESTRICT' | 'WARN' | 'RESTORE' | null>(null);
  const [actionNotes, setActionNotes] = useState('');

  // Fetch prompts for this specific user
  const loadUserPrompts = async () => {
    setLoading(true);
    try {
      const data = await api.getEvents({
        user_id: user.user_id,
        pageSize: 100,
        sortBy: 'date',
        sortOrder: 'desc',
      });
      setEvents(data.items || []);
    } catch (err) {
      console.error('Failed to load user prompts:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUserPrompts();
  }, [user.user_id]);

  const handleApplyAction = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    try {
      await api.takeUserAction(user.user_id, confirmAction, actionNotes.trim() || undefined);
      setConfirmAction(null);
      setActionNotes('');
      onActionApplied();
      loadUserPrompts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to apply governance action');
    } finally {
      setActionLoading(false);
    }
  };

  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(events, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `audit_dossier_${user.user_id}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleCopyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Filter prompts according to active sub-tab and search input
  const filteredEvents = events.filter((e) => {
    if (filterType === 'BAD' && e.action === 'ALLOW') return false;
    if (filterType === 'GOOD' && e.action !== 'ALLOW') return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const textMatch = (e.prompt || e.prompt_preview || '').toLowerCase().includes(q);
      const ruleMatch = (e.rule_id || '').toLowerCase().includes(q);
      const siteMatch = (e.site || '').toLowerCase().includes(q);
      return textMatch || ruleMatch || siteMatch;
    }
    return true;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'SUSPENDED':
        return {
          label: 'SUSPENDED',
          bg: '#fef2f2',
          border: '#fecaca',
          color: '#991b1b',
          icon: <Ban size={13} />,
        };
      case 'RESTRICTED':
        return {
          label: 'RESTRICTED (STRICT)',
          bg: '#fffbeb',
          border: '#fde68a',
          color: '#92400e',
          icon: <AlertTriangle size={13} />,
        };
      case 'WARNED':
        return {
          label: 'WARNED / ON WATCH',
          bg: '#fffbeb',
          border: '#fde68a',
          color: '#b45309',
          icon: <AlertTriangle size={13} />,
        };
      default:
        return {
          label: 'ACTIVE / GOOD STANDING',
          bg: '#f0fdf4',
          border: '#bbf7d0',
          color: '#166534',
          icon: <UserCheck size={13} />,
        };
    }
  };

  const getRiskBadge = (level: string) => {
    switch (level) {
      case 'CRITICAL':
        return { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', label: 'CRITICAL RISK' };
      case 'HIGH':
        return { bg: '#fff7ed', border: '#ffedd5', color: '#c2410c', label: 'HIGH RISK' };
      case 'MEDIUM':
        return { bg: '#fffbeb', border: '#fde68a', color: '#92400e', label: 'ELEVATED RISK' };
      default:
        return { bg: '#f0fdf4', border: '#bbf7d0', color: '#166534', label: 'SAFE' };
    }
  };

  const statusInfo = getStatusBadge(user.status);
  const riskInfo = getRiskBadge(user.risk_level);
  const goodPct = user.total_prompts > 0 ? Math.round((user.good_prompts / user.total_prompts) * 100) : 100;
  const badPct = user.total_prompts > 0 ? Math.round((user.bad_prompts / user.total_prompts) * 100) : 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.5)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={onClose}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: '1060px',
          maxHeight: '92vh',
          background: '#ffffff',
          border: '1px solid var(--border-default)',
          borderRadius: '16px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 45px -10px rgba(0, 0, 0, 0.18), 0 0 1px 1px rgba(0, 0, 0, 0.05)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 28px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: '#ffffff',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div
              style={{
                width: '46px',
                height: '46px',
                borderRadius: '12px',
                background: user.status === 'SUSPENDED' ? 'var(--color-danger-bg)' : 'var(--color-primary-bg)',
                border: `1px solid ${user.status === 'SUSPENDED' ? 'var(--color-danger-border)' : 'var(--color-primary-border)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: user.status === 'SUSPENDED' ? 'var(--color-danger)' : 'var(--color-primary)',
              }}
            >
              <UserX size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-main)', margin: 0 }}>
                  {user.user_id}
                </h2>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.3px',
                    padding: '3px 10px',
                    borderRadius: '20px',
                    background: statusInfo.bg,
                    border: `1px solid ${statusInfo.border}`,
                    color: statusInfo.color,
                  }}
                >
                  {statusInfo.icon}
                  {statusInfo.label}
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.3px',
                    padding: '3px 10px',
                    borderRadius: '20px',
                    background: riskInfo.bg,
                    border: `1px solid ${riskInfo.border}`,
                    color: riskInfo.color,
                  }}
                >
                  {riskInfo.label}
                </span>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                Blocked site visits: <strong style={{ color: 'var(--text-secondary)' }}>{user.blocked_sites_count ?? 0}</strong>
                {user.latest_activity && (
                  <> • Last active: {new Date(user.latest_activity).toLocaleString()}</>
                )}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={handleExportJson}
              className="btn-secondary"
              style={{ padding: '6px 12px', fontSize: '12px' }}
              title="Download entire forensic history for this employee"
            >
              <Download size={14} />
              Export Dossier
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Action Banner / Remediation Toolbar */}
        <div
          style={{
            padding: '12px 28px',
            background: 'var(--bg-subtle)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Enforcement Actions:
            </span>
            {user.notes && (
              <span
                style={{
                  fontSize: '12px',
                  color: 'var(--color-warning-text)',
                  background: 'var(--color-warning-bg)',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--color-warning-border)',
                }}
              >
                Note: {user.notes}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {user.status !== 'SUSPENDED' && (
              <button
                onClick={() => {
                  setConfirmAction('SUSPEND');
                  setActionNotes('Repeated sensitive prompt violations on public AI');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--color-danger-bg)',
                  border: '1px solid var(--color-danger-border)',
                  color: 'var(--color-danger-text)',
                  borderRadius: '8px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <Ban size={13} color="var(--color-danger)" />
                Suspend AI Access
              </button>
            )}

            {user.status !== 'RESTRICTED' && (
              <button
                onClick={() => {
                  setConfirmAction('RESTRICT');
                  setActionNotes('Enforce strict zero-tolerance mode for user');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--color-warning-bg)',
                  border: '1px solid var(--color-warning-border)',
                  color: 'var(--color-warning-text)',
                  borderRadius: '8px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <AlertTriangle size={13} color="var(--color-warning)" />
                Enforce Strict Mode
              </button>
            )}

            {user.status === 'ACTIVE' && (
              <button
                onClick={() => {
                  setConfirmAction('WARN');
                  setActionNotes('Security retraining reminder issued for prompt compliance');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--color-warning-bg)',
                  border: '1px solid var(--color-warning-border)',
                  color: 'var(--color-warning-text)',
                  borderRadius: '8px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <AlertTriangle size={13} color="var(--color-warning)" />
                Issue Compliance Warning
              </button>
            )}

            {user.status !== 'ACTIVE' && (
              <button
                onClick={() => {
                  setConfirmAction('RESTORE');
                  setActionNotes('User completed compliance review and good standing restored');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--color-success-bg)',
                  border: '1px solid var(--color-success-border)',
                  color: 'var(--color-success-text)',
                  borderRadius: '8px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <UserCheck size={13} color="var(--color-success)" />
                Restore Good Standing
              </button>
            )}
          </div>
        </div>

        {/* Action Confirmation Modal */}
        {confirmAction && (
          <div
            style={{
              padding: '16px 28px',
              background: 'var(--color-primary-bg)',
              borderBottom: '1px solid var(--color-primary-border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ color: 'var(--text-main)', fontSize: '13px' }}>
                Confirm Governance Action: <span style={{ color: 'var(--color-primary)' }}>{confirmAction}</span> for {user.user_id}
              </strong>
              <button
                onClick={() => setConfirmAction(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Reason or audit note (e.g. 'Suspending user due to repeated API key leakage')..."
                value={actionNotes}
                onChange={(e) => setActionNotes(e.target.value)}
                style={{
                  flex: 1,
                  background: '#ffffff',
                  border: '1px solid var(--border-default)',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  color: 'var(--text-main)',
                  fontSize: '13px',
                  outline: 'none',
                }}
              />
              <button
                onClick={handleApplyAction}
                disabled={actionLoading}
                className={confirmAction === 'SUSPEND' ? 'btn-danger' : 'btn-primary'}
                style={{ padding: '8px 18px', fontSize: '12.5px' }}
              >
                {actionLoading ? 'Applying...' : `Confirm ${confirmAction}`}
              </button>
            </div>
          </div>
        )}

        {/* Stats Row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '14px',
            padding: '20px 28px 12px 28px',
          }}
        >
          {/* Card 1: Total */}
          <div
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '10px',
              padding: '14px',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
              Total Prompts
            </div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-main)', marginTop: '4px' }}>
              {user.total_prompts}
            </div>
          </div>

          {/* Card 2: Good Prompts */}
          <div
            style={{
              background: 'var(--color-success-bg)',
              border: '1px solid var(--color-success-border)',
              borderRadius: '10px',
              padding: '14px',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--color-success-text)', textTransform: 'uppercase', fontWeight: 600 }}>
              Clean / Allowed Prompts
            </div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--color-success-text)', marginTop: '4px' }}>
              {user.good_prompts} <span style={{ fontSize: '13px', color: 'var(--color-success)' }}>({goodPct}%)</span>
            </div>
          </div>

          {/* Card 3: Bad Prompts */}
          <div
            style={{
              background: 'var(--color-danger-bg)',
              border: '1px solid var(--color-danger-border)',
              borderRadius: '10px',
              padding: '14px',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--color-danger-text)', textTransform: 'uppercase', fontWeight: 600 }}>
              Violations (Bad Prompts)
            </div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--color-danger-text)', marginTop: '4px' }}>
              {user.bad_prompts} <span style={{ fontSize: '13px', color: 'var(--color-danger)' }}>({badPct}%)</span>
            </div>
          </div>

          {/* Card 4: Action Breakdown */}
          <div
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '10px',
              padding: '14px',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
              Action Breakdown
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px', fontSize: '12px', fontWeight: 700 }}>
              <span style={{ color: 'var(--color-danger)' }}>{user.blocked_count} Block</span>
              <span style={{ color: 'var(--color-warning)' }}>{user.warned_count} Warn</span>
              <span style={{ color: 'var(--color-primary)' }}>{user.redacted_count} Redact</span>
            </div>
          </div>
        </div>

        {/* Filter Toolbar for Prompts */}
        <div
          style={{
            padding: '12px 28px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {/* Sub-tabs: All vs Bad vs Good */}
          <div style={{ display: 'flex', gap: '6px', background: 'var(--bg-subtle)', padding: '4px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
            <button
              onClick={() => setFilterType('ALL')}
              style={{
                background: filterType === 'ALL' ? '#ffffff' : 'transparent',
                border: filterType === 'ALL' ? '1px solid var(--border-default)' : '1px solid transparent',
                color: filterType === 'ALL' ? 'var(--text-main)' : 'var(--text-muted)',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: filterType === 'ALL' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
              }}
            >
              All Prompts ({events.length})
            </button>
            <button
              onClick={() => setFilterType('BAD')}
              style={{
                background: filterType === 'BAD' ? 'var(--color-danger-bg)' : 'transparent',
                border: filterType === 'BAD' ? '1px solid var(--color-danger-border)' : '1px solid transparent',
                color: filterType === 'BAD' ? 'var(--color-danger-text)' : 'var(--text-muted)',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <ShieldAlert size={13} color="var(--color-danger)" />
              Violations Only ({events.filter(e => e.action !== 'ALLOW').length})
            </button>
            <button
              onClick={() => setFilterType('GOOD')}
              style={{
                background: filterType === 'GOOD' ? 'var(--color-success-bg)' : 'transparent',
                border: filterType === 'GOOD' ? '1px solid var(--color-success-border)' : '1px solid transparent',
                color: filterType === 'GOOD' ? 'var(--color-success-text)' : 'var(--text-muted)',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <ShieldCheck size={13} color="var(--color-success)" />
              Clean Only ({events.filter(e => e.action === 'ALLOW').length})
            </button>
          </div>

          {/* Search inside user prompt feed */}
          <div style={{ position: 'relative', width: '280px' }}>
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search in this user's prompts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: '100%',
                background: '#ffffff',
                border: '1px solid var(--border-default)',
                borderRadius: '6px',
                padding: '6px 10px 6px 32px',
                fontSize: '12px',
                color: 'var(--text-main)',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Prompts Scrollable Feed */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px 24px 28px' }}>
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading user prompt history...
            </div>
          ) : filteredEvents.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
              No prompts match the selected filter.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {filteredEvents.map((evt) => {
                const isBlocked = evt.action === 'BLOCK';
                const isWarned = evt.action === 'WARN';
                const isRedacted = evt.action === 'REDACT';
                const promptText = evt.prompt || evt.prompt_preview || 'No prompt content recorded.';

                const borderColor = isBlocked ? 'var(--color-danger-border)' : isWarned ? 'var(--color-warning-border)' : isRedacted ? 'var(--color-primary-border)' : 'var(--border-subtle)';
                const badgeClass = isBlocked ? 'badge-block' : isWarned ? 'badge-warn' : isRedacted ? 'badge-redact' : 'badge-allow';

                return (
                  <div
                    key={evt.id}
                    style={{
                      background: '#ffffff',
                      border: `1px solid ${borderColor}`,
                      borderLeft: `4px solid ${isBlocked ? 'var(--color-danger)' : isWarned ? 'var(--color-warning)' : isRedacted ? 'var(--color-primary)' : 'var(--color-success)'}`,
                      borderRadius: '8px',
                      padding: '12px 16px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.02)',
                    }}
                  >
                    {/* Row 1: Badges & Metadata */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className={badgeClass} style={{ fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px' }}>
                          {evt.action}
                        </span>

                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-main)' }}>
                          {evt.application || evt.site || 'ChatGPT'}
                        </span>

                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Rule: <code style={{ color: 'var(--color-primary)' }}>{evt.rule_id}</code>
                        </span>

                        {evt.severity && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            Severity: <strong style={{ color: 'var(--text-main)' }}>{evt.severity}</strong>
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {new Date(evt.occurred_at).toLocaleString()}
                        </span>
                        <button
                          onClick={() => handleCopyText(promptText, evt.id)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: copiedId === evt.id ? 'var(--color-success)' : 'var(--text-muted)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                          }}
                          title="Copy prompt text"
                        >
                          {copiedId === evt.id ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </div>
                    </div>

                    {/* Row 2: Prompt text */}
                    <div
                      style={{
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '6px',
                        padding: '10px 12px',
                        fontFamily: evt.category === 'SECRET' ? 'var(--font-mono)' : 'inherit',
                        fontSize: '12.5px',
                        lineHeight: '1.5',
                        color: 'var(--text-main)',
                        maxHeight: '120px',
                        overflowY: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {promptText}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
