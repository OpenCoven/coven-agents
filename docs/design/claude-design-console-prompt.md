# Claude Design brief: console visual language

- Status: reference brief
- Lifecycle: Proposed
- Authority: none. This is an input to a design tool, not product guidance.
- Last reviewed: 2026-09-08

This is an exploratory brief for a Claude Design canvas, not implementation
approval or a statement of shipped behavior. It preserves the proposed family
resemblance to Coven Cave and OpenCoven Chat without making those external
references authoritative over this repository.

Baseline: `main` at `8dab5081ec61f3273fb350f07066391fccfa3ff7`.
Current constraints were checked against `app/console.css`,
`components/console/{team-console,run-console,create-agent}.tsx`,
`lib/console/blocks.ts`, `packages/agent-contracts/src/index.ts`, and
`lib/teams/service.ts`. Recheck these sources before implementing a design.

Runs renders streamed records. Teams automatically refreshes a selected
nonterminal run 1.5 seconds after each request finishes; its manual Refresh
also reloads the catalog. Teams already shows member records, handoffs and
approval controls, but does not expose nested live tool activity in those
records. A new thread layout is a proposal, not missing backend functionality.

Capture fresh screenshots before running this brief. Optional external
references are Chat's `Familiars Redesign v2.dc.html` and
`ReasoningCard v2.dc.html`, and Cave's `Coven Cave Redesign.dc.html` with its
design-system bundle. Those artifacts are not included or verified here;
identify any supplied version in the design handoff. The local token subset
below is sufficient to begin without them. All layouts, dimensions, copy
examples and interactions below are proposals unless explicitly identified
as current. No private task content belongs in the canvas or this document.

---

# Brief: bring the coven-agents console up to the Coven Cave / OpenCoven Chat design language

You are the design lead for **coven-agents**, the web console where a subscriber forges execution profiles (agents), hands them a mission, and reads the receipt each run proves itself with. Sibling apps **Coven Cave** (desktop control room) and **OpenCoven Chat** (Familiars Redesign v2) already express the house language. Your job is to redesign the console so it reads as the same family: same palette, same type system, and above all the same *live, conversational* grammar. Build on the current console, including its familiar picker, member records, approval controls and receipt views.

Deliver a Claude Design canvas with the artboards listed in §9. Use dark mode for this design deliverable; retain existing product theme support. Desktop 1440×900 primary, plus one 1024-wide and one 720-wide variant of the Teams surface.

## 1. What you are redesigning

Capture these five current surfaces; the descriptions are design targets, not a claim that screenshots are attached:

1. **Teams** (coordinated execution): left rail of teams, a "Mission" textarea with a detached "Start coordinated run" button, and a split "Run history / Start the first coordinated run" empty well.
2. **Create a skill**: centered form with name, description, instructions, and a "Required capabilities" checkbox grid.
3. **Create a team**: centered form with numbered member editors, skill checkboxes, "Required step" toggle, "Add member".
4. **Runs → Choose how to begin**: three path cards (Start from a role · Create a crew · Forge a profile).
5. The shared chrome: 52px header with brand mark + `TEAMS`/`RUNS` eyebrow, centered "Search runs, agents, and commands ⌘K" pill, right-side Runs/Teams toggle and a `CONNECTED` status pill.

Keep every noun and every flow. Do not rename teams, skills, profiles, runs, receipts, capabilities, or missions. Do not add backend capabilities. Proposed controls must map to an existing action and available data; omit unsupported states or label them as out-of-scope exploration.

## 2. The three source apps and what to take from each

**coven-agents (keep):** its token contract is already correct and must remain the substrate. Values in §3 are its real values. Keep EB Garamond for page titles, Inter for UI, JetBrains Mono for anything the machine produced or the user must inspect (paths, capability names, identifiers, eyebrows). Keep the centered ⌘K search and the copy voice ("What should {agent} prove?", "Closed with a receipt. The evidence above is what it is claiming.").

