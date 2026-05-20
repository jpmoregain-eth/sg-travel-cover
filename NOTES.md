# Policy2Summary — Project Notes

> **Context preservation file.** If you're a new session agent, read this first before touching anything.

---

## What This Is

AI-powered insurance document summarizer. Two-tier:
- **Free**: Quick summary via `/api/analyze` (agnes-1.5-flash, 55s timeout)
- **Premium**: Executive PDF report via `/api/analyze-fallback` (agnes-1.5-pro, 25s per attempt, 4 retries with 10s backoff)
- **Endgame**: Multi-policy comparison via `/api/analyze-compare` (analyzes 2+ docs together, generates consolidated comparison PDF)

Domain: **policy2summary.com**
Repo: **jpmoregain-eth/policy2summary**

---

## Architecture

### Frontend (`pages/index.js`)
- Next.js pages router, static export (or Vercel serverless)
- React hooks: `useState`, `useCallback`, `useRef`
- PDF extraction: `pdfjs-dist` (dynamic import, worker from CDN)
- DOCX extraction: `mammoth` (dynamic import)
- PDF generation: `jspdf` + `jspdf-autotable` (dynamic import inside click handler — NEVER import at top level, crashes SSR)
- Error Boundary added to catch client-side React crashes and show "Reload App" UI
- Supports up to 5 documents simultaneously

### API Routes
| Route | Purpose | Model | Timeout |
|-------|---------|-------|---------|
| `/api/analyze` | Free quick summary | agnes-1.5-flash | 55s |
| `/api/analyze-fallback` | Premium executive PDF | agnes-1.5-pro | 25s per attempt |
| `/api/analyze-compare` | Multi-policy comparison | agnes-1.5-pro | 55s |

### Environment Variables (Vercel)
```
AGNES_API_KEY=<key>    # Required for all AI calls
KIMI_API_KEY=<key>     # Fallback provider (optional)
```
- **NEVER hardcode API keys in source** — GitHub push protection will block commits containing keys
- Kimi endpoint: `https://api.moonshot.ai/v1` (NOT apihub.agnes-ai.com)

---

## Known Issues & Fixes (Chronological)

### 1. jsPDF SSR Crash
**Symptom**: Vercel build fails or runtime crash when clicking Export PDF.
**Cause**: `import { jsPDF } from 'jspdf'` at top level triggers server-side rendering of browser-only library.
**Fix**: Dynamic import inside click handler:
```javascript
const { jsPDF } = await import('jspdf');
const autoTable = (await import('jspdf-autotable')).default;
```
**Commit**: `369654d`

### 2. Stray `</span>` JSX Syntax Error
**Symptom**: Build fails with "Unexpected token" near footer.
**Cause**: Incomplete edit left a stray closing span tag.
**Fix**: Removed stray tag.
**Commit**: `e81e8f5`

### 3. Duplicate `let pdfjsLib = null`
**Symptom**: Build fails with "Identifier 'pdfjsLib' has already been declared".
**Cause**: Two declarations at top of file.
**Fix**: Removed duplicate.
**Commit**: `df43fa3`

### 4. Hardcoded Kimi API Key
**Symptom**: Security risk + GitHub push protection blocks commits.
**Fix**: Removed hardcoded key, reads from env var.
**Commit**: `b79d338`

### 5. Wrong Kimi Endpoint
**Symptom**: Kimi fallback fails with connection error.
**Cause**: Used Agnes endpoint for Kimi.
**Fix**: Reverted to `https://api.moonshot.ai/v1`.
**Commit**: `01e05a6`

### 6. Timeout Too Short
**Symptom**: "Request timed out" on complex PDFs.
**Fix**: Increased timeouts to 55s for free analysis, 55s for PDF extraction.
**Commit**: `c778d02`

### 7. PDF Export Per-Attempt Timeout Too Short
**Symptom**: Executive PDF generation times out on first attempt.
**Fix**: Increased per-attempt timeout to 25s.
**Commit**: `3ba8980`

