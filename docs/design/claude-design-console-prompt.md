# Claude Design brief: console visual language

- Status: reference brief
- Lifecycle: Proposed
- Authority: none. This is an input to a design tool, not product guidance.
- Last reviewed: 2026-09-04

This document is the brief handed to a Claude Design agent to redesign the
console so it reads as one family with two sibling apps: Coven Cave (the
desktop control room) and OpenCoven Chat (its Familiars Redesign v2 surface).

It is checked in so the design direction, and the reasoning behind it, survive
outside a single chat session. It does not approve any delivery work. It
describes no private task content, and every value it quotes is either a token
already defined in `app/console.css` or a UI string already present in
`components/console/`.

Background gathered while writing it:

- The console's token contract already matches Cave closely: the same oklch
  graphite ramp, the same `#9386d0` presence accent, and the same EB Garamond /
  Inter / JetBrains Mono type system. The palette is not the gap.
- The gap is interaction grammar. Runs streams over SSE into a record thread,
  while Teams polls every 1.5 seconds behind a manual refresh control and has
  no record thread, no held-approval card, and no inspector.
- Chat's Familiars v2 surface supplies the shapes for the missing live
  components. Cave supplies the token doctrine and the shell.

When the two references disagree, Cave wins on tokens and doctrine, and Chat
wins on the shape of live components. The brief says so explicitly.

Suggested attachments when running it: the current console screenshots, Chat's
`Familiars Redesign v2.dc.html` and `ReasoningCard v2.dc.html`, and Cave's
`Coven Cave Redesign.dc.html` with its design-system bundle. The brief inlines
every token value so it also works with no attachments at all.

---

# Brief: bring the coven-agents console up to the Coven Cave / OpenCoven Chat design language

You are the design lead for **coven-agents**, the web console where a subscriber forges execution profiles (agents), hands them a mission, and reads the receipt each run proves itself with. Sibling apps **Coven Cave** (desktop control room) and **OpenCoven Chat** (Familiars Redesign v2) already express the house language. Your job is to redesign the console so it reads as the same family: same palette, same type system, and above all the same *live, conversational* grammar. Today the console is a set of forms and empty panels. It should feel like a place where work is happening.

Deliver a Claude Design canvas with the artboards listed in §9. Dark mode only. Desktop 1440×900 primary, plus one 1024-wide and one 720-wide variant of the Teams surface.

## 1. What you are redesigning

Five current screens are attached as screenshots:

1. **Teams** (coordinated execution): left rail of teams, a "Mission" textarea with a detached "Start coordinated run" button, and a split "Run history / Start the first coordinated run" empty well.
2. **Create a skill**: centered form with name, description, instructions, and a "Required capabilities" checkbox grid.
3. **Create a team**: centered form with numbered member editors, skill checkboxes, "Required step" toggle, "Add member".
4. **Runs → Choose how to begin**: three path cards (Start from a role · Create a crew · Forge a profile).
5. The shared chrome: 52px header with brand mark + `TEAMS`/`RUNS` eyebrow, centered "Search runs, agents, and commands ⌘K" pill, right-side Runs/Teams toggle and a `CONNECTED` status pill.

Keep every noun and every flow. Do not rename teams, skills, profiles, runs, receipts, capabilities, or missions. Do not add features that need new backend capability beyond what §5 describes as already existing.

## 2. The three source apps and what to take from each

**coven-agents (keep):** its token contract is already correct and must remain the substrate. Values in §3 are its real values. Keep EB Garamond for page titles, Inter for UI, JetBrains Mono for anything the machine produced or the user must inspect (paths, capability names, identifiers, eyebrows). Keep the centered ⌘K search and the copy voice ("What should {agent} prove?", "Closed with a receipt. The evidence above is what it is claiming.").

