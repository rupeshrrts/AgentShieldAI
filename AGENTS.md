# Instructions for AI coding agents

Read [README.md](./README.md) first, especially **"For AI agents and contributors"**. It describes the architecture, auth model, API, file map and where to change things. Security and privacy facts live in SECURITY_ARCHITECTURE.md and DATA_HANDLING.md; keep them true when you change behaviour.

## Must-follow rules
1. **Database safety:** `.env` may point at the live Supabase database. Before running tests or a dev server, set `DATABASE_URL` to a temporary SQLite file, e.g. `$env:DATABASE_URL="sqlite:///./test_agentshield.db"`.
2. **No secrets in output or commits:** `.env`, activation codes (`ASA1....`) and tokens (`asa_...`), invite and email-confirmation links/tokens (`asi_...`, `asv_...`), device session tokens, legacy device keys (`asd_...`) and enrollment codes (`ASE1....`), passwords.
3. **Auth:** extension-facing endpoints use `get_principal` (operator JWT or device session JWT; legacy `X-Device-Key` only with `LEGACY_DEVICE_KEYS_ENABLED`); data endpoints use `get_current_user` (operators only, never EMPLOYEE); own-account endpoints use `get_signed_in_user`; admin changes use `get_current_admin` and must call `record_admin_action`. Never add admin credentials or any shared key to the extension: a browser is only authorized by per-user activation (`api/device_auth.py`). The extension must stay fail closed: nothing read from storage may set the authorized state (`extension/src/background/auth-state.ts`).
4. **Tenant isolation:** take the organization from the credential and filter every query by it. Never trust `organization_id`/`company_name` from a request body.
5. **Privacy:** prompt text written to the DB goes through `prepare_prompt_for_storage()` in `backend/app/core/privacy.py`.
6. **Twins:** keep `extension/src/content/detector.ts` ↔ `backend/app/detection/detector.py` and `extension/src/shared/policy.ts` ↔ `backend/app/policies/evaluator.py` identical. Add cases to `backend/tests/detection_cases.json` (used by both test suites).
7. **No fabricated data** in the dashboard: every number and status must come from the API.
8. **Generated files:** do not edit `extension/dist/**`, `extension/src/popup/popup.js`, `dashboard/dist/**`.

## Verify before finishing
```powershell
cd backend;   $env:DATABASE_URL="sqlite:///./test_agentshield.db"; .venv\Scripts\python.exe -m pytest tests -q
cd extension; npm test; npx tsc --noEmit; node build.js
cd dashboard; npm run build
```
Update README.md (and its Change history) when behaviour, setup, API or configuration changes.
