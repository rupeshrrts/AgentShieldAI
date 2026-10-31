import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// On Vercel, refuse to build without the addresses this app needs (otherwise it would quietly call
// the wrong server). Local builds are unaffected. See DEPLOY_STEPS.md.
const env = (globalThis as any).process?.env ?? {};
if (env.VERCEL) {
  // VITE_ADMIN_CONSOLE_URL: without it the sign-in card's "Site owner? Admin login" link would quietly disappear
  const missing = ['VITE_API_BASE_URL', 'VITE_ADMIN_CONSOLE_URL'].filter((name: string) => !env[name]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in the Vercel project settings (see DEPLOY_STEPS.md).`);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
});
