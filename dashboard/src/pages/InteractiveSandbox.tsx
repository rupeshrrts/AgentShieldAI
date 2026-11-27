import React, { useState } from 'react';
import { FlaskConical, Play, CheckCircle2, ShieldAlert, AlertTriangle, Eye, Shield } from 'lucide-react';
import { EvaluationResult } from '../types';
import { api } from '../services/api';

export const InteractiveSandbox: React.FC = () => {
  const [promptText, setPromptText] = useState('Here is my secret test token: sk-demo-EXAMPLE123456789 please inspect my SQL database.');
  const [siteTarget, setSiteTarget] = useState('chatgpt.com');
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  const presets = [
    {
      label: '1. Secret API Key',
      prompt: 'Here is my secret test token: sk-demo-EXAMPLE123456789 please inspect my SQL database.',
    },
    {
      label: '2. Customer PII Email',
      prompt: 'Please send our financial review to demo.user@example.com before the meeting.',
    },
    {
      label: '3. Restricted Codeword',
      prompt: 'Draft an internal strategy memo regarding PROJECT-ALPHA-CONFIDENTIAL launch schedule.',
    },
    {
      label: '4. Benign Code Query',
      prompt: 'Explain Python list comprehensions and best practices for asynchronous iterators.',
    },
  ];

  const handleEvaluate = async (textToEval = promptText) => {
    setEvaluating(true);
    try {
      const res = await api.evaluatePrompt(textToEval, siteTarget);
      setResult(res);
    } catch (e: any) {
      alert(e.message || 'Evaluation failed');
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-main)' }}>
          Interactive Prompt Tester & Sandbox
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Test your current policy using synthetic text. The tester sends the sample to the AgentShield server for evaluation.
        </p>
      </div>

      {/* Preset Test Case Buttons */}
      <div className="glass-panel" style={{ padding: '16px 20px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '0.5px' }}>
          Standard Test Scenarios (from Implementation Specification)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          {presets.map((p, idx) => (
            <button
              key={idx}
              onClick={() => {
                setPromptText(p.prompt);
                handleEvaluate(p.prompt);
              }}
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                border: '1px solid var(--border-default)',
                background: '#ffffff',
                color: 'var(--text-main)',
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                transition: 'all 0.15s ease',
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.02)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-primary)';
                e.currentTarget.style.background = 'var(--bg-surface-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-default)';
                e.currentTarget.style.background = '#ffffff';
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-main)' }}>{p.label}</span>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.prompt}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Prompt Input Box */}
      <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-main)' }}>
            Test Prompt Content:
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Target Site Scope:</span>
            <input
              type="text"
              value={siteTarget}
              onChange={(e) => setSiteTarget(e.target.value)}
              style={{ background: '#ffffff', border: '1px solid var(--border-default)', color: 'var(--text-main)', padding: '4px 10px', borderRadius: '6px', fontSize: '12px' }}
            />
          </div>
        </div>

        <textarea
          rows={4}
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          placeholder="Paste or type synthetic prompt here..."
          style={{
            width: '100%',
            padding: '14px',
            borderRadius: '8px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-main)',
            fontFamily: 'var(--font-mono)',
            fontSize: '13px',
            lineHeight: 1.5,
            resize: 'vertical',
            outline: 'none',
          }}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn-primary"
            onClick={() => handleEvaluate()}
            disabled={evaluating}
          >
            <Play size={15} />
            {evaluating ? 'Evaluating...' : 'Evaluate Against Policies'}
          </button>
        </div>
      </div>

      {/* Evaluation Results Card */}
      {result && (
        <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                padding: '8px',
                borderRadius: '8px',
                background: result.action === 'BLOCK' ? 'var(--color-danger-bg)' : result.action === 'WARN' ? 'var(--color-warning-bg)' : result.action === 'REDACT' ? 'var(--color-primary-bg)' : 'var(--color-success-bg)',
                color: result.action === 'BLOCK' ? 'var(--color-danger)' : result.action === 'WARN' ? 'var(--color-warning)' : result.action === 'REDACT' ? 'var(--color-primary)' : 'var(--color-success)',
                border: `1px solid ${result.action === 'BLOCK' ? 'var(--color-danger-border)' : result.action === 'WARN' ? 'var(--color-warning-border)' : result.action === 'REDACT' ? 'var(--color-primary-border)' : 'var(--color-success-border)'}`,
              }}>
                <Shield size={22} />
              </div>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>
                  Policy Decision: <span style={{
                    color: result.action === 'BLOCK' ? 'var(--color-danger)' : result.action === 'WARN' ? 'var(--color-warning)' : result.action === 'REDACT' ? 'var(--color-primary)' : 'var(--color-success)'
                  }}>{result.action}</span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {result.reason}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              {result.primary_rule_id && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', padding: '4px 10px', background: 'var(--color-primary-bg)', color: 'var(--color-primary)', borderRadius: '6px', border: '1px solid var(--color-primary-border)' }}>
                  Rule: {result.primary_rule_id}
                </div>
              )}
              {result.highest_severity && (
                <div className={`sev-${result.highest_severity.toLowerCase()}`} style={{ fontSize: '11px', fontWeight: 700, padding: '4px 8px', borderRadius: '4px' }}>
                  {result.highest_severity}
                </div>
              )}
            </div>
          </div>

          {/* Redacted Preview if applicable */}
          {result.redacted_preview && (
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-primary)', marginBottom: '6px' }}>
                Safe Redacted Output:
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-default)', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontSize: '13px' }}>
                {result.redacted_preview}
              </div>
            </div>
          )}

          {/* Findings List */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>
              Detected Pattern Matches ({result.findings.length}):
            </div>
            {result.findings.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--color-success-text)', background: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)', padding: '10px 14px', borderRadius: '6px' }}>
                ✓ No sensitive entities or restricted patterns detected. Safe to submit.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {result.findings.map((f, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      background: 'var(--bg-subtle)',
                      borderRadius: '6px',
                      border: '1px solid var(--border-subtle)',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-primary)', fontWeight: 600 }}>{f.rule_id}</span>
                      <span style={{ padding: '2px 6px', borderRadius: '4px', background: '#ffffff', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                        {f.category}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      Offsets: characters {f.start} to {f.end}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
