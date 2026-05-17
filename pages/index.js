import React, { useState, useCallback, useRef } from 'react';
import Head from 'next/head';

let pdfjsLib = null;

const loadPdfJs = async () => {
  if (pdfjsLib) return pdfjsLib;
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  pdfjsLib = pdfjs;
  return pdfjs;
};

export default function Home() {
  const [file, setFile] = useState(null);
  const [extractedText, setExtractedText] = useState('');
  const [manualText, setManualText] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pdfPassword, setPdfPassword] = useState('');
  const [pendingFile, setPendingFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const extractTextFromPdf = async (arrayBuffer, password = null) => {
    const pdfjs = await loadPdfJs();
    let pdf;
    const options = { data: arrayBuffer };
    if (password) options.password = password;
    try {
      pdf = await pdfjs.getDocument(options).promise;
    } catch (e) {
      const msg = String(e);
      if (msg.includes('password') || msg.includes('Password') || e.name === 'PasswordException') {
        if (!password) {
          setNeedsPassword(true);
          setPendingFile({ arrayBuffer, name: file?.name || 'document.pdf' });
          setLoading(false);
          throw new Error('PASSWORD_REQUIRED');
        }
        throw new Error('Incorrect password. Please try again.');
      }
      throw new Error('Could not read this PDF. It may be a scanned image file. Try pasting text manually.');
    }
    let fullText = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + '\n\n';
    }
    return fullText.trim();
  };

  const analyzeText = async (text) => {
    if (!text || text.length < 50) {
      setError('Not enough text to analyze. Please provide more content.');
      return;
    }
    setLoading(true);
    setError('');
    setAnalysis(null);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      const data = await res.json();
      
      if (data.error && !data.raw_response) {
        setError(data.error);
      } else if (data.raw_response) {
        setError(data.error || 'Showing raw analysis');
        setAnalysis({ raw: data.raw_response });
      } else {
        setAnalysis(data.analysis);
      }
    } catch (err) {
      setError(err.message || 'Failed to analyze text');
    } finally {
      setLoading(false);
    }
  };

  const exportToXlsx = () => {
    if (!analysis || analysis.raw) return;
    const rows = [];
    rows.push(['Field', 'Value']);
    rows.push(['Policy Type', analysis.policy_type || '']);
    rows.push(['Insurer', analysis.insurer || '']);
    rows.push(['Policy Number', analysis.policy_number || '']);
    rows.push(['Policyholder', analysis.policyholder || '']);
    if (analysis.premium) {
      rows.push(['Premium Amount', analysis.premium.amount || '']);
      rows.push(['Premium Frequency', analysis.premium.frequency || '']);
      rows.push(['Annual Total', analysis.premium.total_annual || '']);
    }
    if (analysis.key_dates) {
      rows.push(['Issue Date', analysis.key_dates.issue_date || '']);
      rows.push(['Commencement Date', analysis.key_dates.commencement_date || '']);
      rows.push(['Maturity Date', analysis.key_dates.maturity_date || '']);
      rows.push(['Renewal Date', analysis.key_dates.renewal_date || '']);
    }
    if (analysis.maturity) {
      rows.push(['Maturity Type', analysis.maturity.type || '']);
      rows.push(['Term (Years)', analysis.maturity.term_years || '']);
      rows.push(['Surrender Notes', analysis.maturity.surrender_value_notes || '']);
    }
    if (analysis.coverage?.main_benefits?.length) {
      rows.push(['', '']);
      rows.push(['Coverage - Main Benefits', '']);
      analysis.coverage.main_benefits.forEach(b => rows.push(['', b]));
    }
    if (analysis.coverage?.riders?.length) {
      rows.push(['', '']);
      rows.push(['Riders / Add-ons', '']);
      analysis.coverage.riders.forEach(r => rows.push(['', r]));
    }
    if (analysis.exclusions?.length) {
      rows.push(['', '']);
      rows.push(['Exclusions', '']);
      analysis.exclusions.forEach(e => rows.push(['', e]));
    }
    if (analysis.investment_linked?.is_ilp) {
      rows.push(['', '']);
      rows.push(['Investment-Linked Policy', '']);
      rows.push(['Allocation', analysis.investment_linked.allocation || '']);
      rows.push(['Projected Returns', analysis.investment_linked.projected_returns || '']);
      if (analysis.investment_linked.funds?.length) {
        rows.push(['Underlying Funds', analysis.investment_linked.funds.join(', ')]);
      }
    }
    if (analysis.warnings?.length) {
      rows.push(['', '']);
      rows.push(['Warnings / Notes', '']);
      analysis.warnings.forEach(w => rows.push(['', w]));
    }
    rows.push(['', '']);
    rows.push(['Summary', analysis.summary || '']);

    let csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'insurance-analysis.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePasswordSubmit = async () => {
    if (!pdfPassword || !pendingFile) return;
    setNeedsPassword(false);
    setLoading(true);
    setError('');
    try {
      const text = await extractTextFromPdf(pendingFile.arrayBuffer, pdfPassword);
      if (text.length < 100) {
        setError('Could not extract enough text from this document. It may be a scanned image PDF. Try uploading a text-based PDF or paste text manually below.');
        setLoading(false);
        return;
      }
      setExtractedText(text.substring(0, 5000));
      await analyzeText(text);
    } catch (err) {
      if (err.message !== 'PASSWORD_REQUIRED') {
        setError(err.message || 'Failed to process document');
        setLoading(false);
      }
    }
  };

  const processFile = async (selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    setError('');
    setAnalysis(null);
    setNeedsPassword(false);
    setPdfPassword('');
    setPendingFile(null);
    setLoading(true);

    try {
      let text = '';
      const arrayBuffer = await selectedFile.arrayBuffer();

      if (selectedFile.type === 'application/pdf') {
        text = await extractTextFromPdf(arrayBuffer);
      } else if (selectedFile.type.startsWith('text/')) {
        text = await selectedFile.text();
      } else {
        setError('Unsupported file type. Please upload a PDF or text file.');
        setLoading(false);
        return;
      }

      if (text.length < 100) {
        setError('Could not extract enough text from this document. It may be a scanned image PDF. Try uploading a text-based PDF or paste text manually below.');
        setLoading(false);
        return;
      }

      setExtractedText(text.substring(0, 5000));
      await analyzeText(text);

    } catch (err) {
      setError(err.message || 'Failed to process document');
      setLoading(false);
    }
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) processFile(droppedFile);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Head>
        <title>InsurEase — Understand Your Insurance</title>
        <meta name="description" content="Upload your insurance certificate and get an instant plain-English summary" />
      </Head>

      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
            <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">InsurEase</h1>
            <p className="text-xs text-slate-400">Understand your coverage in plain English</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-white mb-3">Upload Your Insurance Certificate</h2>
          <p className="text-slate-400 max-w-lg mx-auto">
            AI reads the fine print so you don't have to. Get a clear summary of your coverage, exclusions, and key dates.
          </p>
        </div>

        <div 
          className={`border-2 border-dashed rounded-2xl p-12 text-center transition-all ${
            dragOver 
              ? 'border-emerald-400 bg-emerald-500/5' 
              : 'border-slate-700 bg-slate-900/50 hover:border-slate-600'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <p className="text-lg font-medium text-white mb-2">
            {dragOver ? 'Drop your file here' : 'Drag & drop your insurance certificate'}
          </p>
          <p className="text-sm text-slate-500 mb-4">PDF or text files supported</p>
          <label className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium cursor-pointer transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            Browse Files
            <input 
              ref={fileInputRef}
              type="file" 
              className="hidden" 
              accept=".pdf,.txt,.doc,.docx"
              onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])}
            />
          </label>
          {file && (
            <p className="mt-3 text-sm text-emerald-400">✓ {file.name}</p>
          )}
        </div>

        {error && (
          <div className="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300">
            <p className="font-medium">{error}</p>
          </div>
        )}

        {needsPassword && (
          <div className="mt-6 p-5 rounded-2xl bg-slate-900 border border-amber-500/20">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <h3 className="font-semibold text-amber-300">Password Required</h3>
            </div>
            <p className="text-sm text-slate-400 mb-3">This PDF is password-protected. Please enter the password to continue.</p>
            <div className="flex gap-3">
              <input
                type="password"
                value={pdfPassword}
                onChange={(e) => setPdfPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit()}
                placeholder="Enter PDF password"
                className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
              />
              <button
                onClick={handlePasswordSubmit}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-medium transition-colors"
              >
                Unlock
              </button>
              <button
                onClick={() => { setNeedsPassword(false); setPendingFile(null); setPdfPassword(''); }}
                className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading && (
          <div className="mt-8 text-center">
            <div className="inline-flex items-center gap-3 px-5 py-3 bg-slate-900 rounded-xl">
              <div className="w-5 h-5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-slate-300">Analyzing your policy with AI...</span>
            </div>
          </div>
        )}

        {analysis && !analysis.raw && (
          <div className="mt-8 space-y-6">
            <div className="flex justify-end">
              <button
                onClick={exportToXlsx}
                className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-xl text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Download CSV
              </button>
            </div>
            <div className="bg-gradient-to-br from-emerald-900/30 to-slate-900 border border-emerald-500/20 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h3 className="font-semibold text-emerald-300">Summary</h3>
              </div>
              <p className="text-slate-300 leading-relaxed">{analysis.summary}</p>
              <div className="flex flex-wrap gap-2 mt-4">
                {analysis.policy_type && (
                  <span className="px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-sm font-medium">
                    {analysis.policy_type}
                  </span>
                )}
                {analysis.insurer && (
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    {analysis.insurer}
                  </span>
                )}
                {analysis.maturity?.type && (
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    {analysis.maturity.type}
                  </span>
                )}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              {analysis.premium && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                  <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                    <svg className="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Premium
                  </h3>
                  <div className="space-y-2 text-sm">
                    {analysis.premium.amount && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Amount</span>
                        <span className="text-white font-medium">{analysis.premium.amount}</span>
                      </div>
                    )}
                    {analysis.premium.frequency && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Frequency</span>
                        <span className="text-slate-300">{analysis.premium.frequency}</span>
                      </div>
                    )}
                    {analysis.premium.total_annual && (
                      <div className="flex justify-between border-t border-slate-800 pt-2">
                        <span className="text-slate-500">Annual Total</span>
                        <span className="text-emerald-400 font-medium">{analysis.premium.total_annual}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {analysis.key_dates && Object.values(analysis.key_dates).some(Boolean) && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                  <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                    <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    Key Dates
                  </h3>
                  <div className="space-y-2 text-sm">
                    {analysis.key_dates.issue_date && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Issued</span>
                        <span className="text-slate-300">{analysis.key_dates.issue_date}</span>
                      </div>
                    )}
                    {analysis.key_dates.commencement_date && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Commences</span>
                        <span className="text-slate-300">{analysis.key_dates.commencement_date}</span>
                      </div>
                    )}
                    {analysis.key_dates.maturity_date && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Matures</span>
                        <span className="text-blue-300">{analysis.key_dates.maturity_date}</span>
                      </div>
                    )}
                    {analysis.key_dates.renewal_date && (
                      <div className="flex justify-between border-t border-slate-800 pt-2">
                        <span className="text-slate-500">Renews</span>
                        <span className="text-amber-300">{analysis.key_dates.renewal_date}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {analysis.coverage?.main_benefits?.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  What You're Covered For
                </h3>
                <ul className="space-y-2">
                  {analysis.coverage.main_benefits.map((benefit, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-2 flex-shrink-0" />
                      <span className="text-slate-300">{benefit}</span>
                    </li>
                  ))}
                </ul>
                {analysis.coverage.riders?.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-800">
                    <p className="text-xs text-slate-500 mb-2">Add-ons (Riders)</p>
                    <ul className="space-y-1">
                      {analysis.coverage.riders.map((rider, i) => (
                        <li key={i} className="text-sm text-slate-400">• {rider}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {analysis.exclusions?.length > 0 && (
              <div className="bg-slate-900 border border-red-500/20 rounded-2xl p-5">
                <h3 className="font-semibold text-red-300 mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  What's NOT Covered (Exclusions)
                </h3>
                <ul className="space-y-2">
                  {analysis.exclusions.map((ex, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 mt-2 flex-shrink-0" />
                      <span className="text-slate-400">{ex}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.investment_linked?.is_ilp && (
              <div className="bg-gradient-to-br from-purple-900/20 to-slate-900 border border-purple-500/20 rounded-2xl p-5">
                <h3 className="font-semibold text-purple-300 mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                  Investment-Linked Policy Details
                </h3>
                <div className="grid md:grid-cols-2 gap-4 text-sm">
                  {analysis.investment_linked.allocation && (
                    <div>
                      <span className="text-slate-500">Premium Split</span>
                      <p className="text-white mt-1">{analysis.investment_linked.allocation}</p>
                    </div>
                  )}
                  {analysis.investment_linked.projected_returns && (
                    <div>
                      <span className="text-slate-500">Projected Returns</span>
                      <p className="text-emerald-300 mt-1">{analysis.investment_linked.projected_returns}</p>
                    </div>
                  )}
                  {analysis.investment_linked.funds?.length > 0 && (
                    <div className="md:col-span-2">
                      <span className="text-slate-500">Underlying Funds</span>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {analysis.investment_linked.funds.map((f, i) => (
                          <span key={i} className="px-2 py-1 bg-purple-500/10 text-purple-300 rounded text-xs">{f}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {analysis.maturity?.surrender_value_notes && (
                  <div className="mt-3 pt-3 border-t border-purple-500/10">
                    <span className="text-slate-500 text-sm">Surrender / Early Withdrawal</span>
                    <p className="text-slate-300 text-sm mt-1">{analysis.maturity.surrender_value_notes}</p>
                  </div>
                )}
              </div>
            )}

            {analysis.warnings?.length > 0 && (
              <div className="bg-amber-900/20 border border-amber-500/20 rounded-2xl p-5">
                <h3 className="font-semibold text-amber-300 mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Important Notes
                </h3>
                <ul className="space-y-2">
                  {analysis.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 flex-shrink-0" />
                      <span className="text-amber-200/80">{w}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-xs text-slate-600 text-center">
              This is an AI-generated summary for reference only. Always verify details with your insurer. Not financial advice.
            </p>
          </div>
        )}

        {analysis?.raw && (
          <div className="mt-8 space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h3 className="font-semibold text-white mb-3">AI Analysis (Raw)</h3>
              <pre className="text-xs text-slate-400 whitespace-pre-wrap overflow-auto max-h-96">{analysis.raw}</pre>
            </div>
          </div>
        )}

        {/* Manual text input fallback */}
        {!analysis && !loading && (
          <div className="mt-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-px flex-1 bg-slate-800" />
              <span className="text-sm text-slate-500">or paste text manually</span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>
            <textarea
              className="w-full h-40 bg-slate-900 border border-slate-800 rounded-xl p-4 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-slate-600 resize-none"
              placeholder="Paste your insurance policy text here if PDF upload doesn't work..."
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
            />
            {manualText.length > 500 && (
              <button
                onClick={() => analyzeText(manualText)}
                className="mt-3 w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors"
              >
                Analyze Pasted Text
              </button>
            )}
          </div>
        )}
      </main>

      <footer className="border-t border-slate-800 mt-16 py-6 text-center">
        <p className="text-sm text-slate-600">
          InsurEase — Free tool. No data stored. Documents are processed in memory only.
        </p>
      </footer>
    </div>
  );
}