### 8. Free Summary Model Too Slow
**Symptom**: Free tier frequently times out (agnes-1.5-pro is heavy).
**Fix**: Switched free summary to `agnes-1.5-flash` (3x faster).
**Commit**: `5fee32b`

### 9. `generatePdfReport` Function Declaration Lost
**Symptom**: Build fails with "Expression expected" at line 483.
**Cause**: During multi-policy comparison edit, the function declaration was accidentally deleted, leaving orphaned code.
**Fix**: Restored `const generatePdfReport = async (doc, analysis) => {`.
**Commit**: `9ee3fa1`

### 10. Duplicate `runExecutiveAnalysis` Code Block
**Symptom**: Build fails with "await isn't allowed in non-async function" at lines 752, 764, 768, 778.
**Cause**: After fixing #9, a 140-line duplicate of `runExecutiveAnalysis` was left after `runComparison`'s closing brace — making it a regular function body containing `await`.
**Fix**: Removed the entire duplicate block.
**Commit**: `55482fe`

### 11. `arrayBuffer` Scoped Inside `try` Block
**Symptom**: Client-side crash (white/black screen) when uploading second PDF. Intermittent.
**Cause**: `const arrayBuffer = await selectedFile.arrayBuffer()` declared inside `try`, but `catch` block references `arrayBuffer` — `ReferenceError` on any exception after that line.
**Fix**: Moved declarations outside `try`:
```javascript
let arrayBuffer = null;
let clonedBuffer = null;
try {
  arrayBuffer = await selectedFile.arrayBuffer();
  clonedBuffer = arrayBuffer.slice(0);
```
**Commit**: `a267d6a`

### 12. Navbar Buttons Too Large on Mobile
**Symptom**: "Export PDF" and "Compare & Export" buttons overflow navbar on mobile.
**Fix**: Responsive sizing — smaller padding, shorter labels ("PDF" / "Compare"), smaller icons on mobile; full labels on desktop (`sm:` breakpoint).
**Commit**: `5f36aa2`

### 13. Intermittent Client-Side Crashes (Black Screen)
**Symptom**: "Application error: a client-side exception has occurred" — intermittent, no server error logs.
**Cause**: Likely null reference during render (e.g., `analysis.policy_type` when `analysis` is malformed).
**Fix**: Added React Error Boundary to catch crashes and show recoverable UI with "Reload App" button + console logging.
**Commit**: `a9483f3`

---

## Critical Code Patterns

### Never Do This (SSR Crash)
```javascript
// BAD — crashes on server
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
```

### Always Do This (Dynamic Import)
```javascript
// GOOD — only loads in browser when clicked
const generatePdfReport = async (doc, analysis) => {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const pdf = new jsPDF('p', 'mm', 'a4');
  // ... build PDF ...
  pdf.save(`policy2summary-report-${doc.file?.name?.replace(/\.[^/.]+$/, '') || 'document'}.pdf`);
};
```

### Variable Scope in try/catch
```javascript
// BAD — arrayBuffer undefined in catch
function processFile() {
  try {
    const arrayBuffer = await file.arrayBuffer(); // scoped to try
  } catch (err) {
    updateDoc(id, { pendingBuffer: arrayBuffer }); // ReferenceError!
  }
}

// GOOD — declare outside
try {
  let arrayBuffer = null;
  arrayBuffer = await file.arrayBuffer();
} catch (err) {
  updateDoc(id, { pendingBuffer: arrayBuffer }); // OK
}
```

---

## Feature: Multi-Policy Comparison