**Coven Cave (adopt the doctrine and the shell):**
- Elevation is a lightness step up the same hue, never a shadow alone. Popover is lighter than card is lighter than page.
- Use primary, secondary and muted for readable content. The existing faint token is reserved for decoration or disabled states, not essential labels.
- Accent is *presence*, not call-to-action. At most one filled accent control per surface.
- Reuse existing semantic fills (13% success/warning/danger, 15% presence/info) and border tokens. Do not replace them with a universal tint recipe.
- One hairline per boundary. Prefer surface steps to borders. Solid hairline = content, dashed hairline = invitation (empty slot, drop zone, "add member").
- Progressive disclosure ladder: always visible → reveal on hover/focus → overflow "⋯" → ⌘K only. At most three always-visible actions plus one overflow per surface. Keep required actions discoverable and keyboard accessible; palette relocation requires an existing command or an explicitly identified frontend addition.
- Offer Undo only when an existing inverse operation can restore the prior state. Preserve existing confirmation requirements; do not imply server rollback support.
- Color never carries meaning alone: every dot has a word next to it.
- Density is a feature; illegibility is a bug. 13px chrome; run-record prose promotes to 14–16px with a 48rem measure.
- One flourish per surface, then back to utility. No terminal cosplay: no scan lines, no monospace body text, no perpetual animation, no glow shadows on chrome.
- Shell: viewport-locked tri-pane. Nav rail and detail pane are floating cards on a slightly darker floor, 16px radius, hairline border, shadow `0 14px 36px -28px`. Bottom status strip 28px.

**OpenCoven Chat, Familiars v2 (adopt the components and the live grammar):**
- Three columns: conversations rail (300) · thread · inspector (360). Rails collapse by animating the grid column to 0 over 200ms; the inner pane keeps its width so content never reflows.
- Ultra-thin full-height rail toggles on the thread's two edges: a 1px hairline at rest, a 3px accent strip with a caret on hover, a brighter line when the rail is closed. Proposed keys `[` and `]` must not intercept typing. The thin line is visual only: retain a labeled button with at least a 28px hit target.
- Bottom-docked composer card: toolbar row (only supported actions, inline "Message {name}" label, conditional amber "Held for approval" button) over an auto-growing textarea and a 32px send control. The whole composer glows on focus-within: accent 45% border, `0 0 0 3px` accent 12% ring.
- **Held-action card** (the centerpiece): amber-bordered card with a soft amber downglow. Head = hand glyph / title + detail / "Waiting for approval" with a pulsing dot. Source line "Held by the ward" + code chip. A `<dl>` fact strip on a sunken surface with 10px uppercase labels and 11px mono values. Footer: an optional verified source link, then Reject ghost and Approve primary. Map terminal status to actual approved/rejected decisions. Teams has no expired or "Ask again" transition; exclude those states and any unavailable facts. Do not show a PR link until a real URL exists.
- **Activity card** (a proposed presentation, not private reasoning): collapsible timeline of exposed execution records. Head grid `16px 1fr auto 14px`: glyph, "Activity" + a recorded summary, meta (`N failed` in danger, `N steps`, mono duration), caret that rotates 180°. Body opens `0fr → 1fr` over 520ms; steps enter on an 18px rail with a connector that scales in. Runs of routine steps beyond seven fold into one "N steps" row.
- Thinking indicator: three 4px accent dots bouncing at 0/150/300ms delay with a contextual label, in an `aria-live="polite"` output.
- Conversation rows transparent at rest; hover and selected are the same `--bg-hover`, distinguished only by title weight 500 → 600.
- Empty state: 32–40px circular glyph tile, 14px/600 title, 12px secondary line, one secondary button. Use sans for this compact component; preserve existing serif identity moments elsewhere.
- Segmented control on a sunken track with inset shadow; pressed option lifts to raised with a sheen.
- Motion: use existing `--ease-standard` and `--ease-decelerate` tokens. Durations above are canvas explorations; implementation must reconcile them with existing duration tokens. Messages rise 8px over 420ms, staggered by index. Complete reduced-motion parity.

Local code and accessibility requirements take precedence. Use Cave and Chat as visual references, not evidence of supported actions or telemetry.

