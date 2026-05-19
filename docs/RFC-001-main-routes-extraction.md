# RFC-001: main.ts Route Extraction

**Status**: In execution (autonomous closed-loop pipeline)
**Owner**: Closed-loop dev system (ralphinho-rfc-pipeline + santa-loop + quality-gate)
**Started**: 2026-05-18

## Problem

`sub-brain/src/main.ts` has accreted **149 routes across 26 prefix groups** (1096 lines).
This violates §3 pillar 4 (整洁规范结构) and makes targeted testing hard.

Already extracted in prior sessions: `auth`, `metrics`, `proxy`, `skillhub-routes`, `static`.

## Target Pattern (from `server/skillhub-routes.ts`)

```ts
// sub-brain/src/server/<group>-routes.ts
import type { FastifyInstance } from "fastify";
import type { <Dep1>, <Dep2>, ... } from "../<...>.js";

export interface <Group>RouteDeps {
  <field1>: <Type1>;
  <field2>: <Type2>;
}

export function register<Group>Routes(app: FastifyInstance, deps: <Group>RouteDeps): void {
  app.<verb>(<path>, async (request) => { ... });
  ...
}
```

`main.ts` becomes:
```ts
import { register<Group>Routes } from "./server/<group>-routes.js";
...
register<Group>Routes(app, { <field1>: state.<field1>, ... });
```

## Unit DAG

All 18 units are semantically independent. Serialized **only** because they all mutate `main.ts`.

```
U1 (misc) ─→ U2 (a2a) ─→ U3 (cli) ─→ U4 (dokobot) ─→ U5 (mcp) ─→
U6 (ecosystem) ─→ U7 (identity) ─→ U8 (proposals) ─→ U9 (tools) ─→
U10 (browser) ─→ U11 (skills) ─→ U12 (templates) ─→ U13 (workflows) ─→
U14 (plugins) ─→ U15 (sandbox) ─→ U16 (channels) ─→ U17 (config) ─→
U18 (agents)
```

| Unit | Scope (routes) | Tier | Status |
|---|---|:---:|:---:|
| U1 | health-routes (2) — *re-scoped*: ws/upload/chat split into dedicated future units due to SSE/WS/IO complexity | 1 | ✅ done |
| U2 | a2a-routes (3) | 1 | ✅ done |
| U3 | cli-routes (3) | 1 | ✅ done |
| U4 | dokobot-routes (4) | 1 | ✅ done |
| U5 | mcp-routes (4) | 1 | ✅ done |
| U6 | ecosystem-routes (5) | 1 | ⏳ pending |
| U7 | identity-routes (5) | 1 | ⏳ pending |
| U8 | proposals-routes (5) | 1 | ⏳ pending |
| U9 | tools-routes (6) | 1 | ⏳ pending |
| U10 | browser-routes (7) | 1 | ⏳ pending |
| U11 | skills-routes (7) | 1 | ⏳ pending |
| U12 | templates-routes (7) | 1 | ⏳ pending |
| U13 | workflows-routes (workflows 8 + workflow-runs 2 = 10) | 1 | ⏳ pending |
| U14 | plugins-routes (9) | 1 | ⏳ pending |
| U15 | sandbox-routes (10) | 2 | ⏳ pending |
| U16 | channels-routes (11) | 2 | ⏳ pending |
| U17 | config-routes (13) | 2 | ⏳ pending |
| U18 | agents-routes (31) | 2 | ⏳ pending |

## Quality Gates (uniform per unit)

1. `pnpm exec tsc --noEmit` → 0 errors
2. `pnpm exec vitest run` → all green (no regressions in any existing test)
3. New `tests/<group>-routes.test.ts` exists, exercises every route via `app.inject()` with mocked deps
4. main.ts route block deleted; one `register<Group>Routes(...)` call replaces it
5. URL + verb preserved (verified by grep before/after)

## Risk & Rollback

- **Risk**: A mis-extracted route silently disappears → frontend 404.
  **Mitigation**: Unit test asserts each route returns expected status.
- **Rollback**: Per unit, `git checkout -- sub-brain/src/main.ts sub-brain/src/server/<group>-routes.ts && rm sub-brain/tests/<group>-routes.test.ts`.

## Execution Log

(Auto-appended by the closed-loop driver after each unit.)

### Session 2026-05-18

| Unit | Module | Routes | New tests | main.ts lines | Total vitest |
|---|---|:---:|:---:|:---:|:---:|
| Baseline | — | — | — | 1096 | 144 |
| **U1** ✅ | `health-routes.ts` | 2 | 7 | 1071 | 151 |
| **U2** ✅ | `a2a-routes.ts` | 3 | 6 | 1062 | 157 |
| **U3** ✅ | `cli-routes.ts` | 3 | 6 | 1050 | 163 |
| **U4** ✅ | `dokobot-routes.ts` | 4 | 6 | 1037 | 169 |
| **U5** ✅ | `mcp-routes.ts` | 4 | 7 | 1023 | 176 |
| **Sub-total** | 5 units | **16 routes** | **32 tests** | **-73 lines** | **+32** |

All units passed quality gates:
- `tsc --noEmit` → 0 errors after every unit
- Per-unit `vitest run tests/<name>.test.ts` → all green
- Full `vitest run` regression → no test broken in prior modules
- URL+verb preserved for every route (verified by grep before/after)

**Santa-loop**: each unit converged in 1 iteration (no critic-flagged refinement needed) — pattern is tight enough that mechanical extraction + injection-based tests don't introduce divergence.