### Flow
1. User uploads and analyzes 2+ policies (free summary)
2. "Compare & Export" button appears (amber) in navbar when `analyzedCount >= 2`
3. Click → calls `/api/analyze-compare` with all extracted texts
4. Backend sends consolidated prompt to Agnes AI
5. Returns structured comparison object
6. Frontend calls `generateComparisonPdf()` to produce single PDF with:
   - Executive Summary
   - Financial Overview (total premium vs optimal)
   - Coverage Overlap Analysis (where user is wasting money)
   - Coverage Gap Analysis (what's missing)
   - Per-Policy Verdict (Keep / Review / Cancel)
   - Action Plan

### API Input
```json
{
  "documents": [
    { "name": "Policy A", "text": "..." },
    { "name": "Policy B", "text": "..." }
  ]
}
```

### API Output
```json
{
  "comparison": {
    "executive_summary": "...",
    "financial_overview": { "total_annual_premium": "...", "optimal_annual_premium": "...", "potential_savings": "..." },
    "coverage_overlap_analysis": "...",
    "coverage_gap_analysis": "...",
    "per_policy_verdict": [
      { "policy_name": "Policy A", "verdict": "Keep", "rationale": "..." }
    ],
    "action_plan": "..."
  }
}
```

---

## Vercel Deployment Notes

- **Plan**: Vercel Pro (60s serverless timeout)
- **Build command**: `npm run build` (Next.js)
- **Output**: Static + serverless API routes
- **Cache**: May serve stale JS bundles — if Derek sees old errors after deploy, tell him to **hard refresh** (Ctrl+Shift+R on desktop, or clear app data on mobile Chrome)
- **Logs**: Function logs show only server-side errors. Client-side crashes appear in browser console only (unless Error Boundary catches them).

---

## Common User Issues

| User Report | Likely Cause | Fix |
|-------------|--------------|-----|
| "Export PDF greyed out" | Stale JS bundle | Hard refresh browser |
| "Request timed out" | Free tier slow on complex docs | Normal — flash model is fast but complex PDFs still take time |
| "Application error" after upload | `arrayBuffer` scope bug (fixed) or null render | Reload app; check console |
| "Black screen" | React crash | Error Boundary now shows "Reload App" button |

---

## Model Assignment Rules

| Feature | Model | Why |
|---------|-------|-----|
| Free summary | `agnes-1.5-flash` | Fast, cheap, good enough for basic extraction |
| Executive PDF | `agnes-1.5-pro` | Higher quality, deeper analysis for paid tier |
| Comparison | `agnes-1.5-pro` | Complex multi-doc reasoning needs pro |
| Fallback | `kimi` (moonshot) | Backup when Agnes is rate-limited |

---

## Files to Know

| File | Purpose |
|------|---------|
| `pages/index.js` | Main UI — 2000+ lines, be careful with large edits |
| `pages/api/analyze.js` | Free summary endpoint |
| `pages/api/analyze-fallback.js` | Premium executive endpoint |
| `pages/api/analyze-compare.js` | Multi-policy comparison endpoint |
| `public/googlef0b1253b37cd8c20.html` | Google Search Console verification |

---

## If You're Starting a New Session

1. **Read this file first** (you're doing it now — good)
2. **Check git log**: `git log --oneline -10` to see recent changes
3. **Build locally before pushing**: `npx next build` — catches syntax errors before Vercel
4. **Always backup before big edits**: `git diff` to see what changed
5. **For large refactors**: Consider spawning a subagent instead of editing 2000-line file inline
6. **Derek wants**: Terse replies, no fluff, Singlish, 1-3 sentences max

---

## Derek's Preferences

- **Communication**: Terse, Singlish, 1-3 sentences max
- **Wants to be notified**: After CanYouHearMe 08:30 SGT cron runs
- **Does NOT want**: Long explanations, backend details, fluff, sign-offs
- **Ask before**: External actions (email, post, anything leaving the machine)
- **Skeptical of**: AI safety scare stories, enterprise marketing BS

---

*Last updated: 2026-05-19 by GoldmanSax*

## Contact
- **Email:** thejpmoregainproject@gmail.com
- **Added to footer:** 2026-05-20
