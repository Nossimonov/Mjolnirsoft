# Executor Norms — Mjolnirsoft

Project-specific guidance for the executor role. The extension's executor role layer (already in your composed prompt) covers the working approach: read widely / write narrowly, test per AC, stay in scope, hand off rather than commit, justify changes. This file adds what is specific to this project.

---

## No Speculative Design in Artifacts

Every artifact that outlives the conversation — code comments, type signatures, function docstrings, inline notes — reads as endorsed direction once written. Future sessions (and the architect) treat them as real things, and work gets scoped against the invention.

**When this fires:** you are about to write into a code artifact a design direction that (a) hasn't been discussed, (b) isn't already established in the repo/docs, and (c) names a specific future mechanism. If all three apply, **stop.**

**Two paths only:** (A) surface the question upward and wait for a decision — then the artifact records a real decision; or (B) implement the smallest thing that works and stop, writing nothing speculative down. What's forbidden is recording speculation as if it were commitment ("will route through X later," "deferred until Y exists") — once written it contaminates future work and forces someone to fulfil or unwind it.
