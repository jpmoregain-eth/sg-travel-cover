# InsurEase

**AI Insurance Document Reader** — Upload your insurance certificate, get an instant plain-English summary.

No signup. No data stored. Free tool.

## What It Does

1. **Upload** your insurance policy (PDF or text)
2. **AI reads** the fine print and extracts key details
3. **Get a summary** of:
   - What you're covered for
   - What's NOT covered (exclusions)
   - Premium amount and frequency
   - Key dates (issue, maturity, renewal)
   - Investment-linked policy details (if applicable)
   - Important warnings

## Tech Stack

- **Frontend:** Next.js + Tailwind CSS
- **PDF Parsing:** pdfjs-dist (client-side)
- **AI Analysis:** Agnes AI API (server-side API route)
- **Privacy:** Documents processed in memory only — nothing stored

## Local Development

```bash
npm install
echo "AGNES_API_KEY=your_key_here" > .env.local
npm run dev
```

Open http://localhost:3000

## Deployment

Deploy to Vercel:
1. Push repo to GitHub
2. Import to Vercel
3. Add `AGNES_API_KEY` environment variable in Vercel dashboard

## Notes

- Supports text-based PDFs and text files
- Scanned/image PDFs may need OCR (not yet supported)
- For scanned docs, paste extracted text into the manual input field

## Disclaimer

AI-generated summaries for reference only. Always verify details with your insurer. Not financial advice.
