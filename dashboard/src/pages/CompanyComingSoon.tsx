import React from 'react';
import { motion } from 'framer-motion';
import { BarChart3, Building2, KeyRound, Users } from 'lucide-react';

/** Company workspaces are not open to the public yet; this page only explains what is coming. */
export const CompanyComingSoon: React.FC = () => (
  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 820 }}>
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1 className="page-title">Company workspace</h1>
        <span className="soon-badge soon-badge-lg">Coming soon</span>
      </div>
      <p className="page-subtitle">AgentShield for teams is on its way. Your individual account keeps working exactly as it does today.</p>
    </div>
    <section className="glass-panel" style={{ padding: 24 }}>
      <div className="feature-grid">
        {[
          { icon: <Users size={18} />, title: 'Employee management', text: 'Invite colleagues, assign seats, manage their browsers.' },
          { icon: <KeyRound size={18} />, title: 'Central licensing', text: 'One subscription for the whole team, with seat controls.' },
          { icon: <BarChart3 size={18} />, title: 'Company analytics', text: 'Risk trends by department, incidents and reports.' },
          { icon: <Building2 size={18} />, title: 'Company policies', text: 'One set of protection rules for every employee.' },
        ].map((f) => (
          <div key={f.title} className="feature-tile">
            <div className="icon-tile" style={{ background: 'var(--color-primary-bg)', color: 'var(--color-primary)' }}>{f.icon}</div>
            <div><strong>{f.title}</strong><p className="cell-sub">{f.text}</p></div>
          </div>
        ))}
      </div>
      <p className="cell-sub" style={{ marginTop: 16 }}>Interested in an early company workspace? Contact AgentShield support.</p>
    </section>
  </motion.div>
);
