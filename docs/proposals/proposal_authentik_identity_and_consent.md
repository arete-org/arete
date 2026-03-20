# Feature Proposal: Self-Hosted Identity, Consent, and User Data Management via authentik

**Last Updated:** 2026-03-20

---

## Overview

This proposal recommends **authentik** as the future identity layer for Footnote when we decide to support optional accounts and account-linked data.

That likely includes things like:

- opting in to stored data,
- managing profile details,
- saving preferences or history,
- and asking for deletion later.

The important point is that identity should stay a supporting layer, not become the center of the product. Footnote is about steerability, provenance, reviewability, and user choice. If we add accounts, they should support those things, not pull the project toward a generic hosted SaaS pattern.

This document assumes authentik is the direction we want to take and explains why it is the best fit right now. It also captures the main comparison against **Logto OSS**, which was the strongest alternative.

---

## Why This Is Needed

Footnote does not have a real account system for people who want data to persist across sessions. That becomes important once we want to support features like saved preferences, account-linked traces, optional personalization, or user-managed deletion. At that point, "who is this user?" becomes part of the product boundary.

We should not rush into a full product-style auth stack. A bad choice here could quietly push the project away from self-hosting, openness, and privacy.

---

## Footnote Context

Footnote is trying to be open in development, self-hostable in a real way, inspectable, affordable enough that people have practical choices, privacy-conscious without losing reviewability, and ethically opinionated in how it treats power, consent, and data use.

The architecture matters too. Footnote has already decided that `backend` is the public control-plane boundary, and that auth, provenance, trace, incident, and review semantics should stay Footnote-owned rather than being absorbed into runtime or framework code.

Put more simply: Footnote should not pick an identity system that quietly recenters the project around a hosted auth product, a vendor-owned admin surface, or a "just trust the identity layer" mindset. Identity needs to fit inside Footnote's shape, not redefine it.

---

## Why authentik Fits

authentik fits best with Footnote's values.

### 1. It treats self-hosting as a first-class reality

Footnote talks about self-hosting as part of the project's actual value, not just as a box to check. authentik fits that much better than most product-focused auth systems because self-hosting is a normal deployment model for it, not a limited side path.

That matters because Footnote is not only trying to ship one hosted app. It is also trying to remain something other people can run, study, adapt, and contribute to without rebuilding half the stack around a hosted dependency.

### 2. It better supports community-shaped governance

Footnote's docs are clear about open development and community involvement. That makes shared administration and community-run instances more than edge cases.

This is one of the biggest reasons authentik wins. Logto OSS is appealing in several ways, but its self-hosted version only supports a single initial admin account and does not support multi-admin team management. For Footnote, that is a direct mismatch with the idea that the project should be something a community can operate and shape together.

### 3. It aligns with Footnote's preference for open standards and replaceable boundaries

authentik speaks standard OIDC and OAuth2. That is a good architectural fit for Footnote because it lets the backend verify ordinary tokens and keep Footnote-owned logic local.

That means authentik can handle identity and session concerns without becoming the owner of consent, retention, deletion, provenance, review, or policy. That split is important. Footnote should be able to replace or reconfigure parts of its runtime and identity infrastructure later without changing its public product meaning.

### 4. It avoids pushing Footnote toward a hosted-SaaS identity shape

Logto OSS is modern, polished, and easier to imagine in a product-style web app. That is a real advantage in many projects. For Footnote, though, that same product shape creates tension. It is closer to "cloud CIAM platform with an OSS mode" than to "identity layer for a community-shaped self-hosted project."

authentik is the better fit if we want the auth layer itself to carry the same broad values as the rest of the system.

---

## Why Not Logto OSS

Logto OSS was the strongest alternative we looked at, and it has real strengths.

It looks better than authentik in a few areas that are easy to appreciate. The account-management story feels more product-ready, the developer experience is cleaner, the docs for app-facing account flows are strong, and it feels closer to a modern CIAM platform you could drop into a polished web product.

If Footnote were mainly a hosted app with one main operator, Logto could easily win.

