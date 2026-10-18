import React from 'react';

/** Icon tile + title + one-paragraph explanation at the top of a settings section. */
export const SectionHeader: React.FC<{ icon: React.ReactNode; title: string; right?: React.ReactNode; children?: React.ReactNode }> = ({
  icon,
  title,
  right,
  children,
}) => (
  <div className="section-head">
    <div className="icon-tile section-icon">{icon}</div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <h2 className="section-title">{title}</h2>
      {children && <p className="section-hint">{children}</p>}
    </div>
    {right}
  </div>
);
