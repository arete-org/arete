/**
 * @description: Contributor onboarding page for the web package that explains
 * current workflow architecture, key seams, and rendering responsibilities.
 * @footnote-scope: web
 * @footnote-module: OnboardingPage
 * @footnote-risk: medium - Incorrect onboarding details can mislead contributors during architecture changes.
 * @footnote-ethics: medium - Clear, accurate docs support transparency and reduce overclaiming of trust signals.
 */

import Header from '@components/Header';
import Footer from '@components/Footer';

type OnboardingSectionId =
    | 'what-footnote-is'
    | 'what-changed-recently'
    | 'repo-shape'
    | 'request-lifecycle'
    | 'architectural-themes'
    | 'workflow-boundaries'
    | 'symbols'
    | 'web-rendering'
    | 'gotchas'
    | 'where-next';

type SectionLink = {
    id: OnboardingSectionId;
    label: string;
};

type SymbolKind = 'type' | 'function' | 'seam' | 'module' | 'concept';

type SymbolReferenceEntry = {
    name: string;
    kind: SymbolKind;
    filePath: string;
    explanation: string;
};

const breadcrumbItems = [{ label: 'Contributor Onboarding' }];

const sectionLinks: SectionLink[] = [
    { id: 'what-footnote-is', label: 'What Footnote is' },
    { id: 'what-changed-recently', label: 'What changed recently' },
    { id: 'repo-shape', label: 'Repo and package shape' },
    { id: 'request-lifecycle', label: 'Request lifecycle' },
    { id: 'architectural-themes', label: 'Architectural themes' },
    { id: 'workflow-boundaries', label: 'Workflow boundaries' },
    { id: 'symbols', label: "Symbols you'll see in code" },
    { id: 'web-rendering', label: 'What web owns' },
    { id: 'gotchas', label: 'Gotchas' },
    { id: 'where-next', label: 'Where to read next' },
];

const symbolReferences: SymbolReferenceEntry[] = [
    {
        name: 'workflowEngine',
        kind: 'module',
        filePath: 'packages/backend/src/services/workflowEngine.ts',
        explanation:
            'Runs step ordering, timing, limits, termination, and workflow lineage.',
    },
    {
        name: 'chatOrchestrator',
        kind: 'module',
        filePath: 'packages/backend/src/services/chatOrchestrator.ts',
        explanation:
            'Assembles request context, planner seams, and runtime dependencies before chat execution.',
    },
    {
        name: 'chatService',
        kind: 'module',
        filePath: 'packages/backend/src/services/chatService.ts',
        explanation:
            'Runs chat generation flow, workflow execution handoff, metadata assembly, and trace persistence.',
    },
    {
        name: 'PlannerStepExecutor',
        kind: 'type',
        filePath: 'packages/backend/src/services/plannerWorkflowSeams.ts',
        explanation:
            'Injected executor interface that lets workflow run the planner as a timed plan step.',
    },
    {
        name: 'PlannerResultApplier',
        kind: 'seam',
        filePath:
            'packages/backend/src/services/chatOrchestrator/plannerResultApplier.ts',
        explanation:
            'Policy seam that applies backend rules to planner output before execution continues.',
    },
    {
        name: 'AppliedPlanState',
        kind: 'type',
        filePath: 'packages/backend/src/services/plannerWorkflowSeams.ts',
        explanation:
            'Canonical post-policy plan snapshot carried into generation and metadata.',
    },
    {
        name: 'PlanContinuationBuilder',
        kind: 'seam',
        filePath: 'packages/backend/src/services/plannerWorkflowSeams.ts',
        explanation:
            'Builds the post-plan continuation result: continue message flow or end with terminal action.',
    },
    {
        name: 'PlanContinuation',
        kind: 'type',
        filePath: 'packages/backend/src/services/plannerWorkflowSeams.ts',
        explanation:
            'Union representing either continue_message or terminal_action after plan application.',
    },
    {
        name: 'PlanTerminalAction',
        kind: 'type',
        filePath: 'packages/backend/src/services/plannerWorkflowSeams.ts',
        explanation:
            'Typed terminal outcomes: ignore, react, or image request without text generation.',
    },
    {
        name: 'assemblePlanGenerationInput',
        kind: 'function',
        filePath:
            'packages/backend/src/services/chatService/planGenerationInput.ts',
        explanation:
            'Builds generation-ready conversation payload after planner policy and prompt assembly.',
    },
    {
        name: 'classifyPlanContinuation',
        kind: 'function',
        filePath:
            'packages/backend/src/services/chatService/planContinuation.ts',
        explanation:
            'Classifies an applied execution plan into continue_message or terminal_action.',
    },
    {
        name: 'ContextStepExecutor',
        kind: 'type',
        filePath: 'packages/backend/src/services/workflowEngine.ts',
        explanation:
            'Executor contract for pre-generation context integrations inside workflow.',
    },
    {
        name: 'ContextStepRequest',
        kind: 'type',
        filePath: 'packages/backend/src/services/workflowEngine.ts',
        explanation:
            'Structured request describing whether an integration was requested and eligible.',
    },
    {
        name: 'ContextStepResult',
        kind: 'type',
        filePath: 'packages/backend/src/services/workflowEngine.ts',
        explanation:
            'Structured context-step outcome with execution context, optional messages, and clarification.',
    },
    {
        name: 'trace_target',
        kind: 'concept',
        filePath: 'packages/contracts/src/ethics-core/types.ts',
        explanation:
            'TRACE target posture recorded from planner/runtime temperament at response time.',
    },
    {
        name: 'trace_final',
        kind: 'concept',
        filePath: 'packages/contracts/src/ethics-core/types.ts',
        explanation:
            'TRACE final posture delivered in metadata for rendering and trace review.',
    },
];

