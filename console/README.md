# LuulScan — Enterprise Review Console

Web app where geologists review AI geological assessments (Sprint 4.4). React + Vite,
same Supabase backend as the mobile app; access is RBAC-gated (reviewer roles only).

## Run locally
```bash
cd console
npm install
cp .env.example .env   # already points at the prod project (public anon key)
npm run dev            # http://localhost:5173
```
Sign in with a reviewer account (geologist / senior_geologist / chief_geologist / admin,
or the owner-beta account). Non-reviewer accounts are refused.

## Deploy (Vercel)
1. Push the repo to GitHub (the `console/` folder is the project root on Vercel).
2. Import the project in Vercel → set **Root Directory** = `console`.
3. Add env vars (from `.env.example`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_SUPABASE_FUNCTIONS_URL`.
4. Framework preset **Vite** (build `npm run build`, output `dist`). Deploy.

Or from the CLI:
```bash
npm i -g vercel
vercel --cwd console
```

## Status
- **S3 (this)** — scaffold + auth + **Review Queue** (samples in the review pipeline).
- **S4** — full Sample Review screen (photos │ AI evidence graph │ map │ per-conclusion
  confirm/correct │ Verify / Needs More Data / Reject / Save Draft) on the deployed
  `review-sample` endpoint.
- **S5** discussion · **S6** Company Portal · **S7** PDF reports.