## 3. Current dark token contract

This is a subset of the `.oc-console` root declarations in `app/console.css`.
Values are current at the baseline above; the stylesheet remains authoritative.
Do not overwrite theme overrides or introduce tokens from external references.

```css
--bg-desk: oklch(0.078 0.004 285);
--bg-panel: oklch(0.108 0.004 285);
--bg-sunken: oklch(0.12 0.004 285);
--bg-base: oklch(0.14 0.005 285);
--bg-raised: oklch(0.18 0.005 285);
--bg-elevated: oklch(0.22 0.006 285);
--bg-hover: oklch(0.25 0.007 285);
--code-surface: oklch(0.104 0.004 285);
--ink: oklch(0.965 0.003 285);
--text-primary: oklch(0.965 0.003 285);
--text-secondary: oklch(0.8 0.004 285);
--text-muted: oklch(0.68 0.004 285);
--text-faint: oklch(0.56 0.004 285);
--border-hairline: color-mix(in oklch, var(--ink) 15%, transparent);
--border-strong: color-mix(in oklch, var(--ink) 30%, transparent);
--accent-presence: #9386d0;
--accent-ink: oklch(0.135 0.005 285);
--accent-signal: oklch(0.76 0.11 225);
--fill-signal: color-mix(in oklch, var(--accent-signal) 12%, transparent);
--color-success: oklch(0.78 0.14 158);
--color-warning: oklch(0.83 0.13 78);
--color-danger: oklch(0.74 0.18 24);
--fill-success: color-mix(in oklch, var(--color-success) 13%, transparent);
--fill-warning: color-mix(in oklch, var(--color-warning) 13%, transparent);
--fill-danger: color-mix(in oklch, var(--color-danger) 13%, transparent);
--fill-info: color-mix(in oklch, var(--accent-presence) 15%, transparent);
--danger-bg: color-mix(in oklch, var(--color-danger) 12%, transparent);
--danger-border: color-mix(
    in oklch,
    var(--color-danger) 38%,
    var(--border-hairline)
  );
--danger-text: oklch(0.83 0.09 24);
--radius-sm: 6px;
--radius-md: 8px;
--radius-control: 8px;
--radius-card: 12px;
--radius-panel: 16px;
--radius-pill: 999px;
--font-ui: var(--font-inter), system-ui, sans-serif;
--font-mono: var(--font-jetbrains-mono), ui-monospace, Menlo, monospace;
--font-serif: var(--font-eb-garamond), Georgia, serif;
--shadow-sm: 0 1px 2px oklch(0 0 0 / 0.3);
--shadow-md: 0 4px 12px -2px oklch(0 0 0 / 0.4);
--shadow-lg: 0 16px 48px -8px oklch(0 0 0 / 0.55);
--duration-fast: 120ms;
--duration-base: 180ms;
--duration-slow: 260ms;
--ease-standard: cubic-bezier(0.2, 0, 0.2, 1);
--ease-decelerate: cubic-bezier(0, 0, 0.2, 1);
--ring-focus: oklch(0.78 0.115 292);
--h-xs: 24px;
--h-sm: 28px;
--h-md: 32px;
--h-lg: 36px;
```

Proposed type/layout guide (not CSS declarations): page titles use EB Garamond
at 26–28px; UI uses Inter at 13px; record prose uses Inter at 14–16px with a
48rem measure; identifiers use JetBrains Mono. Small labels must remain readable
and pass contrast checks on their actual surface. Suggested spacing steps are
4, 8, 12, 16, 20, 24, 32, 40 and 48px; there is no `--space` token. Do not add
`--tool-*`, `--lift` or `--ease-reveal` variables as if they already existed.
Use existing semantic colors with text/glyph labels for exposed activity kinds.

Grain and bloom are permitted as the one flourish per surface: an SVG turbulence overlay at 5% opacity, mix-blend overlay, and a radial accent bloom at 6% behind the record thread. Nowhere else.

## 4. Layout to design

