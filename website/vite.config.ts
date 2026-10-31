import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// On Vercel, refuse to build without the addresses this app needs (otherwise it would quietly call
// the wrong server). Local builds are unaffected. See DEPLOY_STEPS.md.
const env = (globalThis as any).process?.env ?? {};
if (env.VERCEL) {
  const missing = ['VITE_PORTAL_URL'].filter((name: string) => !env[name]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in the Vercel project settings (see DEPLOY_STEPS.md).`);
}

// Public marketing website. Its Sign up / Log in buttons go to the customer portal (VITE_PORTAL_URL).
export default defineConfig({
  plugins: [react()],
  server: { port: 5172, host: 'localhost' },
});