**Coven Cave (adopt the doctrine and the shell):**
- Elevation is a lightness step up the same hue, never a shadow alone. Popover is lighter than card is lighter than page.
- Exactly three ink tiers. Do not invent a fourth.
- Accent is *presence*, not call-to-action. At most one filled accent control per surface.
- The tint recipe for every state chip, badge, and banner: text = solid semantic token; fill = that token at 14% over transparent; border = that token at 38% mixed into the hairline. Never a hardcoded color.
- One hairline per boundary. Prefer surface steps to borders. Solid hairline = content, dashed hairline = invitation (empty slot, drop zone, "add member").
- Progressive disclosure ladder: always visible → reveal on hover/focus → overflow "⋯" → ⌘K only. At most three always-visible actions plus one overflow per surface. Anything relocated must stay one keystroke away in the palette.
- Undo over confirm for reversible actions. Confirm only for irreversible ones.
- Color never carries meaning alone: every dot has a word next to it.
- Density is a feature; illegibility is a bug. 13px chrome; run-record prose promotes to 14–16px with a 48rem measure.
- One flourish per surface, then back to utility. No terminal cosplay: no scan lines, no monospace body text, no perpetual animation, no glow shadows on chrome.
- Shell: viewport-locked tri-pane. Nav rail and detail pane are floating cards on a slightly darker floor, 16px radius, hairline border, shadow `0 14px 36px -28px`. Bottom status strip 28px.

**OpenCoven Chat, Familiars v2 (adopt the components and the live grammar):**
- Three columns: conversations rail (300) · thread · inspector (360). Rails collapse by animating the grid column to 0 over 200ms; the inner pane keeps its width so content never reflows.
- Ultra-thin full-height rail toggles on the thread's two edges: a 1px hairline at rest, a 3px accent strip with a caret on hover, a brighter line when the rail is closed. Keys `[` and `]`.
- Bottom-docked composer card: toolbar row (attach, `/` commands, inline "Message {name}" label, conditional amber "Held for approval" button) over an auto-growing textarea and a 32px send control. The whole composer glows on focus-within: accent 45% border, `0 0 0 3px` accent 12% ring.
- **Held-action card** (the centerpiece): amber-bordered card with a soft amber downglow. Head = hand glyph / title + detail / "Waiting · {time}" with a pulsing dot. Source line "Held by the ward" + code chip. A `<dl>` fact strip on a sunken surface with 10px uppercase labels and 11px mono values. Footer: link-style "open", then `Decline ⌘⌫` ghost and `Approve ⌘↵` primary. Approved and declined collapse to a single status line; expired becomes a dashed row with "Ask again".
- **Reasoning card**: collapsible step timeline. Head grid `16px 1fr auto 14px`: glyph, "Reasoning" + truncated summary, meta (`N failed` in danger, `N steps`, mono duration), caret that rotates 180°. Body opens `0fr → 1fr` over 520ms; steps enter on an 18px rail with a connector that scales in. Runs of routine steps beyond seven fold into one "N steps" row.
- Thinking indicator: three 4px accent dots bouncing at 0/150/300ms delay with a contextual label, in an `aria-live="polite"` output.
- Conversation rows transparent at rest; hover and selected are the same `--bg-hover`, distinguished only by title weight 500 → 600.
- Empty state: 32–40px circular glyph tile, 14px/600 title, 12px secondary line, one secondary button. Never serif.
- Segmented control on a sunken track with inset shadow; pressed option lifts to raised with a sheen.
- Motion: two easings only. `cubic-bezier(0.3,0,0,1)` for state changes and hovers, `cubic-bezier(0.2,0.8,0.2,1)` for anything that opens or reveals. Messages rise 8px over 420ms, staggered by index. Complete reduced-motion parity.

Where Cave and Chat disagree, Cave wins on tokens and doctrine (no backdrop blur on buttons, no `transform: scale`, `#9386d0` not `#a79bf5`), Chat wins on the shape of live components.

## 3. Token contract (real values; use verbatim)

