# Xuka Công Nợ — Claude Context

## Server / Deploy

| Key | Value |
|---|---|
| Server | `vmadmin@vps-pro3` |
| Deploy path | `/opt/dashboard-bot/data/bots/f4966e2d7c30ecb2` |
| Deploy trigger | Push to `main` → GitHub Actions (`deploy.yml`) rsync file lên server |

### Deploy thủ công
```bash
# Từ máy local sau khi SSH vào server:
rsync -vz --inplace index.html vmadmin@vps-pro3:/opt/dashboard-bot/data/bots/f4966e2d7c30ecb2/index.html
```

## Repo

- **GitHub**: `ngalinh/Xuka-Cong-No`
- **Main branch**: `main`

## Workflow

- **Auto merge**: Sau khi push xong, tự merge PR vào `main` luôn, không cần hỏi
- **Auto deploy**: Merge vào `main` → GitHub Actions tự rsync lên server (không cần làm gì thêm)

## App

- **Một file duy nhất**: `index.html` — tự detect thiết bị và hiển thị đúng UI
  - Desktop (>768px / non-touch): desktop SPA quản lý công nợ CK 3 bên
  - Mobile (≤768px hoặc touch+≤900px): mobile SPA với 7 màn hình, drawer navigation
- `mobile.html` — file gốc, giữ lại làm reference (không deploy riêng)
- localStorage key: `xuka_cn_v1` (ver 8), `xuka_users`, `xuka_mapping`
- Data model: `D = {sup:[], kh:[], ck:[], partners:[], khChars:[], ctr:1}`

# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
