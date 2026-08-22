# Prompt 05 — Unified Mox web product and GrokBot-style agent experience

**Recommended Codex reasoning: Extra High**

Continue from Prompt 04.

## Goal

Create the primary hosted Mox web experience by combining OpenBot's application/control surfaces with OpenMaus's strongest agent-chat/computer/provider UX.

This is not a cosmetic rebrand. Preserve the GrokBot/OpenMaus/OpenBot coworker experience as a core product feature.

## Source to inspect

OpenBot:
- `app/src/*`
- authenticated routes
- admin/settings
- agent/coworker UI
- component rendering
- computer/browser surfaces

OpenMaus:
- `src/App.tsx`
- `src/components/ChatView.tsx`
- Composer/attachments
- ApprovalCard
- ComputerPanel
- model/provider pickers
- API keys UX
- CommandPalette
- CallView/voice
- avatars/status/presence
- related state/types

## Required web IA

At minimum user navigation should support:

- Home/Overview
- Agents
- Agent Rooms
- Servers
- Deployments
- Models
- Integrations/Apps
- Channels
- Usage
- Billing
- Settings

Selecting an agent should expose:

- Chat
- Work/Activity
- Computer
- Files
- Terminal (entitlement-gated)
- Logs
- Settings

## Agent roster

Each agent/coworker displays:
- avatar;
- name;
- role/title;
- online/running/unavailable status;
- current server/deployment status when useful;
- unread/attention state;
- model badge where useful.

Do not create separate "bot", "coworker" and "agent" domain models. Normalize terminology in code around Mox `Agent`.

## Chat

Port/adapt:
- high-quality markdown;
- streaming;
- attachments;
- tool/activity cards;
- approval cards;
- error/retry states;
- branch/thread capabilities where still useful;
- voice/call controls;
- model switch where allowed;
- stop/cancel.

## Work view

Provide a Codex/Claude-Code-style activity surface using canonical runtime events:
- plan/task progress;
- reasoning/activity summaries available from runtime;
- tool calls;
- terminal commands;
- file changes;
- diffs;
- approvals;
- artifacts;
- deployment events.

Do not expose private hidden chain-of-thought; only explicit model/runtime activity summaries and tool events.

## Computer view

Use Mox Computer Gateway:
- live browser;
- screenshots/screencast;
- takeover;
- connection state;
- session restart;
- clear policy/approval prompts.

## Rooms

Create first-class Agent Rooms UI:
- humans + multiple agents;
- shared thread;
- shared objective;
- shared files/activity;
- agent member configuration;
- permissions.

Underlying orchestration may still mature in later runtime work, but the domain/UI must be real, not a fake static page.

## Responsive/web-hosted

Primary product must work in browser.
Do not require Electron.

## Acceptance criteria

- One Mox web app exposes the full agent roster/chat/work/computer paradigm.
- OpenMaus visual/interaction strengths are preserved through port/adaptation.
- OpenBot admin/control surfaces remain functional or are migrated.
- UI consumes Mox contracts/APIs, not direct legacy internals.
- Entitlement gates are hooks, not hard-coded plan names.
