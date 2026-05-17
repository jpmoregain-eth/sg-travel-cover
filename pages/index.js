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

const createEmptyDoc = (id) => ({
  id,
  file: null,
  password: '',
  needsPassword: false,
  pendingBuffer: null,
  extractedText: '',
  analysis: null,
  loading: false,
  error: '',
  stage: null,
  extractProgress: null,
});

export default function Home() {
  const [documents, setDocuments] = useState([createEmptyDoc(0)]);
  const [dragOverId, setDragOverId] = useState(null);
  const fileInputRefs = useRef({});

  const updateDoc = (id, updates) => {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
  };

  const extractTextFromPdf = async (arrayBuffer, password = null, timeoutMs = 5000) => {
    const pdfjs = await loadPdfJs();
    const options = { data: arrayBuffer };
    if (password) options.password = password;
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
      
      try {
        const loadingTask = pdfjs.getDocument(options);
        
        // v4 API: onPassword callback
        if (loadingTask.onPassword !== undefined) {
          loadingTask.onPassword = (updatePassword, reason) => {
            clearTimeout(timeoutId);
            reject(new Error('PASSWORD_REQUIRED'));
          };
        }
        
        loadingTask.promise.then(pdf => {
          clearTimeout(timeoutId);
          let fullText = '';
          const maxPages = Math.min(pdf.numPages, 20);
          
          const extractPages = async () => {
            try {
              for (let i = 1; i <= maxPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += pageText + '\n\n';
              }
              resolve(fullText.trim());
            } catch (err) {
              reject(err);
            }
          };
          
          extractPages();
        }).catch(err => {
          clearTimeout(timeoutId);
          const msg = String(err);
          if (msg.includes('password') || msg.includes('Password') || err.name === 'PasswordException') {
            reject(new Error('PASSWORD_REQUIRED'));
          } else {
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  };

  const analyzeDocText = async (text, id) => {
    if (!text || text.length < 50) {
      updateDoc(id, { error: 'Not enough text to analyze.', loading: false });
      return;
    }
    updateDoc(id, { loading: true, error: '', analysis: null });

    // Client-side timeout: 15 seconds
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ text })
      });

      clearTimeout(timeoutId);

      const data = await res.json();
      
      if (data.error && !data.raw_response) {
        updateDoc(id, { error: data.error, loading: false });
      } else if (data.raw_response) {
        updateDoc(id, { error: data.error || 'Showing raw analysis', analysis: { raw: data.raw_response }, loading: false });
      } else {
        updateDoc(id, { analysis: data.analysis, loading: false });
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        updateDoc(id, { error: 'Request timed out. The document may be too large or the AI service is slow. Try pasting a smaller excerpt manually.', loading: false });
      } else {
        updateDoc(id, { error: err.message || 'Failed to analyze text', loading: false });
      }
    }
  };

  const processFileForDoc = async (selectedFile, id, providedPassword = null) => {
    if (!selectedFile) return;
    
    updateDoc(id, { 
      file: selectedFile, 
      error: '', 
      analysis: null, 
      needsPassword: false,
      extractedText: '',
      loading: true 
    });

    try {
      let text = '';
      const arrayBuffer = await selectedFile.arrayBuffer();
      // Clone the buffer because pdf.js can detach it on first attempt
      const clonedBuffer = arrayBuffer.slice(0);

      if (selectedFile.type === 'application/pdf') {
        // First try: quick 3-second attempt without password
        // Password-protected PDFs will timeout fast, then we prompt for password
        try {
          text = await extractTextFromPdf(arrayBuffer, null, 3000);
        } catch (firstErr) {
          if (firstErr.message === 'TIMEOUT' || firstErr.message === 'PASSWORD_REQUIRED') {
            // Show password prompt — use the cloned buffer
            updateDoc(id, { 
              needsPassword: true, 
              pendingBuffer: clonedBuffer, 
              loading: false,
              stage: null,
              extractProgress: null,
              error: ''
            });
            return;
          }
          throw firstErr;
        }
      } else if (selectedFile.type.startsWith('text/')) {
        text = await selectedFile.text();
      } else {
        updateDoc(id, { error: 'Unsupported file type. Please upload a PDF or text file.', loading: false, stage: null });
        return;
      }

      if (text.length < 100) {
        updateDoc(id, { error: 'Could not extract enough text. It may be a scanned image PDF. Try pasting text manually.', loading: false, stage: null, extractProgress: null });
        return;
      }

      updateDoc(id, { extractedText: text.substring(0, 5000), needsPassword: false, pendingBuffer: null, stage: 'analyzing', extractProgress: null });
      await analyzeDocText(text, id);

    } catch (err) {
      if (err.message === 'PASSWORD_REQUIRED' || err.message === 'TIMEOUT') {
        updateDoc(id, { 
          needsPassword: true, 
          pendingBuffer: arrayBuffer, 
          loading: false,
          stage: null,
          extractProgress: null,
          error: ''
        });
        return;
      }
      updateDoc(id, { error: err.message || 'Failed to process document', loading: false, stage: null, extractProgress: null });
    }
  };

  const handlePasswordSubmit = async (id) => {
    const doc = documents.find(d => d.id === id);
    if (!doc || !doc.password || !doc.pendingBuffer) return;
    
    updateDoc(id, { needsPassword: false, loading: true, error: '', stage: 'extracting' });
    
    try {
      // Add 15-second timeout around PDF extraction with password (decryption takes time)
      const extractPromise = extractTextFromPdf(doc.pendingBuffer, doc.password, 15000);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('PDF extraction timed out. The password may be incorrect or the file is too large. Try pasting text manually.')), 15000)
      );
      const text = await Promise.race([extractPromise, timeoutPromise]);
      
      if (text.length < 100) {
        updateDoc(id, { error: 'Could not extract enough text. Try pasting text manually.', loading: false, stage: null, extractProgress: null });
        return;
      }
      
      updateDoc(id, { extractedText: text.substring(0, 5000), pendingBuffer: null, stage: 'analyzing', extractProgress: null });
      await analyzeDocText(text, id);
    } catch (err) {
      if (err.message === 'PASSWORD_REQUIRED') {
        updateDoc(id, { needsPassword: true, error: 'Incorrect password. Please try again.', loading: false, stage: null, extractProgress: null });
      } else {
        updateDoc(id, { error: err.message || 'Failed to process document', loading: false, stage: null, extractProgress: null });
      }
    }
  };

  const addDocument = () => {
    if (documents.length >= 5) return;
    const newId = Math.max(...documents.map(d => d.id), -1) + 1;
    setDocuments(prev => [...prev, createEmptyDoc(newId)]);
  };

  const removeDocument = (id) => {
    if (documents.length <= 1) {
      // Reset to empty instead of removing last one
      updateDoc(id, createEmptyDoc(id));
      return;
    }
    setDocuments(prev => prev.filter(d => d.id !== id));
  };

  const handleDrop = useCallback((e, id) => {
    e.preventDefault();
    setDragOverId(null);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) processFileForDoc(droppedFile, id);
  }, []);

  const handleDragOver = useCallback((e, id) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragOverId(null);
  }, []);

  const exportAllToCsv = () => {
    const analyzedDocs = documents.filter(d => d.analysis && !d.analysis.raw);
    if (analyzedDocs.length === 0) return;

    let csv = '\uFEFF';
    
    analyzedDocs.forEach((doc, idx) => {
      const a = doc.analysis;
      csv += `Document ${idx + 1}: ${doc.file?.name || 'Unknown'}\n`;
      csv += `Field,Value\n`;
      csv += `Policy Type,"${(a.policy_type || '').replace(/"/g, '""')}"\n`;
      csv += `Insurer,"${(a.insurer || '').replace(/"/g, '""')}"\n`;
      csv += `Policy Number,"${(a.policy_number || '').replace(/"/g, '""')}"\n`;
      csv += `Policyholder,"${(a.policyholder || '').replace(/"/g, '""')}"\n`;
      if (a.premium) {
        csv += `Premium Amount,"${(a.premium.amount || '').replace(/"/g, '""')}"\n`;
        csv += `Premium Frequency,"${(a.premium.frequency || '').replace(/"/g, '""')}"\n`;
        csv += `Annual Total,"${(a.premium.total_annual || '').replace(/"/g, '""')}"\n`;
      }
      if (a.key_dates) {
        csv += `Issue Date,"${(a.key_dates.issue_date || '').replace(/"/g, '""')}"\n`;
        csv += `Commencement Date,"${(a.key_dates.commencement_date || '').replace(/"/g, '""')}"\n`;
        csv += `Maturity Date,"${(a.key_dates.maturity_date || '').replace(/"/g, '""')}"\n`;
        csv += `Renewal Date,"${(a.key_dates.renewal_date || '').replace(/"/g, '""')}"\n`;
      }
      if (a.maturity) {
        csv += `Maturity Type,"${(a.maturity.type || '').replace(/"/g, '""')}"\n`;
        csv += `Term Years,"${(a.maturity.term_years || '').replace(/"/g, '""')}"\n`;
        csv += `Surrender Notes,"${(a.maturity.surrender_value_notes || '').replace(/"/g, '""')}"\n`;
      }
      if (a.coverage?.medical_expenses) csv += `Medical Expenses,"${a.coverage.medical_expenses.replace(/"/g, '""')}"\n`;
      if (a.coverage?.trip_cancellation) csv += `Trip Cancellation,"${a.coverage.trip_cancellation.replace(/"/g, '""')}"\n`;
      if (a.coverage?.baggage_loss) csv += `Baggage Loss,"${a.coverage.baggage_loss.replace(/"/g, '""')}"\n`;
      if (a.coverage?.personal_accident) csv += `Personal Accident,"${a.coverage.personal_accident.replace(/"/g, '""')}"\n`;
      if (a.coverage?.travel_delay) csv += `Travel Delay,"${a.coverage.travel_delay.replace(/"/g, '""')}"\n`;
      if (a.coverage?.main_benefits?.length) {
        csv += `Other Coverage,"${a.coverage.main_benefits.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.coverage?.riders?.length) {
        csv += `Riders,"${a.coverage.riders.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.payout_criteria?.length) {
        csv += `Payout Criteria,"${a.payout_criteria.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.deductibles_excess?.length) {
        csv += `Deductibles / Excess,"${a.deductibles_excess.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.exclusions?.length) {
        csv += `Exclusions,"${a.exclusions.join('; ').replace(/"/g, '""')}"\n`;
      }
      if (a.investment_linked?.is_ilp) {
        csv += `ILP Allocation,"${(a.investment_linked.allocation || '').replace(/"/g, '""')}"\n`;
        csv += `ILP Returns,"${(a.investment_linked.projected_returns || '').replace(/"/g, '""')}"\n`;
        if (a.investment_linked.funds?.length) {
          csv += `ILP Funds,"${a.investment_linked.funds.join('; ').replace(/"/g, '""')}"\n`;
        }
      }
      if (a.warnings?.length) {
        csv += `Warnings,"${a.warnings.join('; ').replace(/"/g, '""')}"\n`;
      }
      csv += `Summary,"${(a.summary || '').replace(/"/g, '""')}"\n`;
      csv += `\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'insurance-analysis-all.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportSingleCsv = (doc) => {
    const a = doc.analysis;
    if (!a || a.raw) return;

    const rows = [['Field', 'Value']];
    rows.push(['Policy Type', a.policy_type || '']);
    rows.push(['Insurer', a.insurer || '']);
    rows.push(['Policy Number', a.policy_number || '']);
    rows.push(['Policyholder', a.policyholder || '']);
    if (a.premium) {
      rows.push(['Premium Amount', a.premium.amount || '']);
      rows.push(['Premium Frequency', a.premium.frequency || '']);
      rows.push(['Annual Total', a.premium.total_annual || '']);
    }
    if (a.key_dates) {
      rows.push(['Issue Date', a.key_dates.issue_date || '']);
      rows.push(['Commencement Date', a.key_dates.commencement_date || '']);
      rows.push(['Maturity Date', a.key_dates.maturity_date || '']);
      rows.push(['Renewal Date', a.key_dates.renewal_date || '']);
    }
    if (a.maturity) {
      rows.push(['Maturity Type', a.maturity.type || '']);
      rows.push(['Term Years', a.maturity.term_years || '']);
      rows.push(['Surrender Notes', a.maturity.surrender_value_notes || '']);
    }
    if (a.coverage?.medical_expenses) rows.push(['Medical Expenses', a.coverage.medical_expenses]);
    if (a.coverage?.trip_cancellation) rows.push(['Trip Cancellation', a.coverage.trip_cancellation]);
    if (a.coverage?.baggage_loss) rows.push(['Baggage Loss', a.coverage.baggage_loss]);
    if (a.coverage?.personal_accident) rows.push(['Personal Accident', a.coverage.personal_accident]);
    if (a.coverage?.travel_delay) rows.push(['Travel Delay', a.coverage.travel_delay]);
    if (a.coverage?.main_benefits?.length) {
      rows.push(['', '']);
      rows.push(['Other Coverage', '']);
      a.coverage.main_benefits.forEach(b => rows.push(['', b]));
    }
    if (a.coverage?.riders?.length) {
      rows.push(['', '']);
      rows.push(['Riders', '']);
      a.coverage.riders.forEach(r => rows.push(['', r]));
    }
    if (a.payout_criteria?.length) {
      rows.push(['', '']);
      rows.push(['Payout Criteria', '']);
      a.payout_criteria.forEach(c => rows.push(['', c]));
    }
    if (a.deductibles_excess?.length) {
      rows.push(['', '']);
      rows.push(['Deductibles & Excess', '']);
      a.deductibles_excess.forEach(d => rows.push(['', d]));
    }
    if (a.exclusions?.length) {
      rows.push(['', '']);
      rows.push(['Exclusions', '']);
      a.exclusions.forEach(e => rows.push(['', e]));
    }
    if (a.investment_linked?.is_ilp) {
      rows.push(['', '']);
      rows.push(['Investment-Linked Policy', '']);
      rows.push(['Allocation', a.investment_linked.allocation || '']);
      rows.push(['Projected Returns', a.investment_linked.projected_returns || '']);
      if (a.investment_linked.funds?.length) {
        rows.push(['Underlying Funds', a.investment_linked.funds.join(', ')]);
      }
    }
    if (a.warnings?.length) {
      rows.push(['', '']);
      rows.push(['Warnings', '']);
      a.warnings.forEach(w => rows.push(['', w]));
    }
    rows.push(['', '']);
    rows.push(['Summary', a.summary || '']);

    let csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `insurance-analysis-${doc.file?.name?.replace(/\.[^/.]+$/, '') || 'doc'}.csv`;
    document.body.appendChild(el);
    el.click();
    document.body.removeChild(el);
    URL.revokeObjectURL(url);
  };

  const analyzedCount = documents.filter(d => d.analysis && !d.analysis.raw).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Head>
        <title>InsurEase — Understand Your Insurance</title>
        <meta name="description" content="Upload your insurance certificates and get instant plain-English summaries" />
      </Head>

      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
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
          {analyzedCount > 0 && (
            <button
              onClick={exportAllToCsv}
              className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-xl text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export All ({analyzedCount})
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-white mb-3">Upload Your Insurance Certificates</h2>
          <p className="text-slate-400 max-w-lg mx-auto">
            AI reads the fine print so you don't have to. Upload up to 5 policies for comparison.
          </p>
        </div>

        {/* Document Cards */}
        <div className="space-y-4">
          {documents.map((doc, idx) => (
            <div key={doc.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              {/* Card Header */}
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-sm font-bold text-slate-400">
                    {idx + 1}
                  </div>
                  <span className="font-medium text-white">
                    {doc.file ? doc.file.name : 'Select a document'}
                  </span>
                  {doc.analysis && !doc.analysis.raw && (
                    <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-xs font-medium">
                      Analyzed
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {doc.analysis && !doc.analysis.raw && (
                    <button
                      onClick={() => exportSingleCsv(doc)}
                      className="p-2 text-slate-400 hover:text-white transition-colors"
                      title="Download CSV"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => removeDocument(doc.id)}
                    className="p-2 text-slate-500 hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Card Body */}
              <div className="p-5">
                {!doc.file && !doc.analysis && (
                  <div
                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                      dragOverId === doc.id
                        ? 'border-emerald-400 bg-emerald-500/5'
                        : 'border-slate-700 hover:border-slate-600'
                    }`}
                    onDrop={(e) => handleDrop(e, doc.id)}
                    onDragOver={(e) => handleDragOver(e, doc.id)}
                    onDragLeave={handleDragLeave}
                  >
                    <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center mx-auto mb-3">
                      <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-white mb-1">
                      {dragOverId === doc.id ? 'Drop your file here' : 'Drag & drop or browse'}
                    </p>
                    <p className="text-xs text-slate-500 mb-3">PDF or text files</p>
                    <label className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                      Browse
                      <input
                        ref={el => fileInputRefs.current[doc.id] = el}
                        type="file"
                        className="hidden"
                        accept=".pdf,.txt,.doc,.docx"
                        onChange={(e) => e.target.files?.[0] && processFileForDoc(e.target.files[0], doc.id)}
                      />
                    </label>
                  </div>
                )}

                {/* Password Prompt */}
                {doc.needsPassword && (
                  <div className="p-4 rounded-xl bg-amber-900/10 border border-amber-500/20">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      <span className="text-sm font-medium text-amber-300">Password Required</span>
                    </div>
                    <p className="text-xs text-slate-500 mb-3">This PDF is password-protected</p>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={doc.password}
                        onChange={(e) => updateDoc(doc.id, { password: e.target.value })}
                        onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit(doc.id)}
                        placeholder="Enter PDF password"
                        className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
                      />
                      <button
                        onClick={() => handlePasswordSubmit(doc.id)}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors"
                      >
                        Unlock
                      </button>
                      <button
                        onClick={() => {
                          updateDoc(doc.id, { needsPassword: false, password: '', pendingBuffer: null, file: null });
                        }}
                        className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Error */}
                {doc.error && (
                  <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
                    {doc.error}
                  </div>
                )}

                {/* Loading */}
                {doc.loading && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-slate-400">
                    <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                    {doc.stage === 'extracting' ? (
                      <span>Extracting text from PDF{doc.extractProgress ? ` (${doc.extractProgress})` : ''}...</span>
                    ) : doc.stage === 'analyzing' ? (
                      <span>Analyzing with AI...</span>
                    ) : (
                      <span>Processing...</span>
                    )}
                  </div>
                )}

                {/* Manual Text Input */}
                {!doc.file && !doc.analysis && !doc.loading && (
                  <div className="mt-4">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="h-px flex-1 bg-slate-800" />
                      <span className="text-xs text-slate-500">or paste text</span>
                      <div className="h-px flex-1 bg-slate-800" />
                    </div>
                    <textarea
                      className="w-full h-24 bg-slate-800 border border-slate-700 rounded-lg p-3 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:border-slate-600 resize-none"
                      placeholder="Paste your insurance policy text here..."
                      value={doc.extractedText}
                      onChange={(e) => updateDoc(doc.id, { extractedText: e.target.value })}
                    />
                    {doc.extractedText.length > 500 && (
                      <button
                        onClick={() => analyzeDocText(doc.extractedText, doc.id)}
                        className="mt-2 w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors"
                      >
                        Analyze Text
                      </button>
                    )}
                  </div>
                )}

                {/* Results */}
                {doc.analysis && !doc.analysis.raw && (
                  <AnalysisResults analysis={doc.analysis} />
                )}
                {doc.analysis?.raw && (
                  <div className="mt-4 p-4 bg-slate-800 border border-slate-700 rounded-xl">
                    <h3 className="text-sm font-medium text-white mb-2">AI Analysis (Raw)</h3>
                    <pre className="text-xs text-slate-400 whitespace-pre-wrap overflow-auto max-h-80">
                      {doc.analysis.raw}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Add Document Button */}
        {documents.length < 5 && (
          <button
            onClick={addDocument}
            className="mt-4 w-full py-4 border-2 border-dashed border-slate-700 hover:border-emerald-500/50 rounded-2xl text-slate-500 hover:text-emerald-400 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Another Document ({documents.length}/5)
          </button>
        )}
      </main>

      <footer className="border-t border-slate-800 mt-12 py-6 text-center">
        <p className="text-sm text-slate-600">
          InsurEase — Free tool. No data stored. Documents processed in memory only.
        </p>
      </footer>
    </div>
  );
}