```css
/* elevation ramp, oklch hue 285 */
--bg-desk:      oklch(0.078 0.004 285);   /* behind everything */
--bg-panel:     oklch(0.108 0.004 285);   /* header, rails */
--bg-sunken:    oklch(0.12  0.004 285);   /* inputs, wells, fact strips */
--bg-base:      oklch(0.14  0.005 285);   /* page */
--bg-raised:    oklch(0.18  0.005 285);   /* cards */
--bg-elevated:  oklch(0.22  0.006 285);   /* popovers, menus */
--bg-hover:     oklch(0.25  0.007 285);
--code-surface: oklch(0.104 0.004 285);

/* ink, three tiers plus faint for eyebrows only */
--text-primary:   oklch(0.965 0.003 285);
--text-secondary: oklch(0.8   0.004 285);
--text-muted:     oklch(0.68  0.004 285);
--text-faint:     oklch(0.56  0.004 285);
--border-hairline: color-mix(in oklch, var(--text-primary) 15%, transparent);
--border-strong:   color-mix(in oklch, var(--text-primary) 30%, transparent);

/* accent: presence, not call-to-action */
--accent-presence: #9386d0;
--accent-ink:      oklch(0.135 0.005 285);
--ring-focus:      oklch(0.78 0.115 292);

/* semantic */
--color-success: oklch(0.78 0.14 158);
--color-warning: oklch(0.83 0.13 78);
--color-danger:  oklch(0.74 0.18 24);
/* fills = token 14%; borders = token 38% into hairline */

/* per-category tool accents (from Cave; use on step/command blocks) */
--tool-shell:  oklch(0.80 0.15 150);  --tool-read:  oklch(0.74 0.13 235);
--tool-search: oklch(0.74 0.16 295);  --tool-edit:  oklch(0.82 0.14 75);
--tool-agent:  oklch(0.74 0.18 350);  --tool-web:   oklch(0.78 0.12 200);

--radius-control: 8px; --radius-card: 12px; --radius-panel: 16px; --radius-pill: 999px;
--space: 4 8 12 16 20 24 32 40 48;
--duration-fast: 120ms; --duration-base: 180ms; --duration-slow: 260ms;
--ease-standard: cubic-bezier(0.2,0,0,1); --ease-reveal: cubic-bezier(0.2,0.8,0.2,1);
--shadow-sm: 0 1px 2px oklch(0 0 0/.3); --shadow-md: 0 4px 12px -2px oklch(0 0 0/.4);
--shadow-lg: 0 16px 48px -8px oklch(0 0 0/.55);
--h-xs: 24px; --h-sm: 28px; --h-md: 32px; --h-lg: 36px;

/* type ladder */
display:  400 26–28px/1.2 EB Garamond, letter-spacing -0.01em   /* page titles only */
title:    500 13px/1.2 Inter, -0.01em
body:     400 13px/1.6 Inter, --text-secondary
record:   400 14–16px/1.65 Inter, measure 48rem                  /* run-record prose */
label:    500 12px/1.3 Inter
eyebrow:  500 10px/1 JetBrains Mono, 0.12em, uppercase, --text-muted
meta:     400 10px/1 JetBrains Mono, --text-muted
code:     400 11px/1.65 JetBrains Mono
```

Grain and bloom are permitted as the one flourish per surface: an SVG turbulence overlay at 5% opacity, mix-blend overlay, and a radial accent bloom at 6% behind the record thread. Nowhere else.

## 4. Layout to design

**Shell (all views).** 52px header on `--bg-panel`: brand mark + "OpenCoven" + eyebrow of the current surface on the left; the search pill centered, `min(660px, 42vw)`, hairline always visible so it reads as a landmark; right side holds the Runs/Teams switch and the connection pill. Below it a floor at `--bg-desk`. Nav rail and main pane float as `--radius-panel` cards with hairline borders. A 28px status strip at the bottom shows connection, runner region, and the active run's lifecycle word.

**Runs and Teams share one grammar:** rail (296, resizable 248–420, collapses to a 28px strip) · record thread (max-width 840, prose measure 48rem) · inspector (300–360, collapsible). The record thread has a 44px header that hides on scroll-down. The composer is bottom-docked in the thread column. `[` and `]` toggle the rails; `⌘K` opens the palette; `⌘↵` sends; `⌘⌫` declines a held action.

## 5. Surface-by-surface briefs

### 5.1 Teams
- **Rail**: eyebrow "Coordinated execution", serif "Teams". One list, one row per team. The built-in GitHub delivery team is a row with a `ShieldCheck` glyph and an origin chip "built-in", not a second card. Rows: name 13px/500, "4 members · Issues · PRs · approvals" meta, transparent at rest. Pinned footer: "Create team" secondary, "Create reusable skill" ghost.
- **Thread header**: eyebrow "4 member sequence", team name in 13px/600 sans (serif is for the rail title only), member avatars as a 22px stack, "Runtime" and "⋯" overflow.
- **Record thread**, empty: Chat-style empty state, glyph tile + "Start the first coordinated run" 14px/600 + "The record will show every member, approval, handoff, and execution identifier in sequence." + no button (the composer below is the action).
- **Record thread, running**: mission bubble (user, asymmetric radius, inset left accent stripe) → one *member turn* per team member, avatar column 22px, name + lifecycle badge → inside it a reasoning card with the member's steps, each step glyph colored by its tool category → a thinking row "Builder is opening a pull request" while live.
- **Held approval**: the existing banner "GitHub write approval required / The current step may use only its declared write capabilities. Instructions cannot expand this grant." becomes a held-action card. Fact strip: repository · capability (`github.pull_requests.write`) · member · waiting since. Footer: open PR link, Decline ⌘⌫, Approve ⌘↵. Show approved, declined, and expired variants.
- **Complete**: closing receipt line "Closed with a receipt." with the execution identifier in mono and a "Copy the run receipt" ghost.
- **Composer**: label "What should {team} prove?"; placeholder "Name the issue, pull request, repository, expected outcome, and evidence the team must return."; send is the one filled accent control; hint `⌘ ↵ to run`.
- **Inspector** (segmented: Members · Runs · Bounds): Members lists the sequence with required-step marks; Runs is the run history (lifecycle pill, mono id, relative time); Bounds lists declared capabilities as mono chips and the Daytona boundary copy. Footer "Settings ⌘,".
- **Run history rows** must read like Chat conversation rows, not a table.

