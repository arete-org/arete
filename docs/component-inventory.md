# Coaching component inventory — ARE-136 / ARE-12 / ARE-86

`design.md` remains the source for visual tokens. Four palettes are supported:
Pierre, Prune, Odyssey and Encre. Système selects Pierre or Encre. Inter is interface
text, Cormorant Garamond is headings/brand, and monospace is code only. The PWA's
static launch background now matches Pierre; its runtime theme color follows the
saved preference.

The development route `/design-system` renders the actual shared components,
without a model call or saved preference change. Leaving restores the saved
palette and its system listener. The gallery is excluded from production builds.

| Responsibility | Existing code owner | Design reference | Browser coverage |
| --- | --- | --- | --- |
| Brand and headings | `AreteBrand`, `page-title`, shared font tokens | [Home 336:109](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=336-109) | `coach-name`, `coaching-attention`, `design-system` |
| Action, field, panel, loading state | `components/ui/{Button,Input,Field,Panel,Skeleton}` | [Planning 336:216](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=336-216) | `design-system`, `mobile-ux`, `planning-crud` |
| Priority and next action | `CoachingAttention`, existing source projection | Home reference above; priority placement intentionally leads the revised journey | `coaching-attention` at 390 / 1440 px |
| Question, approval and receipt | `FollowupCard`, `ProposalCard`, `AutomationReview`, `PlanChangeReview` | [Coach 376:17529](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=376-17529) | `automations`, `evening-message`, `renegotiate` |
| Feedback and composer | `FeedbackRating`, `MessageFeedback`, existing `AgentSidePanel` composer | Coach reference above | `briefing`, `feedback`, `mobile-ux` |
| Goals and source status | existing Settings goal editor, `GoalProjectionPanel`, `SourceStatus` | Planning reference above | `hybrid-goals`, `requests` |
| Theme preview | `theme.ts`, `index.css`, `DesignSystem` | [Prune 378:15685](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=378-15685) | four-theme gallery screenshots, contrast and system-following checks |

These links map components to their reference screens; they are not published
Figma Code Connect bindings. No replacement design library or duplicated feedback
composer is introduced. The new placement and preset cards still need a reviewed
Figma update before treating the old prototypes as exact screenshots.

Remaining design slices: migrate legacy semantic aliases with visual comparisons,
publish reusable Figma component bindings, and then tackle ARE-31 gamification
visuals. They are deliberately separate from this coaching journey.