const OnboardingToc = (): JSX.Element => (
    <nav className="onboarding-toc" aria-label="Onboarding sections">
        <p className="onboarding-toc__title">On this page</p>
        <ul className="onboarding-toc__list">
            {sectionLinks.map((link) => (
                <li key={link.id}>
                    <a href={`#${link.id}`}>{link.label}</a>
                </li>
            ))}
        </ul>
    </nav>
);

const SymbolBadge = ({ kind }: { kind: SymbolKind }): JSX.Element => (
    <span
        className={`onboarding-symbol-badge onboarding-symbol-badge--${kind}`}
    >
        {kind}
    </span>
);

const OnboardingPage = (): JSX.Element => (
    <>
        <Header breadcrumbItems={breadcrumbItems} />
        <main className="onboarding-page" id="main-content">
            <header
                className="onboarding-hero"
                aria-labelledby="onboarding-title"
            >
                <p className="onboarding-eyebrow">Contributor onboarding</p>
                <h1 id="onboarding-title">
                    How Footnote chat flow works today
                </h1>
                <p className="onboarding-summary">
                    This page is for contributors working across backend
                    workflow execution and web trace rendering.
                </p>
                <p>
                    It describes what is implemented now, where ownership lines
                    are drawn, and which terms show up most often in the code.
                </p>
            </header>

            <div className="onboarding-layout">
                <aside className="onboarding-layout__toc">
                    <OnboardingToc />
                </aside>

                <article className="onboarding-content">
                    <section
                        className="onboarding-section"
                        id="what-footnote-is"
                        aria-labelledby="what-footnote-is-title"
                    >
                        <h2 id="what-footnote-is-title">What Footnote is</h2>
                        <p>
                            Footnote is a transparency-first AI system. It
                            returns an answer, citations when available, and
                            structured trace metadata so people can inspect how
                            a response was produced.
                        </p>
                        <p>
                            In this repo, backend code is the authority for
                            workflow execution, policy application, provenance
                            metadata, and cost accounting. Web and Discord
                            surfaces render that output.
                        </p>
                    </section>

                    <section
                        className="onboarding-section"
                        id="what-changed-recently"
                        aria-labelledby="what-changed-recently-title"
                    >
                        <h2 id="what-changed-recently-title">
                            What changed recently
                        </h2>
                        <p>
                            Planning moved into workflow execution as a
                            canonical <code>plan</code> step. The orchestrator
                            now assembles planner seams and injects them into
                            workflow runtime instead of running planning as a
                            separate pre-workflow phase.
                        </p>
                        <p>
                            Fast mode still plans. The speed difference now
                            comes from profile and limit settings such as
                            review-cycle limits, not by skipping planner
                            execution. Weather is now a concrete context-step
                            integration, while <code>web_search</code>{' '}
                            context-step migration is still pending.
                        </p>
                        <p>
                            TRACE posture is emitted through{' '}
                            <code>trace_target</code> and{' '}
                            <code>trace_final</code>. Message plans are expected
                            to provide complete TRACE axes, and the planner
                            contract now enforces that expectation for valid
                            planner output.
                        </p>
                    </section>

                    <section
                        className="onboarding-section"
                        id="repo-shape"
                        aria-labelledby="repo-shape-title"
                    >
                        <h2 id="repo-shape-title">Repo and package shape</h2>
                        <p>
                            Main packages contributors usually touch together:
                        </p>
                        <ul>
                            <li>
                                <code>packages/backend</code>: runtime authority
                                for chat workflow, policy, metadata, and trace
                                storage.
                            </li>
                            <li>
                                <code>packages/web</code>: browser surface that
                                renders chat output, traces, and
                                contributor-facing docs pages.
                            </li>
                            <li>
                                <code>packages/contracts</code>: shared
                                transport and metadata schema contracts used
                                across surfaces.
                            </li>
                            <li>
                                <code>packages/discord-bot</code>: Discord
                                transport and UI surface for the same backend
                                output.
                            </li>
                            <li>
                                <code>packages/agent-runtime</code> and{' '}
                                <code>packages/prompts</code>: generation
                                runtime and prompt-layer dependencies.
                            </li>
                        </ul>
                    </section>

                    <section
                        className="onboarding-section"
                        id="request-lifecycle"
                        aria-labelledby="request-lifecycle-title"
                    >
                        <h2 id="request-lifecycle-title">Request lifecycle</h2>
                        <ol>
                            <li>
                                <code>/api/chat</code> enters backend handlers
                                and builds normalized request context.
                            </li>
                            <li>
                                <code>chatOrchestrator</code> resolves execution
                                mode and profile, then constructs planner and
                                context seams.
                            </li>
                            <li>
                                <code>
                                    chatService.runChatMessagesWithOutcome
                                </code>{' '}
                                resolves workflow runtime config and invokes{' '}
                                <code>workflowEngine</code>.
                            </li>
                            <li>
                                Workflow runs <code>plan</code> first via{' '}
                                <code>PlannerStepExecutor</code>, then applies
                                policy via <code>PlannerResultApplier</code>,
                                then branches through{' '}
                                <code>PlanContinuation</code>.
                            </li>
                            <li>
                                If tool context is requested and eligible, the
                                context step runs before generation. Weather
                                currently uses this path.
                            </li>
                            <li>
                                Workflow continues with generation, optional
                                assess/revise loops, and bounded termination
                                based on limits and policy.
                            </li>
                            <li>
                                Metadata is assembled, including citations,
                                safety, TRACE, workflow lineage, and timing,
                                then stored in trace persistence.
                            </li>
                        </ol>
                    </section>

                    <section
                        className="onboarding-section"
                        id="architectural-themes"
                        aria-labelledby="architectural-themes-title"
                    >
                        <h2 id="architectural-themes-title">
                            Architectural themes
                        </h2>
                        <ul>
                            <li>
                                Backend is the runtime boundary. Web and Discord
                                render backend-owned execution truth.
                            </li>
                            <li>
                                Planner output is advisory. Policy application
                                is explicit and recorded after planning.
                            </li>
                            <li>
                                Workflow lineage is canonical. If a step
                                happened, it should appear in workflow step
                                records.
                            </li>
                            <li>
                                Fail-open defaults are intentional. Runtime
                                should continue safely instead of blocking on
                                uncertain integration paths.
                            </li>
                            <li>
                                Public interfaces stay serializable, so
                                transport surfaces can render without
                                backend-only assumptions.
                            </li>
                        </ul>
                    </section>

                    <section
                        className="onboarding-section"
                        id="workflow-boundaries"
                        aria-labelledby="workflow-boundaries-title"
                    >
                        <h2 id="workflow-boundaries-title">
                            Workflow boundaries and ownership
                        </h2>
                        <p>
                            <code>workflowEngine</code> owns timing, step
                            ordering, limit enforcement, termination
                            classification, and lineage records.
                        </p>
                        <p>
                            It does not own planner policy semantics, provider
                            behavior, transport rendering, or UI labeling
                            decisions. Those stay in orchestrator/policy layers
                            and rendering surfaces.
                        </p>
                        <div className="onboarding-callout onboarding-callout--warn">
                            <p>
                                Keep this boundary intact: engine is execution
                                control flow; policy and presentation stay
                                outside the engine.
                            </p>
                        </div>
                    </section>

                    <section
                        className="onboarding-section"
                        id="symbols"
                        aria-labelledby="symbols-title"
                    >
                        <h2 id="symbols-title">
                            Symbols you&apos;ll see in code
                        </h2>
                        <div className="onboarding-symbol-table-wrap">
                            <table className="onboarding-symbol-table">
                                <thead>
                                    <tr>
                                        <th scope="col">Symbol</th>
                                        <th scope="col">Kind</th>
                                        <th scope="col">File</th>
                                        <th scope="col">What it means</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {symbolReferences.map((entry) => (
                                        <tr key={entry.name}>
                                            <td>
                                                <code>{entry.name}</code>
                                            </td>
                                            <td>
                                                <SymbolBadge
                                                    kind={entry.kind}
                                                />
                                            </td>
                                            <td>
                                                <code>{entry.filePath}</code>
                                            </td>
                                            <td>{entry.explanation}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section
                        className="onboarding-section"
                        id="web-rendering"
                        aria-labelledby="web-rendering-title"
                    >
                        <h2 id="web-rendering-title">What web owns</h2>
                        <ul>
                            <li>
                                Render workflow lineage as recorded by backend;
                                do not infer missing step history.
                            </li>
                            <li>
                                Show workflow <code>plan</code> steps in trace
                                timelines when present.
                            </li>
                            <li>
                                Keep citations and source links clear and
                                visible.
                            </li>
                            <li>
                                Render TRACE axes as posture indicators, not
                                accuracy scores.
                            </li>
                            <li>
                                Do not imply <code>web_search</code> is already
                                migrated into context-step flow.
                            </li>
                            <li>
                                Do not claim a user selected a mode unless
                                request or backend metadata says so.
                            </li>
                            <li>
                                Explain mode labels in plain language:
                                <code>fast</code> is short-path planning without
                                review;
                                <code>balanced</code> includes a lighter review
                                pass;
                                <code>grounded</code> keeps stricter evidence
                                posture and review depth.
                            </li>
                            <li>
                                Keep safety tier and citations visible as trust
                                surfaces in page summaries and detail views.
                            </li>
                        </ul>
                    </section>

                    <section
                        className="onboarding-section"
                        id="gotchas"
                        aria-labelledby="gotchas-title"
                    >
                        <h2 id="gotchas-title">Gotchas</h2>
                        <ul>
                            <li>
                                Planner output is advisory. Backend policy can
                                adjust or reject parts of it before execution.
                            </li>
                            <li>
                                Fast mode does not bypass planning. If behavior
                                changes, verify profile limits before assuming a
                                planner bug.
                            </li>
                            <li>
                                Weather context integration is implemented and
                                fail-open. Tool failure should not block message
                                completion.
                            </li>
                            <li>
                                TRACE target/final are required rendering inputs
                                for message outcomes; verify both when editing
                                planner or metadata assembly paths.
                            </li>
                            <li>
                                TrustGraph metadata exists, but user-facing
                                trust claims should stay tied to fields actually
                                present in the trace payload.
                            </li>
                        </ul>
                    </section>

                    <section
                        className="onboarding-section"
                        id="where-next"
                        aria-labelledby="where-next-title"
                    >
                        <h2 id="where-next-title">Where to read next</h2>
                        <ul>
                            <li>
                                <code>
                                    docs/architecture/context-integrations/weather-forecast.md
                                </code>
                            </li>
                            <li>
                                <code>
                                    packages/backend/src/services/workflowEngine.ts
                                </code>
                            </li>
                            <li>
                                <code>
                                    packages/backend/src/services/chatOrchestrator.ts
                                </code>
                            </li>
                            <li>
                                <code>
                                    packages/backend/src/services/plannerWorkflowSeams.ts
                                </code>
                            </li>
                            <li>
                                <code>
                                    packages/contracts/src/ethics-core/types.ts
                                </code>
                            </li>
                            <li>
                                <code>
                                    packages/web/src/pages/TracePage.tsx
                                </code>
                            </li>
                        </ul>
                    </section>
                </article>
            </div>
        </main>
        <Footer />
    </>
);

export default OnboardingPage;
