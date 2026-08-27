---
name: pdf-deep-study
description: Summarize giant PDFs (100+ pages) page by page and chapter by chapter into a study workspace, then help the user LEARN the content with active recall quizzes, spaced repetition flashcards, Feynman checkpoints, and interleaved review. Use when user asks to "summarize this PDF", "study this book", "help me learn this PDF", "deep study", "resume a study session", or "review" a previously studied book.
metadata:
  author: Jibaru
  version: 1.0.0
---

# PDF Deep Study

Turn a giant PDF into durable knowledge. Two goals, in order:

1. **Summarize** the PDF page by page, chapter by chapter, then synthesize the most important ideas.
2. **Make it stick** using evidence-based learning: active recall, spaced repetition, elaborative interrogation, the Feynman technique, and interleaving. See `references/learning-techniques.md` for the rules that govern every quiz and note you produce.

The core belief: passively reading summaries builds *fluency* (illusory mastery), not *storage strength* (long-term retention). This skill forces effortful retrieval at every chapter boundary.

## Modes

Detect the mode from the user's request:

- **Study mode** (default): full page-by-page pass with interactive quiz checkpoints.
- **Auto mode** ("summarize only", "no quizzes"): generate all artifacts without pausing; flashcards and quizzes are still written for later use.
- **Resume mode**: the workspace already exists. Read `PROGRESS.md` first and continue exactly where it stopped.
- **Review mode** ("review <book>"): no summarizing; run spaced-repetition review on whatever is due (see Phase 4).

**Language**: mirror the PDF's language for all notes, summaries, quizzes, and flashcards, unless the user asks for a specific language.

## Workspace

All artifacts live in `study/<book-name>/` (kebab-case book name):

```
study/<book-name>/
├── OVERVIEW.md               Structure map: chapters, page ranges, reading plan
├── PROGRESS.md               State: last page done, checkpoints, review due-dates
├── chapters/NN-chapter-name/
│   ├── page-notes.md         One "## Page N" section per page
│   └── summary.md            Chapter summary distilled from page notes
├── SUMMARY.md                Master synthesis of the whole book
├── flashcards.md             Human-readable Q/A cards, grouped by chapter
├── flashcards.tsv            Anki import: front<TAB>back<TAB>tags
├── glossary.md               Terms and definitions, alphabetized
├── quiz-log.md               Every quiz: questions, answers, score, weak spots
└── assets/                   Images extracted from the PDF
```

Exact file formats and templates: `references/workspace-format.md`.

## Phase 1: Setup

1. Locate the PDF. Install the script dependency if needed: `pip install pypdf`.
2. Run `python scripts/split_pdf.py info <pdf>` to get page count and the table of contents (bookmark outline).
3. If the outline is missing or useless, read the first ~10 pages of the PDF to find the printed table of contents and build the chapter map manually.
4. Create the workspace. Write `OVERVIEW.md` (chapter list with page ranges) and `PROGRESS.md`.
5. Confirm the chapter map with the user before starting the long pass.

## Phase 2: Page-by-page pass

Process **exactly one page at a time**. The user chose thoroughness over cost deliberately — do not batch pages to save effort.

For each page:

1. Read the page. Prefer the Read tool directly on the PDF (visual fidelity for figures, tables, formulas); use `split_pdf.py extract-text` as a fallback or cross-check for dense text.
2. Append a `## Page N` section to the current chapter's `page-notes.md` containing:
   - Key ideas (bullets, compressed, no filler)
   - New terms → also add them to `glossary.md`
   - **Why-notes** (elaborative interrogation): for each non-obvious claim, one line answering "why is this true / why does this work?"
   - **Diagrams**: when the page describes structure, flow, hierarchy, or causality, draw it as a Mermaid diagram in the notes instead of describing it in prose.
   - **Images**: when a figure on the page matters, extract it with `python scripts/split_pdf.py extract-images <pdf> --start N --end N --out study/<book>/assets/` and embed it: `![caption](../../assets/pNN-01.png)`.