function AnalysisResults({ analysis }) {
  return (
    <div className="mt-4 space-y-4">
      {/* Summary */}
      <div className="bg-gradient-to-br from-emerald-900/30 to-slate-900 border border-emerald-500/20 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h3 className="font-semibold text-emerald-300 text-sm">Summary</h3>
        </div>
        <p className="text-slate-300 text-sm leading-relaxed">{analysis.summary}</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {analysis.policy_type && (
            <span className="px-2 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-xs font-medium">
              {analysis.policy_type}
            </span>
          )}
          {analysis.insurer && (
            <span className="px-2 py-1 bg-slate-700 text-slate-300 rounded-full text-xs">
              {analysis.insurer}
            </span>
          )}
          {analysis.maturity?.type && (
            <span className="px-2 py-1 bg-slate-700 text-slate-300 rounded-full text-xs">
              {analysis.maturity.type}
            </span>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Premium */}
        {analysis.premium && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <h3 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
              <svg className="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Premium
            </h3>
            <div className="space-y-1.5 text-sm">
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
                <div className="flex justify-between border-t border-slate-700 pt-1.5 mt-1.5">
                  <span className="text-slate-500">Annual</span>
                  <span className="text-emerald-400 font-medium">{analysis.premium.total_annual}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Key Dates */}
        {analysis.key_dates && Object.values(analysis.key_dates).some(Boolean) && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <h3 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
              <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Key Dates
            </h3>
            <div className="space-y-1.5 text-sm">
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
                <div className="flex justify-between border-t border-slate-700 pt-1.5 mt-1.5">
                  <span className="text-slate-500">Renews</span>
                  <span className="text-amber-300">{analysis.key_dates.renewal_date}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Coverage Amounts */}
      {(analysis.coverage?.medical_expenses || analysis.coverage?.trip_cancellation || analysis.coverage?.baggage_loss || analysis.coverage?.personal_accident || analysis.coverage?.travel_delay) && (
        <div className="bg-gradient-to-br from-emerald-900/20 to-slate-800 border border-emerald-500/20 rounded-xl p-4">
          <h3 className="text-sm font-medium text-emerald-300 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Coverage Limits
          </h3>
          <div className="space-y-2 text-sm">
            {analysis.coverage.medical_expenses && (
              <div className="flex justify-between">
                <span className="text-slate-400">Medical Expenses</span>
                <span className="text-white font-medium">{analysis.coverage.medical_expenses}</span>
              </div>
            )}
            {analysis.coverage.trip_cancellation && (
              <div className="flex justify-between">
                <span className="text-slate-400">Trip Cancellation</span>
                <span className="text-white font-medium">{analysis.coverage.trip_cancellation}</span>
              </div>
            )}
            {analysis.coverage.baggage_loss && (
              <div className="flex justify-between">
                <span className="text-slate-400">Baggage Loss</span>
                <span className="text-white font-medium">{analysis.coverage.baggage_loss}</span>
              </div>
            )}
            {analysis.coverage.personal_accident && (
              <div className="flex justify-between">
                <span className="text-slate-400">Personal Accident</span>
                <span className="text-white font-medium">{analysis.coverage.personal_accident}</span>
              </div>
            )}
            {analysis.coverage.travel_delay && (
              <div className="flex justify-between">
                <span className="text-slate-400">Travel Delay</span>
                <span className="text-white font-medium">{analysis.coverage.travel_delay}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Coverage Benefits List */}
      {analysis.coverage?.main_benefits?.length > 0 && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Other Coverage
          </h3>
          <ul className="space-y-1.5">
            {analysis.coverage.main_benefits.map((benefit, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="w-1 h-1 rounded-full bg-emerald-400 mt-2 flex-shrink-0" />
                <span className="text-slate-300">{benefit}</span>
              </li>
            ))}
          </ul>
          {analysis.coverage.riders?.length > 0 && (
            <div className="mt-2 pt-2 border-t border-slate-700">
              <p className="text-xs text-slate-500 mb-1">Riders</p>
              {analysis.coverage.riders.map((rider, i) => (
                <p key={i} className="text-xs text-slate-400">• {rider}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Payout Criteria */}
      {analysis.payout_criteria?.length > 0 && (
        <div className="bg-slate-800 border border-emerald-500/10 rounded-xl p-4">
          <h3 className="text-sm font-medium text-emerald-300 mb-2 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            Payout Criteria
          </h3>
          <ul className="space-y-1.5">
            {analysis.payout_criteria.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="w-1 h-1 rounded-full bg-emerald-400 mt-2 flex-shrink-0" />
                <span className="text-slate-300">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Deductibles / Excess */}
      {analysis.deductibles_excess?.length > 0 && (
        <div className="bg-slate-800 border border-amber-500/20 rounded-xl p-4">
          <h3 className="text-sm font-medium text-amber-300 mb-2 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Deductibles & Excess
          </h3>
          <ul className="space-y-1.5">
            {analysis.deductibles_excess.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="w-1 h-1 rounded-full bg-amber-400 mt-2 flex-shrink-0" />
                <span className="text-amber-200/80">{d}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Exclusions */}
      {analysis.exclusions?.length > 0 && (
        <div className="bg-slate-800 border border-red-500/20 rounded-xl p-4">
          <h3 className="text-sm font-medium text-red-300 mb-2 flex items-center gap-2">
            <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Exclusions
          </h3>
          <ul className="space-y-1.5">
            {analysis.exclusions.map((ex, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="w-1 h-1 rounded-full bg-red-400 mt-2 flex-shrink-0" />
                <span className="text-slate-400">{ex}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ILP */}
      {analysis.investment_linked?.is_ilp && (
        <div className="bg-gradient-to-br from-purple-900/20 to-slate-800 border border-purple-500/20 rounded-xl p-4">
          <h3 className="text-sm font-medium text-purple-300 mb-2 flex items-center gap-2">
            <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            Investment-Linked Details
          </h3>
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            {analysis.investment_linked.allocation && (
              <div>
                <span className="text-slate-500">Allocation</span>
                <p className="text-white mt-0.5">{analysis.investment_linked.allocation}</p>
              </div>
            )}
            {analysis.investment_linked.projected_returns && (
              <div>
                <span className="text-slate-500">Projected Returns</span>
                <p className="text-emerald-300 mt-0.5">{analysis.investment_linked.projected_returns}</p>
              </div>
            )}
          </div>
          {analysis.investment_linked.funds?.length > 0 && (
            <div className="mt-2">
              <span className="text-xs text-slate-500">Funds</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {analysis.investment_linked.funds.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 bg-purple-500/10 text-purple-300 rounded text-xs">{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Warnings */}
      {analysis.warnings?.length > 0 && (
        <div className="bg-amber-900/20 border border-amber-500/20 rounded-xl p-4">
          <h3 className="text-sm font-medium text-amber-300 mb-2 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Important Notes
          </h3>
          <ul className="space-y-1.5">
            {analysis.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="w-1 h-1 rounded-full bg-amber-400 mt-2 flex-shrink-0" />
                <span className="text-amber-200/80">{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
