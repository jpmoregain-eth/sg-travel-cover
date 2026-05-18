export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text } = req.body;
    
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Insufficient text extracted. Please upload a clearer document.' });
    }

    const API_KEY = process.env.AGNES_API_KEY || '';
    if (!API_KEY) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    const systemPrompt = `You are an insurance document analyzer that produces a Policy Summary following the industry-standard Insuranceopedia format. Extract key information from the provided insurance certificate/policy text and return ONLY a JSON object with this exact structure:

{
  "policy_type": "Life / Health / Car / Home / Travel / Investment-Linked / Other",
  "insurer": "Company name",
  "policy_number": "Policy number if found",
  "policyholder": "Name of insured person",
  "premium": {
    "amount": "amount with currency",
    "frequency": "Monthly / Quarterly / Annual / One-time",
    "total_annual": "calculated annual amount if available",
    "currency": "Currency code or symbol"
  },
  "coverage_details": {
    "description": "A plain-English paragraph describing what this policy covers (2-3 sentences)",
    "main_coverage": ["List each major coverage item with specific dollar amounts — e.g., 'Medical expenses: S$50,000', 'Trip cancellation: S$5,000', 'Third-party liability: S$500,000'"],
    "limits": ["List coverage limits and sub-limits found"],
    "riders_add_ons": ["Any add-on coverage purchased with amounts"],
    "total_coverage_value": "Sum total of coverage amounts if stated"
  },
  "exclusions_and_limitations": {
    "exclusions": ["List what's NOT covered — be specific with conditions"],
    "limitations": ["Limitations on coverage — e.g., territorial limits, age limits, pre-existing condition clauses"],
    "waiting_periods": ["Any waiting periods before coverage takes effect"],
    "special_conditions": ["Conditions that must be met for coverage to apply"]
  },
  "terms_and_conditions": {
    "policy_term": "Duration of coverage (e.g., '1 year renewable', 'Whole life', 'Term 20 years')",
    "renewal_terms": "How renewal works, premium changes, notice periods",
    "cancellation_terms": "Cancellation rights, refunds, notice requirements",
    "claims_process": "How to file a claim — documentation needed, time limits, contact info",
    "grace_period": "Grace period for premium payment if mentioned",
    "jurisdiction": "Governing law / jurisdiction if stated"
  },
  "key_dates": {
    "issue_date": "",
    "commencement_date": "",
    "expiry_date": "",
    "renewal_date": ""
  },
  "warnings_and_gaps": ["Any important warnings, coverage gaps, unusual exclusions, or gotchas"],
  "summary": "A 2-3 sentence plain-English summary of what this policy does, who it's for, and the total protection offered"
}

IMPORTANT EXTRACTION RULES:
1. ALWAYS extract specific dollar amounts (S$ / $ / USD / €) for every coverage item found
2. ALWAYS extract exclusions with specific conditions — not just generic categories
3. ALWAYS extract waiting periods, renewal terms, and cancellation rights
4. ALWAYS describe the claims process if mentioned in the document
5. For travel insurance: extract medical, trip cancellation, baggage, delay, personal accident amounts
6. For life/health: extract sum assured, critical illness payout, waiting periods, pre-existing exclusions
7. For car insurance: extract third-party liability, own damage, excess, unnamed driver, NCD
8. For home insurance: extract building contents, valuables sub-limits, liability coverage
9. NEVER leave coverage amounts as generic text — always include the dollar figure if present
10. If a field is genuinely not in the document, set it to null or an empty array
11. Return ONLY valid JSON — no markdown code blocks, no explanations outside the JSON`;

    // Timeout: 8 seconds to stay under Vercel free tier 10s limit
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'agnes-1.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this insurance document text and return JSON only:\n\n${text.substring(0, 12000)}` }
        ],
        temperature: 0.1,
        max_tokens: 2000
      })
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(502).json({ error: 'AI analysis failed. Please try again.' });
    }

    const data = await response.json();
    const aiContent = data.choices?.[0]?.message?.content || '';
    
    // Extract JSON from response (AI might wrap in markdown)
    let jsonStr = aiContent;
    const jsonMatch = aiContent.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    
    let analysis;
    try {
      analysis = JSON.parse(jsonStr);
    } catch {
      return res.status(200).json({ 
        raw_response: aiContent,
        error: 'Could not parse structured data. Showing raw analysis instead.'
      });
    }

    return res.status(200).json({ analysis });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ 
        error: 'AI analysis timed out. The document may be too large or the service is slow. Try pasting a smaller excerpt manually.' 
      });
    }
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
