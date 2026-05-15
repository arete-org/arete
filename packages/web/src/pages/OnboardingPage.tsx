/**
 * @description: Contributor onboarding page that provides a first-run path,
 * architecture orientation, and practical entry points by contributor type.
 * @footnote-scope: web
 * @footnote-module: OnboardingPage
 * @footnote-risk: medium - Incorrect onboarding guidance can cause contributor confusion and incorrect edits.
 * @footnote-ethics: medium - Clear docs reduce misrepresentation of trust and provenance behavior.
 */

import Header from '@components/Header';
import Footer from '@components/Footer';
import StickySectionToc from '@components/StickySectionToc';

type OnboardingSectionId =
    | 'first-30-minutes'
    | 'repo-shape'
    | 'request-lifecycle'
    | 'architecture-rules'
    | 'workflow-boundaries'
    | 'symbols'
    | 'contributor-paths'
    | 'gotchas';

type SectionLink = {
    id: OnboardingSectionId;
    label: string;
};

type SymbolKind = 'type' | 'function' | 'seam' | 'module' | 'concept';

type SymbolGroup = 'workflow execution' | 'planning' | 'context integrations';

type SymbolReferenceEntry = {
    name: string;
    kind: SymbolKind;
    group: SymbolGroup;
    filePath: string;
    explanation: string;
};

const REPOSITORY_BASE_URL = 'https://github.com/footnote-ai/footnote/blob/main';

const getRepositoryFileUrl = (filePath: string): string =>
    `${REPOSITORY_BASE_URL}/${filePath}`;

const sectionLinks: SectionLink[] = [
    { id: 'first-30-minutes', label: 'First 30 minutes' },
    { id: 'repo-shape', label: 'Repo and package shape' },
    { id: 'request-lifecycle', label: 'Request lifecycle' },
    { id: 'architecture-rules', label: 'Architecture rules' },
    { id: 'workflow-boundaries', label: 'Workflow boundaries' },
    { id: 'symbols', label: 'Important symbols' },
    { id: 'contributor-paths', label: 'Paths by contributor type' },
    { id: 'gotchas', label: 'Gotchas' },
];

const symbolReferences: SymbolReferenceEntry[] = [
    {
        name: 'workflowEngine',
        kind: 'module',
        group: 'workflow execution',
        filePath: 'packages/backend/src/services/workflowEngine.ts',
        explanation:
            'Owns step ordering, timing, limits, termination, and lineage records.',
    },
    {
        name: 'ContextStepExecutor',
        kind: 'type',
        group: 'workflow execution',
        filePath: 'packages/backend/src/services/workflowEngine.ts',
        explanation:
            'Contract for running context integrations before generation.',
    },
    {
        name: 'ContextStepResult',
        kind: 'type',
        group: 'workflow execution',
        filePath: 'packages/backend/src/services/workflowEngine.ts',
        explanation:
            'Context-step outcome shape: execution context, optional messages, and sources.',
    },
    {
        name: 'chatOrchestrator',
        kind: 'module',
        group: 'planning',
        filePath: 'packages/backend/src/services/chatOrchestrator.ts',
        explanation:
            'Builds request context, planner seams, and runtime dependencies before chat execution.',
    },
    {
        name: 'PlannerStepExecutor',
        kind: 'type',
        group: 'planning',
        filePath: 'packages/backend/src/services/plannerWorkflowSeams.ts',
        explanation:
            'Injected plan-step executor used by workflow timing boundaries.',
    },
    {
        name: 'PlanContinuationBuilder',
        kind: 'seam',
        group: 'planning',
        filePath: 'packages/backend/src/services/plannerWorkflowSeams.ts',
        explanation:
            'Policy seam that decides continue_message vs terminal_action after plan application.',
    },
    {
        name: 'trace_target',
        kind: 'concept',
        group: 'planning',
        filePath: 'packages/contracts/src/policy/types.ts',
        explanation:
            'TRACE target posture captured from planner/runtime temperament at response time.',
    },
    {
        name: 'trace_final',
        kind: 'concept',
        group: 'planning',
        filePath: 'packages/contracts/src/policy/types.ts',
        explanation:
            'TRACE final posture surfaced in metadata for rendering and trace review.',
    },
];

const symbolGroups: SymbolGroup[] = [
    'workflow execution',
    'planning',
    'context integrations',
];

