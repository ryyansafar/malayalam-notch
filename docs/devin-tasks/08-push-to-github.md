You are working in the git repository at the current directory (a small Node.js project called rowing-call, branch main, no remote yet). The GitHub CLI `gh` is already logged in as the repository owner.

YOUR TASK, in this order, stopping and reporting at any failed check:

1. PRE-PUSH SAFETY CHECKS (read-only):
   a. Run `git status --short` and `git log --oneline`. Report what is uncommitted. Do NOT stage or commit anything in this task.
   b. Confirm `.env` is not tracked (`git ls-files | grep -E '(^|/)\.env$'` must print nothing) and is listed in .gitignore.
   c. Search all tracked files AND the full git history for secrets: look for long API-key-like strings (for example `sk_` followed by 16+ characters, `Bearer` followed by a long token, `api_key`/`api-subscription-key` assignments with a long literal value). Also read each non-empty value from the local .env file that is longer than 15 characters into a shell variable and use `git grep -F` against all revisions (`git rev-list --all`), printing only file names and counts, NEVER the value. If anything matches, STOP and report the file and commit; do not push.
   d. Check that no tracked file is larger than 5 MB and that sarvam/cache (if tracked) holds only API response files with no key material.

2. CREATE AND PUSH: only if every check passed, run
   `gh repo create ryyansafar/rowing-call --private --source=. --remote=origin --description "Translated rowing-call trainer: a shouted Malayalam call, translated live, obeyed by a phone used as an oar"`
   then `git push -u origin main`. The repository MUST be private. Do not force-push. Push no other branch. If the repo already exists, report that and overwrite nothing.

3. VERIFY: run `gh repo view ryyansafar/rowing-call --json visibility,url,defaultBranchRef` and `git log origin/main --oneline`, then report the URL, visibility and commit count.

Rules: do not modify, stage or commit any file; do not rewrite history; never print any secret value; do not install packages. Reply with a short factual summary: the checks and their results, the repo URL, visibility, and the number of commits pushed.
