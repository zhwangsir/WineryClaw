# ADR-0001 — Sandbox runtime: WeBrain's DockerSandbox vs. external runtimes

* Status: **Accepted** (2026-05-21)
* Round: J4
* Deciders: project owner (王震宇 / Master)
* Supersedes: n/a
* Superseded by: n/a

## Context

WeBrain agents need a place to execute code that the model writes — shell
commands, Python scripts, JS snippets, package installs, and increasingly
"computer-use" style workflows (long-running dev environments, browser
automation, multi-step builds).

Round J1–J3 (2026-05-21) implemented a **stateful workspace sandbox** on
top of Docker:

- `DockerSandbox.ensureWorkspace / execInWorkspace / removeWorkspace`
  manage long-lived containers with bind-mounted persistent volumes.
- `webrain-workspace:latest` (J2) — ubuntu:24.04 with git/python/node/
  ffmpeg/curl preinstalled; non-root agent user + passwordless sudo.
- `runSandboxSkill` (J3) — skill runtime variant that runs Python/JS
  skills inside a workspace container, same `SkillRunResult` contract
  as the in-process runtimes.

The natural next question: **do we keep building on this in-house, or
hand the runtime off to a specialized provider?**

This ADR records the decision and the criteria for revisiting it.

## Options considered

### Option A — Keep building on DockerSandbox (in-house) ✅ chosen

What we have today plus incremental improvements:

- Add a PTY / stream-stdout endpoint for long-running interactive tasks.
- Add image build-on-demand (`sandbox-skill.yaml` can declare extra apt
  packages and we cache a derived image).
- Add multi-tenancy: per-user / per-agent quota and namespace isolation.
- Add idle GC (J5+): stop containers idle for >N minutes, restart on
  next exec.

**Pros**
- **Zero new external dependencies, zero new credentials.** No account
  signup, no API key, no vendor billing.
- **Trust boundary stays local.** User data, code, secrets never leave
  the user's machine. Important for an "AI伴侣" product where the user's
  Documents folder is fair game for context.
- **Latency floor is the Docker daemon — already fast.** No round-trip
  to an external runtime API.
- **Already shipped + tested.** J1–J3 added ~50 unit tests; the
  framework is in production.
- **Works fully offline.** Important when the LAN is the deployment
  boundary (the current `WEBRAIN_BASE_URL` is a LAN IP).

**Cons**
- We own the operational burden: container GC, image build pipeline,
  resource quotas, security hardening, eventually multi-tenant
  scheduling.
- macOS users pay the Docker Desktop virtualization tax.
- Computer-use (screenshot + keyboard) isn't free — we'd need to add
  a Wayland/X11 stack or proxy through the host. Non-trivial.

### Option B — Replace DockerSandbox with E2B (e2b.dev)

E2B is a managed sandbox SaaS targeted explicitly at AI agents — fork
of a Firecracker-based microVM runtime with a Node/Python SDK.

**Pros**
- Sub-second cold start (Firecracker microVMs).
- Persistent state via "templates" + branching snapshots.
- Built-in code interpreter mode + browser automation primitives.
- Hosted — no Docker on the user's machine required.

**Cons**
- **Network round-trip per exec.** Even the colocated edge case adds
  ~50ms; cross-region adds 200ms+. For the agent's inner loop
  (write→exec→reflect), that compounds.
- **Sends user code to a third party.** Every snippet the model
  generates against the user's data flows over the public internet.
  For a personal-data AI product this is a hard sell.
- **Per-VM cost.** E2B's pricing model is per-vCPU-hour. A power user
  running 24/7 background agents quickly outpaces self-hosted Docker.
- **Vendor lock-in on the agent loop.** The SDK shape is opinionated;
  swapping it back out later is non-trivial.
- **Requires online.** LAN-only or air-gapped deployments are out.

### Option C — Adopt OpenHands (formerly OpenDevin) runtime

OpenHands ships a self-hostable agent runtime with a similar Docker
container-per-session model, plus PTY support, file ops, and a
browser. MIT licensed.

