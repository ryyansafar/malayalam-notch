You are continuing work in a small Node.js (>= 20, ES modules, zero runtime dependencies) project. An earlier Devin session was interrupted after writing two files. Read CONTRACT.md first (section "shared/stroke.js"), then read these two existing files completely:
- shared/stroke.js
- test/stroke.test.js

YOUR TASK (only this; touch no other files):
1. Run `node --test test/stroke.test.js`.
2. If any test fails, fix shared/stroke.js (preferred) or, only where the test expectation is genuinely unreachable, tune the tolerance honestly and add a comment in the test file explaining the limit instead of hiding it. Iterate until every test passes.
3. Check the requirements in CONTRACT.md still hold: no imports, no DOM or Node-only APIs, pure and deterministic (no Date.now, no randomness, no global state), `createStrokeDetector(opts)` with push/reset, `detectStrokes(samples, opts)` equal to feeding push() sample by sample, defaults minSpm 10, maxSpm 90, smoothingHz 3, adaptive true, every threshold documented in a comment.
4. When all tests pass, run `git add shared/stroke.js test/stroke.test.js` and make exactly one commit of those two files with a message starting "feat(stroke): ". Do not run any other git command, do not push, do not install packages, do not use the network.

When finished, reply with a short factual summary: what the algorithm does in 5 lines, the number of tests passing, and the measured accuracy limits (for example the sampling rates and tempos where rateSpm error exceeds 2 spm).
