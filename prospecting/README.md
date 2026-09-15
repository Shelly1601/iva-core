# Leads & Recruiting

Project-scoped public business research. This extends the existing recruiting workspace with campaign-based sourcing; it does not replace CV review and does not make hiring decisions.

## Integration

`createProspectingService({dataDir,getProject,listProjects,env?,collect?,search?,read?,extract?})` uses `operations/project-store.js`. `getProject` must enforce the active owner's project/module entitlement. Mount `registerProspectingRoutes(app,{service})` behind the owner guard. `prospectingSkill({service,projectId})` pins chat tools to the current project. No public portal route is provided.

- `/api/prospecting/context?projectId=...`: readiness and accessible projects.
- `/campaigns` GET/POST; `/:id` GET/PATCH (`baseRevision` required).
- `/:id/research` POST `{idempotencyKey}`: up to two search calls, eight HTML pages, one model call; no automatic retry or provider fallback.
- `/:id/leads/:leadId` PATCH: `baseRevision`, `draft`, `notes`, `reviewStatus`. Marking reviewed requires `reviewConfirmed:true`; sent is never accepted.
- `/:id/export.csv` GET: UTF-8 BOM, semicolon CSV with formula neutralization, facts, sources, retrieval date and draft status.

All endpoints require explicit `projectId`; conflicting query/body scopes are rejected. Campaign create also requires an idempotency key. Repeating an existing research key returns its stored result; it never repeats paid processing. A new deliberate research action needs a fresh key. Duplicate contacts merge inside the campaign, retaining custom drafts and noting conflicting facts; matches in another project campaign are flagged without merging projects.

## Evidence and limits

Tavily is used for discovery, followed by the existing DNS-pinned `readWebsiteReference` reader (HTTPS, public network addresses, body byte/time limits, caller cancellation). Unreadable pages, HTTP-only pages, PDFs or blocked LinkedIn pages remain search hints; no facts are extracted from them. Each accepted value and its quotation must occur in an actually read page. The contact quotation must include the company to avoid joining unrelated directory entries. This verifies a textual source, not the real-world truth or current employment: human review remains visible and explicit. Web pages can be outdated. Completeness counts populated core fields and is never a suitability score or proof of buying interest.

Source collection and the model share a 180-second deadline; old runs cannot commit across changed target revisions. A failed model leaves retrieved sources available. Network loss stops subsequent model calls. Unknown results are stored as partial/uncertain without automatic restart. The API persists the request before external work. Job history includes the original target/query snapshot.

Campaign limit: 60 per project, 100 runs and 300 deduplicated leads per campaign, shared 8 MB project-store limit. Each source stores at most 5,000 characters. Only public business context is requested. No private data enrichment, guessed email patterns, inferred protected attributes or automatic employment decisions are supported.

## Real connections

- Search: existing `TAVILY_API_KEY`.
- Extraction: normal IVA model routing, optionally `IVA_MODEL_PROSPECTING`; one `maxRetries:0` call with budget check/reservation/accounting. A malformed output does not trigger JSON repair.
- LinkedIn: free browser search links and editable drafts. No verified Messages API connection, send endpoint or false “sent” state. The official [Messages API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages) requires approved partner access and affirmative member action; a generic account/token would not establish eligibility.
- North Data: optional [official Data API](https://northdata.github.io/doc/api/). `NORTHDATA_API_KEY` / `NORTH_DATA_API_KEY` are inspected only as booleans for setup status. No adapter is claimed to be active; a separately contracted API and verified adapter are still needed.

Runtime configuration check on 2026-09-16 found Tavily and Gemini configured; no North Data or LinkedIn token. Keys were not printed or saved. No real target group was supplied, so no customer/company outreach or production campaign was created.

## Validation

`node scripts/verify-prospecting.mjs` covers project scope, idempotency, exact source grounding, company/person linkage, incomplete providers, cancellation, expired-job/target edit races, review versions, CSV injection, one-shot budgeted extraction, readiness honesty and pinned chat tools. Browser verification uses a local temporary store, synthetic companies/sources/providers and no external messages.