**Pros**
- Open source + self-hostable → no vendor lock-in.
- PTY + browser + file ops are already implemented.
- Active community, large existing user base.

**Cons**
- **Replaces what we just built**, not extends. J1–J3 would become
  scaffolding around an OpenHands client.
- **Heavy dependency footprint** (Poetry, multiple python deps,
  separate Docker image). Inflates the WeBrain install story
  ("install Docker AND clone OpenHands AND run their Docker AND
  configure their .env").
- **Opinionated agent loop.** OpenHands has its own agent
  abstractions; we'd have to either adopt them or shoehorn ours
  through their API.
- Their runtime is optimized for the OpenHands agent — using only
  the runtime would mean pinning a moving target.

### Option D — Modal Labs / Replicate / Code Interpreter clones

Serverless container runtimes with per-invocation billing.

**Pros**: Sub-second cold start, no infra.
**Cons**: Same as E2B but worse for stateful workflows — serverless
philosophy means workspace state has to be reconstructed each call.
Bad fit for agent dev loops.

## Decision

**Stay with Option A (DockerSandbox + workspace mode) for the
foreseeable future.** Continue building J5+ in-house.

The deciding factor is the **trust boundary**. WeBrain is a personal
AI ("AI伴侣") that operates on the user's documents, memory, and
chat history. Sending the user's code + generated scripts to a third
party for execution conflicts with the product's privacy stance,
which is currently the differentiator vs. cloud AI products.

Performance and feature-coverage tradeoffs are real but smaller than
the trust tradeoff. We give up sub-second microVM cold starts; we
gain a runtime the user can audit + run offline.

## Triggers for revisiting

This decision is **not** "never use E2B / OpenHands". It is "the bar
for switching is high". Revisit if any of the following becomes true:

1. **WeBrain pivots toward multi-tenant cloud deployment.** At that
   point, per-user Docker-on-the-host doesn't scale and a managed
   runtime becomes the obvious answer. E2B is the leading candidate.
2. **Computer-use becomes a flagship feature** and we need the
   pre-built screenshot + keyboard + browser stack OpenHands
   already ships. Adopting their *runtime* (not their *agent*) is
   the option to evaluate.
3. **Cold-start latency** for first-call execs becomes user-visible
   pain (currently ~1.5s on a warm Docker daemon, mostly the
   `docker run -d` for new workspaces — bearable). Firecracker
   would cut this to ~150ms.
4. **A security incident in our DockerSandbox layer.** A serious CVE
   or escape would force us to either harden significantly or
   outsource to a vendor that has the bandwidth.

## Reference roadmap (informational)

J5 candidates we'd build BEFORE revisiting this decision:

- **J5: PTY / streaming stdout** — `execInWorkspace` returns an
  EventEmitter for long-running commands. Unblocks watching a
  `pnpm dev` or `pytest -v` inside the workspace.
- **J6: Per-agent quotas** — max workspaces per agent, max
  cumulative memory, max disk.
- **J7: Image registry + build-on-declare** — a skill manifest can
  say `extraPackages: [imagemagick, pandoc]`; we build a derived
  image once and cache it.
- **J8: Idle GC** — workspaces idle >30 min get `docker stop`'d,
  next exec wakes them.
- **J9: Browser-in-container** — headless chromium in the workspace
  image + a `getScreenshot()` API. The "computer-use" stepping stone.
- **J10**: only at this point do we re-ask: does an external runtime
  give us enough leverage to be worth the trust tradeoff?

## References

- E2B: <https://e2b.dev/docs>
- OpenHands runtime: <https://github.com/All-Hands-AI/OpenHands>
- Anthropic computer-use: <https://docs.anthropic.com/en/docs/build-with-claude/computer-use>
- Firecracker: <https://firecracker-microvm.github.io/>
- WeBrain DockerSandbox: `sub-brain/src/sandbox/docker-sandbox.ts`
- WeBrain workspace image: `sub-brain/docker/workspace/Dockerfile`