const SymbolBadge = ({ kind }: { kind: SymbolKind }): JSX.Element => (
    <span
        className={`onboarding-symbol-badge onboarding-symbol-badge--${kind}`}
    >
        {kind}
    </span>
);

const OnboardingPage = (): JSX.Element => {
    return (
        <>
            <Header />
            <main className="page-content" id="main-content">
                <header
                    className="page-hero"
                    aria-labelledby="onboarding-title"
                >
                    <h1 id="onboarding-title">Contributor onboarding</h1>
                    <p className="page-hero__summary">
                        This page is a practical start path for contributors.
                    </p>
                </header>

                <div className="page-layout">
                    <StickySectionToc
                        ariaLabel="Onboarding sections"
                        sections={sectionLinks}
                    />

                    <article className="page-content__main">
                        <section
                            className="page-section"
                            id="first-30-minutes"
                            aria-labelledby="first-30-minutes-title"
                        >
                            <h2 id="first-30-minutes-title">
                                First 30 minutes
                            </h2>
                            <ol>
                                <li>
                                    Clone the repository and install
                                    dependencies with <code>pnpm</code>.
                                </li>
                                <li>
                                    Follow{' '}
                                    <a
                                        href="https://github.com/footnote-ai/footnote#quickstart"
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        Quickstart
                                    </a>{' '}
                                    to configure one model provider.
                                </li>
                                <li>Run backend and web locally.</li>
                                <li>Send one chat message in the web app.</li>
                                <li>Open the trace link from that response.</li>
                                <li>
                                    Confirm you can identify workflow steps,
                                    safety tier, TRACE posture, and any source
                                    links.
                                </li>
                            </ol>
                            <p>
                                After this loop, you have seen the full request
                                path end-to-end.
                            </p>
                        </section>

                        <section
                            className="page-section"
                            id="repo-shape"
                            aria-labelledby="repo-shape-title"
                        >
                            <h2 id="repo-shape-title">
                                Repo and package shape
                            </h2>
                            <ul>
                                <li>
                                    <code>packages/backend</code>: execution
                                    authority for workflow, policy, metadata,
                                    and trace storage.
                                </li>
                                <li>
                                    <code>packages/web</code>: browser rendering
                                    of backend-owned output and docs pages.
                                </li>
                                <li>
                                    <code>packages/contracts</code>: shared
                                    transport and metadata schema contracts.
                                </li>
                                <li>
                                    <code>packages/discord-bot</code>: Discord
                                    transport/UI for backend-owned outputs.
                                </li>
                                <li>
                                    <code>packages/agent-runtime</code> and{' '}
                                    <code>packages/prompts</code>: runtime and
                                    prompt-layer dependencies.
                                </li>
                            </ul>
                        </section>

                        <section
                            className="page-section"
                            id="request-lifecycle"
                            aria-labelledby="request-lifecycle-title"
                        >
                            <h2 id="request-lifecycle-title">
                                Request lifecycle
                            </h2>
                            <ol>
                                <li>
                                    <code>/api/chat</code> normalizes request
                                    input and conversation context.
                                </li>
                                <li>
                                    <code>chatOrchestrator</code> resolves mode
                                    and profile context, then wires planner and
                                    context seams.
                                </li>
                                <li>
                                    <code>workflowEngine</code> runs plan first,
                                    then optional context integrations, then
                                    generation/review flow.
                                </li>
                                <li>
                                    Planner output is policy-applied before
                                    continuation. This keeps planner advisory
                                    and backend policy authoritative.
                                </li>
                                <li>
                                    Metadata is assembled and persisted with
                                    citations, safety, TRACE, lineage, and
                                    timing.
                                </li>
                            </ol>
                        </section>

                        <section
                            className="page-section"
                            id="architecture-rules"
                            aria-labelledby="architecture-rules-title"
                        >
                            <h2 id="architecture-rules-title">
                                Architecture rules
                            </h2>
                            <ul>
                                <li>
                                    If a decision changes runtime behavior, it
                                    belongs in backend policy/orchestration, not
                                    in web or Discord adapters.
                                </li>
                                <li>
                                    Web and Discord render backend-owned truth.
                                    They do not invent workflow history or mode
                                    semantics.
                                </li>
                                <li>
                                    Planner output is advisory. Keep policy
                                    application explicit and inspectable.
                                </li>
                                <li>
                                    Public interfaces must stay serializable so
                                    every surface can consume the same payload.
                                </li>
                                <li>
                                    Fail-open behavior is intentional: uncertain
                                    integrations should degrade safely, not
                                    block execution.
                                </li>
                            </ul>
                        </section>

                        <section
                            className="page-section"
                            id="workflow-boundaries"
                            aria-labelledby="workflow-boundaries-title"
                        >
                            <h2 id="workflow-boundaries-title">
                                Workflow boundaries
                            </h2>
                            <p>
                                <code>workflowEngine</code> owns execution
                                control flow: step ordering, timing, limits, and
                                termination lineage.
                            </p>
                            <p>
                                Common boundary mistakes are routing logic in
                                the engine that should live in
                                policy/orchestrator, or policy decisions in UI
                                adapters.
                            </p>
                        </section>

                        <section
                            className="page-section"
                            id="symbols"
                            aria-labelledby="symbols-title"
                        >
                            <h2 id="symbols-title">Important symbols</h2>
                            {symbolGroups.map((group) => (
                                <section
                                    key={group}
                                    className="onboarding-symbol-group"
                                    aria-labelledby={`symbol-group-${group.replace(/\s+/g, '-')}`}
                                >
                                    <h3
                                        id={`symbol-group-${group.replace(/\s+/g, '-')}`}
                                    >
                                        {group}
                                    </h3>
                                    <div className="onboarding-symbol-table-wrap">
                                        <table className="onboarding-symbol-table">
                                            <thead>
                                                <tr>
                                                    <th scope="col">Symbol</th>
                                                    <th scope="col">
                                                        Explanation
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {symbolReferences
                                                    .filter(
                                                        (entry) =>
                                                            entry.group ===
                                                            group
                                                    )
                                                    .map((entry) => (
                                                        <tr key={entry.name}>
                                                            <td className="onboarding-symbol-table__symbol-cell">
                                                                <a
                                                                    className="onboarding-symbol-table__symbol-link"
                                                                    href={getRepositoryFileUrl(
                                                                        entry.filePath
                                                                    )}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    aria-label={`Open ${entry.name} in repository`}
                                                                >
                                                                    <code className="onboarding-symbol-table__inline-code">
                                                                        {
                                                                            entry.name
                                                                        }
                                                                    </code>
                                                                </a>
                                                                <div className="onboarding-symbol-table__kind">
                                                                    <SymbolBadge
                                                                        kind={
                                                                            entry.kind
                                                                        }
                                                                    />
                                                                </div>
                                                            </td>
                                                            <td>
                                                                {
                                                                    entry.explanation
                                                                }
                                                            </td>
                                                        </tr>
                                                    ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </section>
                            ))}
                        </section>

                        <section
                            className="page-section"
                            id="contributor-paths"
                            aria-labelledby="contributor-paths-title"
                        >
                            <h2 id="contributor-paths-title">
                                Paths by contributor type
                            </h2>
                            <ul>
                                <li>
                                    Backend contributor: start with
                                    <code>workflowEngine</code>,{' '}
                                    <code>chatOrchestrator</code>, and related
                                    tests in <code>packages/backend/test</code>.
                                </li>
                                <li>
                                    Web contributor: start with
                                    <code>TracePage</code> and provenance
                                    rendering components in
                                    <code>packages/web/src</code>.
                                </li>
                                <li>
                                    Docs/design contributor: start with
                                    <code>docs/architecture/README.md</code> and
                                    context integration architecture docs.
                                </li>
                            </ul>
                        </section>

                        <section
                            className="page-section"
                            id="gotchas"
                            aria-labelledby="gotchas-title"
                        >
                            <h2 id="gotchas-title">Gotchas</h2>
                            <ul>
                                <li>
                                    Planner output is advisory. Backend policy
                                    can adjust or reject planner fields before
                                    execution continues.
                                </li>
                                <li>
                                    TRACE target and TRACE final should both be
                                    populated for message paths. The former is
                                    set by the planner, and the latter is what
                                    was landed on prior to submission.
                                </li>
                                <li>
                                    Context integrations are fail-open,
                                    degrading safely rather than blocking
                                    message completion.
                                </li>
                            </ul>
                        </section>
                    </article>
                </div>
            </main>
            <Footer />
        </>
    );
};

export default OnboardingPage;
