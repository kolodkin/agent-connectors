---
name: session-review
description: Full review pass over the current branch — runs code-review, simplify, ponytail-review and shortify in order. Use when the user asks for "session-review" or a full review of their change.
---

# session-review

Run these skills in order on the current branch (`git diff origin/main...HEAD` plus uncommitted changes). Pass any arguments the user gave to each one.

1. `code-review`
2. `simplify`
3. `ponytail:ponytail-review`
4. `devpowers:shortify`

Apply each skill's fixes before the next. Report only at the end: what was fixed, and what was deferred and why.
