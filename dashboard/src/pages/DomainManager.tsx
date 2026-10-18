import React, { useState, useEffect } from 'react';
import {
  Globe,
  ShieldAlert,
  ShieldCheck,
  Plus,
  Search,
  Trash2,
  CheckCircle,
  XCircle,
  ExternalLink,
  RefreshCw,
  Sliders,
  X
} from 'lucide-react';
import { DomainRule, EndpointSummary } from '../types';
import { api } from '../services/api';
import { CategoryBlocking } from '../components/CategoryBlocking';

interface DomainManagerProps {
  isAdmin: boolean;
  endpoints: EndpointSummary | null;
}

export const DomainManager: React.FC<DomainManagerProps> = ({ isAdmin, endpoints }) => {
  const [blockUnapprovedAi, setBlockUnapprovedAi] = useState(false);
  const [savingAi, setSavingAi] = useState(false);

  useEffect(() => {
    api.getOrgSettings().then((s) => setBlockUnapprovedAi(Boolean(s.block_unapproved_ai))).catch(() => undefined);
  }, []);

  const toggleUnapprovedAi = async (value: boolean) => {
    const msg = value
      ? 'Block every known AI website that is not in your Allowed list?'
      : 'Allow AI websites that are not in your Allowed list?';
    if (!window.confirm(msg)) return;
    setSavingAi(true);
    try {
      const s = await api.updateOrgSettings({ block_unapproved_ai: value });
      setBlockUnapprovedAi(Boolean(s.block_unapproved_ai));
    } catch (err: any) {
      alert(err.message || 'Could not save the setting');
    } finally {
      setSavingAi(false);
    }
  };

  const [domains, setDomains] = useState<DomainRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'BLOCK' | 'ALLOW'>('ALL');
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  // Form State
  const [newDomain, setNewDomain] = useState('');
  const [newAction, setNewAction] = useState<'BLOCK' | 'ALLOW'>('BLOCK');
  const [newCategory, setNewCategory] = useState('Restricted DLP / Shadow AI');
  const [newDescription, setNewDescription] = useState('');
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchDomains = async () => {
    setLoading(true);
    try {
      const res = await api.getDomains();
      setDomains(res.domains || []);
    } catch (err) {
      console.error('Failed to load domains:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDomains();
  }, []);

  const handleToggle = async (id: string, currentStatus: boolean) => {
    try {
      await api.updateDomain(id, { enabled: !currentStatus });
      setDomains((prev) =>
        prev.map((d) => (d.id === id ? { ...d, enabled: !currentStatus } : d))
      );
    } catch (err) {
      console.error('Failed to toggle domain rule:', err);
    }
  };

  const handleDelete = async (id: string, domainName: string) => {
    if (!window.confirm(`Are you sure you want to remove domain rule for "${domainName}"?`)) return;
    try {
      await api.deleteDomain(id);
      setDomains((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      console.error('Failed to delete domain rule:', err);
    }
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!newDomain.trim()) {
      setFormError('Please enter a valid domain address (e.g. example.com).');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.createDomain({
        domain: newDomain.trim(),
        action: newAction,
        category: newCategory.trim() || (newAction === 'BLOCK' ? 'Restricted Shadow AI' : 'Approved GenAI Tool'),
        description: newDescription.trim() || `Traffic policy: ${newAction} ${newDomain.trim()}`,
        enabled: true,
      });

      setShowAddModal(false);
      setNewDomain('');
      setNewDescription('');
      await fetchDomains();
    } catch (err: any) {
      setFormError(err.message || 'Failed to create domain policy.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredDomains = domains.filter((d) => {
    if (activeFilter !== 'ALL' && d.action !== activeFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        d.domain.toLowerCase().includes(q) ||
        (d.category && d.category.toLowerCase().includes(q)) ||
        (d.description && d.description.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const blockedCount = domains.filter((d) => d.action === 'BLOCK' && d.enabled).length;
  const allowedCount = domains.filter((d) => d.action === 'ALLOW' && d.enabled).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Globe size={24} color="var(--color-primary)" />
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-main)', margin: 0 }}>
              Website Controls
            </h1>
          </div>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-muted)', fontSize: '13px', maxWidth: '760px' }}>
            Block whole categories of websites, or single sites. Blocked websites are stopped in the browser before the page
            loads (the domain and all its subdomains). <strong>Allowed</strong> websites are your approved AI tools and your
            exceptions to the category blocking. Only browsers with the AgentShield extension are covered.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={fetchDomains}
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Plus size={16} />
            Add Domain Policy
          </button>
        </div>
      </div>

      <CategoryBlocking isAdmin={isAdmin} />

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        <div className="glass-panel" style={{ padding: '20px', borderLeft: '4px solid var(--color-danger)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>BLOCKED TRAFFIC DOMAINS</span>
            <ShieldAlert size={20} color="var(--color-danger)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--color-danger)' }}>
            {blockedCount}
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Employees see a block page explaining why
          </span>
        </div>

        <div className="glass-panel" style={{ padding: '20px', borderLeft: '4px solid var(--color-primary)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>APPROVED CORPORATE AI</span>
            <ShieldCheck size={20} color="var(--color-primary)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--color-primary)' }}>
            {allowedCount}
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Approved AI tools (prompts are still checked by your rules)
          </span>
        </div>

        <div className="glass-panel" style={{ padding: '20px', borderLeft: `4px solid ${blockUnapprovedAi ? 'var(--color-danger)' : 'var(--border-default)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>UNAPPROVED AI TOOLS</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, cursor: isAdmin ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                checked={blockUnapprovedAi}
                disabled={!isAdmin || savingAi}
                onChange={(e) => toggleUnapprovedAi(e.target.checked)}
              />
              {blockUnapprovedAi ? 'Blocked' : 'Allowed'}
            </label>
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-main)', marginTop: '6px', lineHeight: 1.4 }}>
            When on, AI websites such as DeepSeek, Poe or Character.AI are blocked unless they are in your <strong>Allowed</strong> list below.
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {endpoints && endpoints.total > 0
              ? `${endpoints.online} of ${endpoints.total} browsers online; changes reach them within 5 minutes.`
              : 'No browsers enrolled yet.'}
          </span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="glass-panel" style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setActiveFilter('ALL')}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              border: activeFilter === 'ALL' ? '1.5px solid var(--color-primary)' : '1px solid var(--border-default)',
              background: activeFilter === 'ALL' ? 'var(--color-primary-bg)' : '#ffffff',
              color: activeFilter === 'ALL' ? 'var(--color-primary)' : 'var(--text-muted)',
              fontSize: '12.5px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            All Domains ({domains.length})
          </button>
          <button
            onClick={() => setActiveFilter('BLOCK')}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              border: activeFilter === 'BLOCK' ? '1.5px solid var(--color-danger)' : '1px solid var(--border-default)',
              background: activeFilter === 'BLOCK' ? 'var(--color-danger-bg)' : '#ffffff',
              color: activeFilter === 'BLOCK' ? 'var(--color-danger-text)' : 'var(--text-muted)',
              fontSize: '12.5px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Blocked Traffic ({domains.filter((d) => d.action === 'BLOCK').length})
          </button>
          <button
            onClick={() => setActiveFilter('ALLOW')}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              border: activeFilter === 'ALLOW' ? '1.5px solid var(--color-success)' : '1px solid var(--border-default)',
              background: activeFilter === 'ALLOW' ? 'var(--color-success-bg)' : '#ffffff',
              color: activeFilter === 'ALLOW' ? 'var(--color-success-text)' : 'var(--text-muted)',
              fontSize: '12.5px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Approved Allowed ({domains.filter((d) => d.action === 'ALLOW').length})
          </button>
        </div>

        <div style={{ position: 'relative', width: '300px' }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
          <input
            type="text"
            placeholder="Search domain or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px 8px 36px',
              background: '#ffffff',
              border: '1px solid var(--border-default)',
              borderRadius: '8px',
              color: 'var(--text-main)',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Domain Table */}
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-subtle)' }}>
              <th style={{ padding: '12px 20px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Target Domain</th>
              <th style={{ padding: '12px 20px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Traffic Action</th>
              <th style={{ padding: '12px 20px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Category</th>
              <th style={{ padding: '12px 20px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Description</th>
              <th style={{ padding: '12px 20px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Enforcement</th>
              <th style={{ padding: '12px 20px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredDomains.map((rule) => {
              const isBlock = rule.action === 'BLOCK';
              return (
                <tr
                  key={rule.id}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '14px 20px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '8px',
                          background: isBlock ? 'var(--color-danger-bg)' : 'var(--color-primary-bg)',
                          border: `1px solid ${isBlock ? 'var(--color-danger-border)' : 'var(--color-primary-border)'}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Globe size={16} color={isBlock ? 'var(--color-danger)' : 'var(--color-primary)'} />
                      </div>
                      <div>
                        <span style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '13.5px' }}>
                          {rule.domain}
                        </span>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Matches domain and subdomains
                        </div>
                      </div>
                    </div>
                  </td>

                  <td style={{ padding: '14px 20px' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '3px 9px',
                        borderRadius: '16px',
                        fontSize: '11px',
                        fontWeight: 700,
                        background: isBlock ? 'var(--color-danger-bg)' : 'var(--color-success-bg)',
                        color: isBlock ? 'var(--color-danger-text)' : 'var(--color-success-text)',
                        border: `1px solid ${isBlock ? 'var(--color-danger-border)' : 'var(--color-success-border)'}`,
                      }}
                    >
                      {isBlock ? <XCircle size={12} color="var(--color-danger)" /> : <CheckCircle size={12} color="var(--color-success)" />}
                      {isBlock ? 'BLOCKED' : 'APPROVED'}
                    </span>
                  </td>

                  <td style={{ padding: '14px 20px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {rule.category || '-'}
                  </td>

                  <td style={{ padding: '14px 20px', fontSize: '13px', color: 'var(--text-muted)', maxWidth: '280px' }}>
                    {rule.description || '-'}
                  </td>

                  <td style={{ padding: '14px 20px' }}>
                    <button
                      onClick={() => handleToggle(rule.id, rule.enabled)}
                      style={{
                        padding: '4px 12px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        border: `1px solid ${rule.enabled ? 'var(--color-success-border)' : 'var(--border-default)'}`,
                        background: rule.enabled ? 'var(--color-success-bg)' : 'var(--bg-subtle)',
                        color: rule.enabled ? 'var(--color-success-text)' : 'var(--text-muted)',
                      }}
                    >
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>

                  <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                    <button
                      onClick={() => handleDelete(rule.id, rule.domain)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: '6px',
                        borderRadius: '6px',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = 'var(--color-danger)';
                        e.currentTarget.style.background = 'var(--color-danger-bg)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = 'var(--text-muted)';
                        e.currentTarget.style.background = 'transparent';
                      }}
                      title="Delete domain rule"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filteredDomains.length === 0 && !loading && (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p style={{ margin: 0, fontSize: '14px' }}>No domain rules match your filter.</p>
          </div>
        )}
      </div>

      {/* Add Domain Modal */}
      {showAddModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
        >
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: '500px',
              padding: '26px',
              background: '#ffffff',
              border: '1px solid var(--border-default)',
              borderRadius: '16px',
              boxShadow: '0 20px 45px -10px rgba(0, 0, 0, 0.18)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Globe size={20} color="var(--color-primary)" />
                <h3 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-main)', margin: 0 }}>
                  Add Domain Traffic Rule
                </h3>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>

            {formError && (
              <div
                style={{
                  background: 'var(--color-danger-bg)',
                  border: '1px solid var(--color-danger-border)',
                  color: 'var(--color-danger-text)',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  marginBottom: '16px',
                }}
              >
                {formError}
              </div>
            )}

            <form onSubmit={handleAddSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
                  Domain Name (Host)
                </label>
                <input
                  type="text"
                  placeholder="e.g. pastebin.com or *.ai-tools.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    background: '#ffffff',
                    border: '1px solid var(--border-default)',
                    borderRadius: '6px',
                    color: 'var(--text-main)',
                    fontSize: '13.5px',
                    outline: 'none',
                  }}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
                  Policy Traffic Action
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setNewAction('BLOCK');
                      setNewCategory('Restricted DLP / Shadow AI');
                    }}
                    style={{
                      padding: '10px',
                      borderRadius: '8px',
                      border: newAction === 'BLOCK' ? '2px solid var(--color-danger)' : '1px solid var(--border-default)',
                      background: newAction === 'BLOCK' ? 'var(--color-danger-bg)' : '#ffffff',
                      color: newAction === 'BLOCK' ? 'var(--color-danger-text)' : 'var(--text-secondary)',
                      fontWeight: 700,
                      fontSize: '13px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                    }}
                  >
                    <XCircle size={15} color={newAction === 'BLOCK' ? 'var(--color-danger)' : 'inherit'} /> BLOCK Traffic
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setNewAction('ALLOW');
                      setNewCategory('Sanctioned Corporate GenAI');
                    }}
                    style={{
                      padding: '10px',
                      borderRadius: '8px',
                      border: newAction === 'ALLOW' ? '2px solid var(--color-success)' : '1px solid var(--border-default)',
                      background: newAction === 'ALLOW' ? 'var(--color-success-bg)' : '#ffffff',
                      color: newAction === 'ALLOW' ? 'var(--color-success-text)' : 'var(--text-secondary)',
                      fontWeight: 700,
                      fontSize: '13px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                    }}
                  >
                    <CheckCircle size={15} color={newAction === 'ALLOW' ? 'var(--color-success)' : 'inherit'} /> ALLOW (Approved)
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
                  Category
                </label>
                <input
                  type="text"
                  placeholder="e.g. File Converter, Shadow AI, Code Paste Site"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    background: '#ffffff',
                    border: '1px solid var(--border-default)',
                    borderRadius: '6px',
                    color: 'var(--text-main)',
                    fontSize: '13.5px',
                    outline: 'none',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
                  Business Justification / Reason
                </label>
                <textarea
                  placeholder="Reason for blocking or approving this domain..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    background: '#ffffff',
                    border: '1px solid var(--border-default)',
                    borderRadius: '6px',
                    color: 'var(--text-main)',
                    fontSize: '13px',
                    outline: 'none',
                    resize: 'none',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn-secondary"
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={isSubmitting}
                  style={{ minWidth: '120px' }}
                >
                  {isSubmitting ? 'Saving...' : 'Save Policy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