3. Update `PROGRESS.md` (`last_page_done`) every few pages so any interruption is resumable.

Skip genuinely contentless pages (blank, pure front-matter) with a one-line note saying so.

## Phase 3: Chapter checkpoint

When the last page of a chapter is done:

### 3a. Quiz (before showing the summary)

Active recall works only if retrieval happens **before** re-exposure. Quiz first, summarize after.

Ask exactly 4 questions drawn from the chapter's page notes:

- 2 multiple-choice — all options must have the **same word count** so formatting leaks no clues
- 1 open-ended recall
- 1 elaborative "why is this true / why does this work?"

Also re-ask any flashcards marked weak at previous checkpoints.

Grade it. **Pass threshold: 75%.** Log everything in `quiz-log.md`. Every missed question becomes a flashcard tagged `weak` and is re-asked at the next checkpoint. Below threshold: point the user to the exact pages to re-read, then re-quiz the missed material with fresh questions.

### 3b. Feynman checkpoint

Ask the user to explain the chapter's single most important concept in their own words, as if teaching a beginner. Compare their explanation against the page notes and report the gaps precisely: what was missing, what was wrong, what was vague. Gaps become flashcards.

### 3c. Produce artifacts

1. Write `chapters/NN-name/summary.md`: the chapter distilled from page notes — key ideas, how they connect (Mermaid diagram when structural), important images from `assets/`, and page references for everything.
2. Append 5–10 flashcards to `flashcards.md` and `flashcards.tsv`. TSV format: `front<TAB>back<TAB><book-name> chapter-NN`.
3. Update `PROGRESS.md`: mark the chapter done and schedule its reviews at **+1, +3, +7, +14, and +30 days** from today.

In auto mode, skip 3a and 3b, produce 3c.

## Phase 4: Final synthesis and review

**When all chapters are done:**

1. Write `SUMMARY.md`: the most important ideas of the whole book, how the chapters build on each other (Mermaid overview diagram), and the 10–20 things worth remembering forever. Every claim cites chapter and page.
2. Run a **final interleaved quiz**: 8–10 questions mixing all chapters in shuffled order, biased toward `weak`-tagged cards. Interleaving is deliberately harder than chapter-by-chapter quizzing — that difficulty is the point.
3. Tell the user to import `flashcards.tsv` into Anki (File → Import, tab-separated) for daily card review.

**Review mode** (any later session): read `PROGRESS.md`, find chapters whose review date is due, and run an interleaved quiz across all due chapters (4 questions per due chapter, shuffled, weak cards first). Log results, reschedule each reviewed chapter to its next interval, and demote missed items back to the `weak` tag.

## Examples

**"Summarize designing-data-intensive-applications.pdf and help me learn it"**
→ Study mode. Setup, confirm chapter map, page-by-page pass with quiz checkpoints at each chapter, final synthesis.

**"Continue studying the DDIA book"**
→ Resume mode. Read `study/designing-data-intensive-applications/PROGRESS.md`, continue from `last_page_done + 1`.

**"Review DDIA"**
→ Review mode. Quiz due chapters interleaved, reschedule.

**"Just summarize this PDF, I'll study later"**
→ Auto mode. All artifacts, no interactive pauses.

## Troubleshooting

- **`pypdf` missing**: `pip install pypdf`. If pip is unavailable, fall back to the Read tool for everything and skip image extraction.
- **No outline and no readable TOC**: propose synthetic "chapters" of ~20 pages at natural section breaks and confirm with the user.
- **Scanned/image-only PDF**: text extraction returns nothing — rely on the Read tool (visual) for all pages and note this in `OVERVIEW.md`.
- **Context filling up mid-pass**: page notes on disk are the source of truth. Never keep the whole book in context; before a checkpoint, re-read only that chapter's `page-notes.md`.