**Shell (all views).** 52px header on `--bg-panel`: brand mark + "OpenCoven" + eyebrow of the current surface on the left; the search pill centered, `min(660px, 42vw)`, hairline always visible so it reads as a landmark; right side holds the Runs/Teams switch and the connection pill. Below it a floor at `--bg-desk`. Nav rail and main pane float as `--radius-panel` cards with hairline borders. A 28px status strip at the bottom shows available connection and active-run lifecycle data. Omit runner region unless the current API supplies it.

**Runs and Teams share one grammar:** rail (296, resizable 248–420, collapses to a 28px strip) · record thread (max-width 840, prose measure 48rem) · inspector (300–360, collapsible). The record thread has a 44px header that hides on scroll-down. The composer is bottom-docked in the thread column. Keep `⌘K` for the palette. Rail shortcuts are proposed and must ignore editable targets. Scope `⌘↵` to the focused composer or explicitly focused approval card, never both. Do not add a global decline shortcut; decisions require deliberate interaction with the relevant card.

## 5. Surface-by-surface briefs

### 5.1 Teams
- **Rail**: eyebrow "Coordinated execution", serif "Teams". One list, one row per team. The built-in GitHub delivery team is a row with a `ShieldCheck` glyph and an origin chip "built-in", not a second card. Rows: name 13px/500, "4 members · Issues · PRs · approvals" meta, transparent at rest. Pinned footer: "Create team" secondary, "Create reusable skill" ghost.
- **Thread header**: eyebrow "4 member sequence", team name in 13px/600 sans (serif is for the rail title only), member avatars as a 22px stack, "Runtime" and "⋯" overflow.
- **Record thread**, empty: Chat-style empty state, glyph tile + "Start the first coordinated run" 14px/600 + "The record will show every member, approval, handoff, and execution identifier in sequence." + no button (the composer below is the action).
- **Record thread, running**: mission bubble (user, asymmetric radius, inset left accent stripe) → one *member turn* per team member, avatar column 22px, name + lifecycle badge → inside it the available lifecycle, execution identifier and completed handoff records → a status row such as "Builder is running" while live. Do not invent nested tool steps, reasoning or a specific action from running status. Any future child-run activity integration needs separate frontend/API verification.
- **Held approval**: the existing banner "GitHub write approval required / The current step may use only its declared write capabilities. Instructions cannot expand this grant." becomes a held-action card. Fact strip: declared capability · member · execution identifier when present. The step contract has no approval-request timestamp, repository or PR URL field; omit those facts unless separately available from verified data. Footer: Reject and Approve using existing decision handlers. Show pending, approved and rejected variants; no expired/Ask again state. Approval requires the step to still be waiting for a pending decision.
- **Complete**: closing receipt line "Closed with a receipt." with the execution identifier in mono and a "Copy the run receipt" ghost.
- **Composer**: label "What should {team} prove?"; placeholder "Name the issue, pull request, repository, expected outcome, and evidence the team must return."; send is the one filled accent control; hint `⌘ ↵ to run`.
- **Inspector** (segmented: Members · Runs · Bounds): Members lists the sequence with required-step marks; Runs is the run history (lifecycle pill, mono id, relative time); Bounds lists declared capabilities as mono chips and the Daytona boundary copy. Footer "Settings ⌘,".
- **Run history rows** must read like Chat conversation rows, not a table.

### 5.2 Runs (existing composer + thread)
Bring it to the same grammar. Keep the existing block kinds: mission · lifecycle · command · files · text · error · evidence. Command blocks retain their known command semantics and existing accent and a `<details>` disclosure like Cave's tool blocks. Right-side steps timeline becomes the inspector's Steps tab. Show: empty ("Autonomous agents, bounded by infrastructure."), running with live activity, terminal with evidence.

### 5.3 Choose how to begin
Keep the three paths and their copy. Cards: 32px icon tile on `--bg-raised`, eyebrow, 20px serif title (identity moment, allowed), body, mono outcome line ("1 profile · one action"), hairline card with a proposed hover (translateY -1px, shadow-md). Remove the left decorative rule. Card height fits content. Cancel moves to the header's right slot as ghost.

