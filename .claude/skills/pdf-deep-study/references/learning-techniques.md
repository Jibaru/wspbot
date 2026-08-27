# Learning Techniques Reference

The evidence base and the rules derived from it. Every quiz, note, and schedule this skill produces must follow these rules.

## Evidence base

Dunlosky et al. (2013), "Improving Students' Learning With Effective Learning Techniques" (Psychological Science in the Public Interest), rated ten techniques by utility:

| Technique | Utility | Used here as |
|---|---|---|
| Practice testing (retrieval practice) | **High** | Chapter quizzes, review mode, flashcards |
| Distributed practice (spacing) | **High** | 1/3/7/14/30-day review schedule, Anki export |
| Elaborative interrogation ("why?") | Moderate | Why-notes on every page, 1 "why" question per quiz |
| Self-explanation | Moderate | Feynman checkpoint per chapter |
| Interleaved practice | Moderate | Final quiz and review mode mix chapters |
| Summarization (by the learner) | Low | Not relied on alone — always paired with retrieval |
| Highlighting / rereading | Low | Avoided; rereading only as remediation after a failed quiz |

Supporting concepts:

- **Testing effect** (Roediger & Karpicke, 2006): retrieving information strengthens memory far more than re-reading it. This is why quizzes come **before** showing the chapter summary.
- **Fluency vs storage strength** (Bjork): recognizing material feels like knowing it, but recognition is fluency. Storage strength — the real goal — is built only by effortful retrieval. Never let the user self-assess by re-reading.
- **Desirable difficulty** (Bjork): for knowledge *acquisition*, difficulty is the enemy (keep notes clear, small, well-diagrammed). For knowledge *retention*, difficulty is the tool (spacing, interleaving, free recall).
- **Dual coding** (Paivio): verbal + visual representations of the same idea create two retrieval routes. This is why summaries include Mermaid diagrams and extracted figures, not prose only.

## Rules for quiz construction

1. Quiz **before** re-exposure. Never show the chapter summary until the checkpoint quiz is done.
2. Multiple-choice options must all have the **same word count**. Formatting must leak no clues (no "all of the above", no odd-one-out lengths).
3. Distractors must be plausible — ideally real concepts from the same chapter, misapplied.
4. One question per quiz must be elaborative: "why is this true?", "why does this design work?", "what would break if X were removed?"
5. Open-ended recall questions ask for production, not recognition: "explain", "list", "walk through" — never "which of these".
6. Grade honestly. Partial credit is fine, but vague answers are wrong answers. Report exactly what was missing.
7. Every miss becomes a flashcard tagged `weak`, re-asked at the next checkpoint until answered correctly twice in a row, then the tag is removed.

## Rules for the Feynman checkpoint

1. Ask for an explanation "as if teaching a beginner" — jargon must be unpacked.
2. Compare against the page notes, not memory. Report gaps in three buckets: **missing**, **wrong**, **vague**.
3. Each gap becomes a flashcard.
4. If the explanation is solid, say so briefly and move on. Do not pad with praise.

## Rules for spacing and interleaving

1. Chapter review schedule: due at **+1, +3, +7, +14, +30 days** after completion. Stored in `PROGRESS.md`.
2. A successful review advances the chapter to its next interval. A failed review (below 75%) resets it to +1 day.
3. Review-mode quizzes interleave all due chapters in shuffled order — never block by chapter.
4. Weak-tagged cards always come first in any review.

## Rules for notes and summaries (acquisition side)

1. Compress ruthlessly. Bullets over prose. No filler, no restating the obvious.
2. Every claim carries a page reference so it can be verified.
3. Prefer a Mermaid diagram whenever the content is structural, causal, hierarchical, or a process flow.
4. New terms go to the glossary immediately, defined in one or two lines.
5. Chapter summaries are distilled from page notes, not re-read from the PDF — the notes are the source of truth.
