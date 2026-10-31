import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// On Vercel, refuse to build without the addresses this app needs (otherwise it would quietly call
// the wrong server). Local builds are unaffected. See DEPLOY_STEPS.md.
const env = (globalThis as any).process?.env ?? {};
if (env.VERCEL) {
  const missing = ['VITE_API_BASE_URL'].filter((name: string) => !env[name]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in the Vercel project settings (see DEPLOY_STEPS.md).`);
}

// The internal console is a separate app on its own address; it never ships inside the customer dashboard.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: 'localhost',
  },
});