### 5.2 Runs (existing composer + thread)
Bring it to the same grammar. Keep the existing block kinds: mission · lifecycle · command · files · text · error · evidence. Command blocks get the tool-category accent and a `<details>` disclosure like Cave's tool blocks. Right-side steps timeline becomes the inspector's Steps tab. Show: empty ("Autonomous agents, bounded by infrastructure."), running with live activity, terminal with evidence.

### 5.3 Choose how to begin
Keep the three paths and their copy. Cards: 32px icon tile on `--bg-raised`, eyebrow, 20px serif title (identity moment, allowed), body, mono outcome line ("1 profile · ~5 seconds"), hairline card with `--lift` hover (translateY -1px, shadow-md). Remove the left decorative rule. Card height fits content. Cancel moves to the header's right slot as ghost.

### 5.4 Create a team and Create a skill
Centered panel `min(680px, 100% - 40px)` (team editor `min(900px…)`). Fields: eyebrow label over a `--bg-sunken` input with hairline, focus = accent 55% border. Member editor: numbered `01` mono, profile picker as a segmented-style select, responsibility textarea, skills as custom checkbox chips (14px box, sunken, accent check), "Required step" as a labeled switch. "Add member" is a dashed-hairline invitation row, not a button. Capability grid: two columns of chips in mono, with the note about GitHub Project capabilities as a muted line beneath. Primary disabled state = raised fill, faint text, no accent. Footer: Cancel ghost · Save skill / Create team primary.

## 6. Component sheet to deliver
Btn (xs 22 / sm 26 / md 32 / lg 38; primary · secondary · ghost · danger-ghost; with spinner), IconBtn 28, Pill (tint recipe, all four tones), LifecycleBadge (queued · running · needs approval · completed · failed · cancelled), OriginChip, ListRow (rail row with icon tile, name, meta, hover arrow), Avatar (22/28/36 with presence dot: available lavender · working amber · offline muted), Composer (rest · focus · warn), HeldActionCard (waiting · approved · declined · expired), ReasoningCard (collapsed · open · with failures), ThinkingRow, CommandBlock (per tool accent, collapsed · open), EmptyState, ErrorState, Skeleton (row · card · text), Segmented, Tabs (underline, Vercel-style), SearchPill, CommandPalette (with group column and kbd hints), UndoToast (bottom-center with ⌘Z), StatusStrip, RailToggle (rest · hover · closed).

## 7. Copy rules
Sentence case. Contractions allowed. Single `…` character. Buttons name the operation: never Submit, OK, Confirm. Lifecycle verbs stay constant: Start → Starting… → Started. Toggles name the next action. One flourish per surface; a form or error is never in character. Every empty state says what to do next. Every color dot has a word.

## 8. Accessibility and states
AA on every text/surface pair in §3. Focus ring `--ring-focus` 2px offset 2px on `:focus-visible` only; the composer and palette glow as a whole instead. Hover-reveal controls stay in the tab order and appear on `:focus-within`; on coarse pointers they are always visible. Every animation has a reduced-motion equivalent. Minimum interactive size 28px. Status uses `role="status"`; held approvals use `role="alert"` on arrival.

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
No light theme. No new hues. No fourth text tier. No second filled accent control on a surface. No pill-shaped primary buttons. No backdrop blur except popovers and modals. No `transform: scale`. No typewriter streaming. No decorative rules, scan lines, or CRT effects. No tables where a list of rows will do. No manual "Refresh" control anywhere; live state replaces it. No renaming of product nouns. No feature that needs a new API.
