# Turn on triage backup/sync (one-time, ~3 minutes)

Your triage — Archive, Important + stars, and project tags — is saved on your phone, and
(once you do this) **backed up to your private GitHub** on the `triage-state` branch of the
`ncbi-feed` repo. That makes it survive cache-clears and iOS storage eviction, and sync across
devices. Your reading data (articles/abstracts) is unaffected; this is only your triage.

## Steps
1. **Make a GitHub token** (fine-grained):
   <https://github.com/settings/tokens?type=beta> → **Generate new token**
   - **Repository access:** Only select repositories → **`ncbi-feed`**
   - **Permissions → Repository permissions → Contents: Read and write**
   - Generate, then **copy** it (starts with `github_pat_…`).
   *(You can reuse the token already in your Mac's `secrets.env`, but a separate one is cleaner —
   it can be revoked on its own if your phone is ever lost.)*
2. **In the app:** tap the **⚙** button (top-right) → paste the token → **Save & sync**.
   The status should read **Synced ✓**.
3. **On any other device:** open the same app URL, ⚙, paste the same token, Save. Done.

## How it works / good to know
- The token lives **only in your phone's browser storage** — never in the public app code.
- Sync is automatic: it pulls on open and when you return to the app, and pushes a couple of
  seconds after each swipe/tag. If you're offline or the token is unset, the app works normally
  and syncs later — it never blocks you.
- **Recovery after a wipe:** if your phone ever loses its local data, just reopen the app, ⚙,
  paste the token → your triage is pulled back from GitHub.
- **Extra insurance:** ⚙ → **Export JSON** saves a backup file you control; **Import JSON**
  merges one back in.
- It uses a separate `triage-state` branch, so it never touches the live site or the daily
  article updates.
