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

    const systemPrompt = `You are an insurance document analyzer. Extract key information from the provided insurance certificate/policy text and return ONLY a JSON object with this exact structure:

{
  "policy_type": "Life / Health / Car / Home / Travel / Investment-Linked / Other",
  "insurer": "Company name",
  "policy_number": "Policy number if found",
  "policyholder": "Name of insured person",
  "premium": {
    "amount": "amount with currency",
    "frequency": "Monthly / Quarterly / Annual",
    "total_annual": "calculated annual amount if available"
  },
  "coverage": {
    "medical_expenses": "Overseas medical coverage amount with currency",
    "trip_cancellation": "Trip cancellation/interruption coverage amount",
    "baggage_loss": "Baggage/personal belongings coverage amount",
    "personal_accident": "Personal accident / death coverage amount",
    "travel_delay": "Travel delay coverage amount and threshold (e.g., after X hours)",
    "main_benefits": ["All other coverage items with specific amounts/limits"],
    "riders": ["Add-on coverage with amounts"]
  },
  "payout_criteria": ["Specific conditions that trigger payouts — e.g., 'Medical expenses: S$50,000, covers hospitalisation and emergency dental'", "Trip cancellation: S$5,000, covers non-refundable deposits if cancelled for covered reasons"],
  "deductibles_excess": ["Any excess/deductible amounts per claim type"],
  "exclusions": ["List what's NOT covered"],
  "maturity": {
    "type": "Whole Life / Term / Endowment / ILP / Other",
    "term_years": "Policy term if applicable",
    "maturity_date": "Date or age at maturity",
    "surrender_value_notes": "Any surrender/early withdrawal terms"
  },
  "investment_linked": {
    "is_ilp": true/false,
    "allocation": "How premium is split (e.g., 70% insurance, 30% investment)",
    "funds": ["Names of underlying funds if mentioned"],
    "projected_returns": "Any projected return rates"
  },
  "key_dates": {
    "issue_date": "",
    "commencement_date": "",
    "maturity_date": "",
    "renewal_date": ""
  },
  "warnings": ["Any important warnings, gaps, or unusual exclusions"],
  "summary": "A 2-3 sentence plain-English summary of what this policy does, who it's for, and the total coverage value"
}

IMPORTANT EXTRACTION RULES:
1. ALWAYS extract specific dollar amounts (S$ / $ / USD) for every coverage item found
2. ALWAYS extract payout criteria — what triggers a claim and how much is paid
3. ALWAYS extract deductibles/excess amounts per claim type
4. For travel insurance specifically: extract medical, trip cancellation, baggage, delay, personal accident amounts
5. For life/health: extract sum assured, critical illness payout amounts, waiting periods
6. For car insurance: extract third-party liability limits, own damage coverage, excess amounts
7. For home insurance: extract building contents limit, valuables sub-limits, liability coverage
8. NEVER leave coverage amounts as generic text — always include the dollar figure if present
9. If a field is genuinely not in the document, set it to null
10. Return ONLY valid JSON — no markdown code blocks, no explanations outside the JSON`;

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
