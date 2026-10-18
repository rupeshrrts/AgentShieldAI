import React from 'react';
import { motion } from 'framer-motion';

/** Hero artwork: a glowing shield over a circuit of protected AI connections (pure SVG, no external images). */
export const HeroShield: React.FC = () => (
  <div className="hero-art" aria-hidden="true">
    <motion.div className="orbit orbit-1" animate={{ rotate: 360 }} transition={{ duration: 60, repeat: Infinity, ease: 'linear' }} />
    <motion.div className="orbit orbit-2" animate={{ rotate: -360 }} transition={{ duration: 90, repeat: Infinity, ease: 'linear' }} />
    <svg viewBox="0 0 440 440" className="hero-svg">
      <defs>
        <linearGradient id="shieldFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="55%" stopColor="#1d4ed8" />
          <stop offset="100%" stopColor="#0b1530" />
        </linearGradient>
        <linearGradient id="shieldEdge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#93c5fd" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.3" />
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="45%" r="50%">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
        </radialGradient>
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      <circle cx="220" cy="210" r="190" fill="url(#glow)" />

      {/* circuit lines to AI tools */}
      {[
        [220, 210, 60, 90], [220, 210, 380, 80], [220, 210, 50, 330], [220, 210, 390, 340], [220, 210, 220, 30],
      ].map(([x1, y1, x2, y2], i) => (
        <g key={i}>
          <path d={`M${x1} ${y1} L${x2} ${y1 + (y2 - y1) * 0.5} L${x2} ${y2}`} stroke="#60a5fa" strokeOpacity="0.35" strokeWidth="1.5" fill="none" />
          <motion.circle r="3.5" fill="#7dd3fc"
            initial={{ opacity: 0 }}
            animate={{ cx: [x1, x2, x2], cy: [y1, y1 + (y2 - y1) * 0.5, y2], opacity: [0, 1, 0] }}
            transition={{ duration: 3.2, repeat: Infinity, delay: i * 0.6, ease: 'easeInOut' }} />
          <circle cx={x2} cy={y2} r="16" fill="#0f1d3d" stroke="#60a5fa" strokeOpacity="0.6" />
          <circle cx={x2} cy={y2} r="5" fill="#38bdf8" />
        </g>
      ))}

      {/* shield */}
      <path d="M220 70 L330 112 V205 C330 285 275 335 220 358 C165 335 110 285 110 205 V112 Z" fill="#0b1530" opacity="0.55" filter="url(#soft)" transform="translate(0 14)" />
      <motion.path
        d="M220 70 L330 112 V205 C330 285 275 335 220 358 C165 335 110 285 110 205 V112 Z"
        fill="url(#shieldFill)" stroke="url(#shieldEdge)" strokeWidth="3"
        initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 1.4, ease: 'easeOut' }}
      />
      <path d="M220 92 L310 126 V205 C310 272 265 314 220 334 C175 314 130 272 130 205 V126 Z" fill="none" stroke="#bfdbfe" strokeOpacity="0.25" strokeWidth="1.5" />

      {/* lock */}
      <rect x="182" y="198" width="76" height="62" rx="12" fill="#e0f2fe" />
      <path d="M196 198 V180 C196 164 206 154 220 154 C234 154 244 164 244 180 V198" fill="none" stroke="#e0f2fe" strokeWidth="11" strokeLinecap="round" />
      <circle cx="220" cy="224" r="8" fill="#1d4ed8" />
      <rect x="216.5" y="228" width="7" height="16" rx="3.5" fill="#1d4ed8" />
    </svg>

    {/* floating "blocked" cards */}
    <motion.div className="float-card fc-1" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: [0, -6, 0] }}
      transition={{ opacity: { delay: 0.8 }, y: { duration: 5, repeat: Infinity, ease: 'easeInOut' } }}>
      <span className="dot dot-red" /> API key blocked
      <code>sk-live-••••••••</code>
    </motion.div>
    <motion.div className="float-card fc-2" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: [0, 6, 0] }}
      transition={{ opacity: { delay: 1.1 }, y: { duration: 6, repeat: Infinity, ease: 'easeInOut' } }}>
      <span className="dot dot-amber" /> Email redacted
      <code>[EMAIL_REDACTED]</code>
    </motion.div>
    <motion.div className="float-card fc-3" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: [0, -5, 0] }}
      transition={{ opacity: { delay: 1.4 }, y: { duration: 5.5, repeat: Infinity, ease: 'easeInOut' } }}>
      <span className="dot dot-green" /> Safe prompt sent
    </motion.div>
  </div>
);

/** A small browser mock showing a prompt being stopped (illustration only). */
export const BrowserMock: React.FC = () => (
  <div className="browser-mock" aria-hidden="true">
    <div className="bm-bar"><span /><span /><span /><div className="bm-url">chat.openai.com</div></div>
    <div className="bm-body">
      <div className="bm-msg">Summarise this config for me: <code>AWS_SECRET=AKIA••••••••••••</code></div>
      <motion.div className="bm-alert" initial={{ opacity: 0, scale: 0.96 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }}
        transition={{ delay: 0.3, duration: 0.4 }}>
        <div className="bm-alert-title">AgentShield stopped this prompt</div>
        <div className="bm-alert-text">It contains a cloud access key. Remove it and try again.</div>
        <div className="bm-alert-actions"><span className="bm-btn">Edit prompt</span><span className="bm-btn ghost">Why?</span></div>
      </motion.div>
    </div>
  </div>
);