But the main question here is not "which one looks most polished in a greenfield web app?" The question is "which one fits the kind of project Footnote is trying to be?"

That is where Logto becomes less ideal. The single-admin limitation in self-hosted OSS is hard to ignore, the overall shape is more cloud-led, and the fit with shared stewardship is weaker.

So this is not really a case of rejecting Logto because it is weak. It is a case of Logto being best at something slightly different from what Footnote needs most.

---

## Interaction With VoltAgent

This choice fits cleanly with the VoltAgent direction already in the repo.

The main reason is architectural, not feature-based. Footnote has already decided that VoltAgent lives behind `@footnote/agent-runtime`, while `backend` stays the public boundary. That means the backend, not the runtime, remains responsible for auth, abuse controls, provenance, and review behavior.

So authentik does not need to "integrate with VoltAgent" in any special or risky way. It can remain the identity provider and token issuer, while Footnote backend remains the place that decides what the user has consented to, what data may be stored, what can be deleted, and what identity information, if any, should reach runtime context.

That is the split we want anyway. It keeps both layers simpler and reduces lock-in on either side.

---

## Ethical Fit

Footnote's philosophy and licensing documents put more weight on ethics than most software projects do. That changes how an account system should be evaluated.

An identity layer is not neutral if it quietly nudges the project toward unnecessary centralization, collecting more personal data than needed, hosted-only control, weak deletion stories, or a setup where only one operator really has power.

authentik is not automatically the ethical choice just because it is open-source. But it gives Footnote a better base to work from. It makes it easier to self-host the whole identity layer, easier to inspect and document what is going on, and easier to support community-run deployments without placing the social center of the project somewhere outside the project.

That is much closer to Footnote's values around autonomy, transparency, and responsible use.

---

## What This Proposal Does And Does Not Say

### This proposal does say

This proposal says authentik is the best current fit for Footnote's long-term direction. It fits the backend-owned architecture already established in the repo, Logto OSS was seriously considered and remains the main alternative, and the deciding factor here is project shape and values more than raw feature count.

### This proposal does not say

It does not say authentik should own Footnote's consent logic, hold all user-facing data, replace anonymous or low-friction use, or become part of the public auth surface through VoltAgent. It also does not say the implementation details are already settled.

Those are later design questions.

---

## Proposed Direction

When Footnote adds account-linked storage and user-managed data, the project should use **authentik** as the preferred identity provider and keep `packages/backend` as the real policy boundary.

That means standard token verification at the edge, with Footnote-owned control over consent, deletion, provenance, and review semantics in backend code.

The point is to make identity useful without letting it take over the meaning of the project.

---

## References And Notes

- Footnote README: https://github.com/footnote-ai/footnote
- Footnote Philosophy: ../Philosophy.md
- Footnote License Strategy: ../LICENSE_STRATEGY.md
- VoltAgent Runtime Adoption: ../decisions/2026-03-voltagent-runtime-adoption.md
- Legacy OpenAI Removal And Runtime Branching: ../decisions/2026-03-legacy-openai-removal-and-runtime-branching.md
- Logto OSS getting started: https://docs.logto.io/logto-oss/get-started-with-oss
- Logto token validation: https://docs.logto.io/authorization/validate-access-tokens
- Logto account settings by Account API: https://docs.logto.io/end-user-flows/account-settings/by-account-api
- Logto webhook events: https://docs.logto.io/developers/webhooks/webhooks-events
- Logto organization permissions: https://docs.logto.io/authorization/organization-permissions
- authentik Docker Compose installation: https://docs.goauthentik.io/docs/install-config/install/docker-compose
- authentik OAuth2/OIDC provider docs: https://docs.goauthentik.io/docs/add-secure-apps/providers/oauth2/
- authentik user settings: https://docs.goauthentik.io/add-secure-apps/flows-stages/flow/executors/user-settings
- authentik providers overview: https://docs.goauthentik.io/docs/providers/
- authentik 2025.10 release notes: https://docs.goauthentik.io/docs/releases/2025.10

---

_Prepared for later implementation planning and community discussion within Footnote._