### 5.4 Create a team and Create a skill
Centered panel `min(680px, 100% - 40px)` (team editor `min(900px…)`). Fields: eyebrow label over a `--bg-sunken` input with hairline, focus = accent 55% border. Member editor: numbered `01` mono, profile picker as a segmented-style select, responsibility textarea, skills as custom checkbox chips (14px box, sunken, accent check), "Required step" as a labeled switch. "Add member" is styled as a dashed-hairline invitation row while retaining native button semantics and keyboard operation. Capability grid: two columns of chips in mono, with the note about GitHub Project capabilities as a muted line beneath. Primary disabled state = raised fill, faint text, no accent. Footer: Cancel ghost · Save skill / Create team primary.

## 6. Component sheet to deliver
Btn (xs 24 / sm 28 / md 32 / lg 36; xs has an expanded hit target; primary · secondary · ghost · danger-ghost; with spinner), IconBtn 28, Pill (tint recipe, all four tones), LifecycleBadge (queued · running · needs approval · completed · failed · cancelled), OriginChip, ListRow (rail row with icon tile, name, meta, hover arrow), Avatar (22/28/36 with presence dot: available lavender · working amber · offline muted), Composer (rest · focus · warn), HeldActionCard (pending · approved · rejected), ActivityCard (collapsed · open · with failures), ThinkingRow, CommandBlock (known activity kinds, collapsed · open), EmptyState, ErrorState, Skeleton (row · card · text), Segmented, Tabs (underline, Vercel-style), SearchPill, CommandPalette (with group column and kbd hints), UndoToast (local draft/UI edits only; no undo for team deletion; shortcut scoped to that action), StatusStrip, RailToggle (rest · hover · closed).

## 7. Copy rules
Sentence case. Contractions allowed. Single `…` character. Buttons name the operation: never Submit, OK, Confirm. Lifecycle verbs stay constant: Start → Starting… → Started. Toggles name the next action. One flourish per surface; a form or error is never in character. Every empty state says what to do next. Every color dot has a word.

## 8. Accessibility and states
Verify WCAG AA contrast for each actual text/surface combination; the token
list alone does not guarantee contrast. Do not use faint ink for essential text.
Preserve each control's visible `--ring-focus` outline (2px, normally 2px offset;
inputs in native dialogs may use an inset outline). Composer/palette group glow
is supplemental and never replaces individual focus. Hover-reveal controls stay
in the tab order and appear on `:focus-within`; on coarse pointers they are always
visible. Every animation has a reduced-motion equivalent, including thinking
dots and pulses. Use at least 28px interactive hit targets, even for 24px visual
controls and hairline toggles. Overlay rails need focus management, Escape and
focus return. Status announcements should describe meaningful changes, not every
poll; announce a held approval once on arrival without stealing focus.


## 9. Artboards (name them exactly)
1. `Shell / Teams / empty`
2. `Shell / Teams / running`
3. `Shell / Teams / held approval`
4. `Shell / Teams / complete`
5. `Shell / Teams / 1024`
6. `Shell / Teams / 720` (rails overlay the record instead of squeezing it)
7. `Shell / Runs / running`
8. `Shell / Runs / receipt`
9. `Runs / Choose how to begin`
10. `Teams / Create a team`
11. `Teams / Create a skill`
12. `Overlay / Command palette`
13. `Components / sheet` (every component in §6, every state)
14. `Tokens / reference` (swatches, radii, spacing, type ladder, easing curves)

Export the design-system bundle with CSS variables using the exact names in §3 so engineering can diff it against `app/console.css`.

## 10. Anti-goals
No light-theme artboard in this deliverable; do not remove product theme support. No new hues. No extra content ink tiers. No second filled accent control on a surface. No pill-shaped primary buttons. No backdrop blur except popovers and modals. No `transform: scale`. No typewriter streaming. No decorative rules, scan lines, or CRT effects. No tables where a list of rows will do. Preserve catalog refresh and error recovery unless an equivalent supported refresh path is designed. Polling alone does not replace catalog refresh. No renaming of product nouns. No feature that needs a new API.
