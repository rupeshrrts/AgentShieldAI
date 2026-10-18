import React, { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { UserSession } from '../types';

/**
 * Opened from the confirmation email (/#verify=<token>). Confirms the address and signs
 * the user in. The token is in the URL fragment, so it never reaches a server log.
 */
export const VerifyEmail: React.FC<{ token: string; onDone: (s: UserSession) => void; onCancel: () => void }> = ({ token, onDone, onCancel }) => {
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // the link works once; React may run effects twice in development
    started.current = true;
    api.verifyEmail(token).then(onDone).catch((e) => setError(e.message));
  }, [token]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', background: 'var(--bg-primary)' }}>
      <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', padding: '32px', textAlign: 'center', boxShadow: 'var(--shadow-lg)' }}>
        <img src="/logo.png" alt="AgentShield" width={52} height={52} style={{ marginBottom: '12px' }} />
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-main)' }}>
          {error ? 'Link not valid' : 'Confirming your email...'}
        </h1>
        {error && (
          <>
            <p style={{ fontSize: '13px', color: 'var(--color-danger-text)', marginTop: '10px' }}>{error}</p>
            <button type="button" className="btn-secondary" onClick={onCancel} style={{ marginTop: '16px', justifyContent: 'center', width: '100%' }}>
              Go to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
};
