# Feature Proposal: Mobile App Package via Capacitor

**Last Updated:** 2026-04-23

---

## Overview

Footnote should have a mobile app.

The product is still small, and the web app already covers most of what we need. It has the main pages, the interactive chat embed, light and dark mode, and the trust-related UI around trace and provenance.

That makes this a good time to start with a small mobile package.

The proposal is simple:

- add `packages/mobile`
- use it as a thin wrapper around the existing web app
- package the built web app inside Capacitor
- keep Ionic available for cases where mobile-specific UI helps

This proposal is about packaging the current app for mobile and learning from real device use.

---

## Why Do This

The web app already works well enough to serve as the foundation for mobile.

At this stage, we do not need a separate mobile product strategy or a second frontend. We need a practical way to get Footnote onto phones, reuse the app we already have, and learn where mobile needs different treatment.

That gives us a few useful benefits:

- Footnote becomes installable on phones.
- We can test chat, trace, and provenance on real devices.
- The product keeps one main app shape while it is still evolving.
- Native features remain available later if they become worth adding.

The main thing to avoid is splitting the frontend too early. That would add maintenance cost, increase drift, and make the product harder to keep consistent.

---

## Footnote Context

Footnote already has a clear main app surface in `packages/web`.

That matters because the current product does not need two separate app surfaces with different routing, different business logic, or different design rules. The mobile package should reuse as much of the web app as possible and only diverge where phone ergonomics require it.

That fits the current state of the project:

- the web surface is still relatively small
- mobile is useful, but not the top product priority
- there is no strong product reason for mobile to behave very differently from web

The repo should reflect that. `packages/mobile` should package and host the app on mobile. `packages/web` should stay the main owner of product behavior.

---

## Thin Wrapper First

The safest first step is a thin mobile shell around the web app.

For v1, that means aiming for:

- route compatibility with web
- reuse of existing app content
- minimal platform-specific UI changes
- a small amount of mobile-only code

This matches the current size and maturity of the product.

It also gives us a clean way to learn. If the app works well on phones with only a few targeted adjustments, then the wrapper approach is doing its job. If it exposes layout, navigation, or runtime assumptions that break on mobile, then we get concrete evidence about what needs to change.

That is a much better foundation than guessing our way into a larger mobile architecture before the product calls for it.

---

## Why Capacitor

Capacitor is the leading option because it matches the problem in front of us.

Right now, we need a way to package the existing web app as a mobile app, run it on devices, and leave room for native features later if they become useful.

Capacitor supports that well because it lets us:

- ship the built web app inside a mobile shell
- keep the main app logic in the existing frontend
- add native packaging and device configuration without rewriting the app
- grow into native integrations later if the product needs them

The point is not that Capacitor solves every mobile problem. The point is that it fits the narrow job we have right now.

For this proposal, Capacitor is the best current fit for a packaging-first mobile package.

---

## Why Ionic

Ionic may still be useful in a supporting role.

It can help when mobile-specific UI patterns or primitives genuinely improve the experience. That should stay selective and scoped to clear use cases.

The first version should stay visually and structurally close to the web app unless phone-specific constraints push us somewhere else.

In practice, that means:

- Capacitor handles packaging
- the existing app remains the main UI foundation
- Ionic is available for targeted mobile ergonomics where it adds real value

That keeps the mobile package focused and reduces the risk of growing a second visual system.

---

## Package Boundaries

The mobile package should have a small and clear job.

`packages/web` should remain the main owner of app content, including:

- routes
- shared UI
- product behavior
- trace and provenance surfaces
- the general shape of the app

`packages/mobile` should own mobile-specific concerns, such as:

- Capacitor configuration
- native project files
- app metadata
- app icons and splash configuration
- mobile bootstrap
- the shell needed to host the web app on mobile

If mobile-specific presentation changes become necessary, they should come from real device constraints and be introduced carefully.

Clear package boundaries will help keep the repo aligned as mobile support grows.

---

## What V1 Includes

The first version should stay boring.

A successful v1 means:

- `packages/mobile` exists and builds cleanly
- the current web app runs inside a mobile shell
- the main routes work on a phone
- the interactive chat embed works
- trace and provenance surfaces remain accessible
- light and dark mode still behave correctly
- the package participates in normal CI

That last point matters. Once mobile is in the repo, it should follow the same standards as everything else.

The goal for v1 is a working, maintainable mobile package that keeps reuse high and complexity low.

---

## What V1 Leaves For Later

The first version can leave these areas for later work:

- separate mobile information architecture
- deep mobile-only route forks
- push notifications
- offline mode
- app store release work
- deep links
- share intents
- camera flows
- file system features
- broad native integrations

Some of these may become useful over time. They do not need to be part of the first pass.

Web still carries the main product surface today. Mobile should grow at a pace the product can support.

---

## How This Fits Footnote

The cleanest first version is to package the built web app inside Capacitor.

That keeps the setup straightforward:

- the web package still produces the app content
- the mobile package consumes that output
- the mobile package stays thin while we learn what the product needs on phones

Because mobile will live in the repo, it should participate in normal CI from the start. That helps with consistency and keeps the package healthy.

This should also stay proportional to the size of the product. The initial package should only force broader repo changes if the first validation pass shows that `packages/web` is too tightly coupled to browser-only assumptions.

If that happens, the next step should be targeted separation of reusable app content from web-only shell concerns.

---

## Risks And Failure Modes

This is the safest option on paper, but it still has real failure modes.

The web app may be more browser-specific than expected. Layout, navigation, or runtime assumptions may break inside a mobile shell.

Mobile-specific fixes may also start leaking into `packages/web` without enough discipline. That is how a thin wrapper turns into a messy hybrid.

Ionic can create another source of sprawl if it starts showing up everywhere without a strong reason.

There is also a product risk here. “Mobile app” can become a reason to overbuild before the product has earned that complexity.

The best response is to keep the first pass narrow and make every meaningful divergence justify itself.

---

## When To Stop

This approach stops making sense if:

- the mobile package starts becoming a second frontend
- route and UI divergence grows without a clear device-driven reason
- the package adds a lot of maintenance cost without enough product value
- the web package fills up with ad hoc mobile conditionals
- the Capacitor setup creates more friction than the shared app saves

If that happens, the project should reassess the implementation approach.

---

## Proposed Direction

Footnote should add a `packages/mobile` package and start with a packaging-first mobile approach.

The current leading path is:

1. create `packages/mobile`
2. package built web assets inside Capacitor
3. keep route and app reuse high
4. use Ionic where it clearly improves mobile ergonomics
5. include the package in normal CI
6. keep the first version thin and focused

The implementation choice should stay provisional until early validation confirms that this path holds up well on real devices.
