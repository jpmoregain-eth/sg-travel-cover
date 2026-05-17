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
    "main_benefits": ["List of main coverage items with amounts"],
    "riders": ["Any add-on coverage"]
  },
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
  "warnings": ["Any important warnings or gaps detected"],
  "summary": "A 2-3 sentence plain-English summary of what this policy does and who it's for"
}

If any field is not found in the text, set it to null or empty array. Be thorough but accurate — only extract what's actually in the document.`;

    const response = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'agnes-1.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this insurance document text and return JSON only:\n\n${text.substring(0, 15000)}` }
        ],
        temperature: 0.1,
        max_tokens: 4000
      })
    });

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
      // If JSON parse fails, return raw text for debugging
      return res.status(200).json({ 
        raw_response: aiContent,
        error: 'Could not parse structured data. Showing raw analysis instead.'
      });
    }

    return res.status(200).json({ analysis });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
