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
  const [showUpload, setShowUpload] = useState(false);
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
    
    if (selectedFile.size === 0) {
      updateDoc(id, { error: 'This file is empty (0 bytes). Please upload a real document.', loading: false, stage: null });
      return;
    }
    
    const MAX_SIZE_MB = 50;
    if (selectedFile.size > MAX_SIZE_MB * 1024 * 1024) {
      updateDoc(id, { error: `File too large (${(selectedFile.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_SIZE_MB} MB.`, loading: false, stage: null });
      return;
    }
    
    const ext = selectedFile.name.split('.').pop().toLowerCase();
    const isPdf = selectedFile.type === 'application/pdf' || ext === 'pdf';
    const isDocx = ext === 'docx';
    const isText = selectedFile.type.startsWith('text/') || ext === 'txt' || ext === 'text';
    
    if (!isPdf && !isDocx && !isText) {
      updateDoc(id, { error: `Unsupported file type (.${ext}). We accept PDF, DOCX, and TXT files only.`, loading: false, stage: null });
      return;
    }
    
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
      const clonedBuffer = arrayBuffer.slice(0);

      if (selectedFile.type === 'application/pdf') {
        try {
          text = await extractTextFromPdf(arrayBuffer, null, 3000);
        } catch (firstErr) {
          if (firstErr.message === 'TIMEOUT' || firstErr.message === 'PASSWORD_REQUIRED') {
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
          if (firstErr.message?.includes('Invalid') || firstErr.message?.includes('corrupt') || firstErr.message?.includes('structure')) {
            throw new Error('This PDF file appears to be corrupted or is not a valid PDF. Try re-saving or re-exporting from the original source.');
          }
          throw firstErr;
        }
      } else if (selectedFile.name.endsWith('.docx')) {
        let result;
        try {
          const mammoth = await import('mammoth');
          result = await mammoth.extractRawText({ arrayBuffer });
        } catch (mammothErr) {
          throw new Error('This DOCX file appears to be corrupted or not a valid Word document. Try opening it in Word and re-saving.');
        }
        text = result.value;
        if (result.messages.length > 0) {
          console.warn('DOCX parse warnings:', result.messages);
        }
      } else if (selectedFile.type.startsWith('text/')) {
        text = await selectedFile.text();
      } else {
        updateDoc(id, { error: 'Unsupported file type. Please upload a PDF, DOCX, or text file.', loading: false, stage: null });
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
        csv += `Premium Amount,"${String(a.premium.amount || '').replace(/"/g, '""')}"\n`;
        csv += `Premium Frequency,"${String(a.premium.frequency || '').replace(/"/g, '""')}"\n`;
        csv += `Annual Total,"${String(a.premium.total_annual || '').replace(/"/g, '""')}"\n`;
      }
      if (a.key_dates) {
        csv += `Issue Date,"${String(a.key_dates.issue_date || '').replace(/"/g, '""')}"\n`;
        csv += `Commencement Date,"${String(a.key_dates.commencement_date || '').replace(/"/g, '""')}"\n`;
        csv += `Maturity Date,"${String(a.key_dates.maturity_date || '').replace(/"/g, '""')}"\n`;
        csv += `Renewal Date,"${String(a.key_dates.renewal_date || '').replace(/"/g, '""')}"\n`;
      }
      if (a.maturity) {
        csv += `Maturity Type,"${String(a.maturity.type || '').replace(/"/g, '""')}"\n`;
        csv += `Term Years,"${String(a.maturity.term_years || '').replace(/"/g, '""')}"\n`;
        csv += `Surrender Notes,"${String(a.maturity.surrender_value_notes || '').replace(/"/g, '""')}"\n`;
      }
      if (a.coverage?.medical_expenses) csv += `Medical Expenses,"${String(a.coverage.medical_expenses).replace(/"/g, '""')}"\n`;
      if (a.coverage?.trip_cancellation) csv += `Trip Cancellation,"${String(a.coverage.trip_cancellation).replace(/"/g, '""')}"\n`;
      if (a.coverage?.baggage_loss) csv += `Baggage Loss,"${String(a.coverage.baggage_loss).replace(/"/g, '""')}"\n`;
      if (a.coverage?.personal_accident) csv += `Personal Accident,"${String(a.coverage.personal_accident).replace(/"/g, '""')}"\n`;
      if (a.coverage?.travel_delay) csv += `Travel Delay,"${String(a.coverage.travel_delay).replace(/"/g, '""')}"\n`;
      if (a.coverage?.vehicle_sum_insured) csv += `Sum Insured / Market Value,"${String(a.coverage.vehicle_sum_insured).replace(/"/g, '""')}"\n`;
      if (a.coverage?.third_party_liability) csv += `Third-Party Liability,"${String(a.coverage.third_party_liability).replace(/"/g, '""')}"\n`;
      if (a.coverage?.own_damage_excess) csv += `Own Damage Excess,"${String(a.coverage.own_damage_excess).replace(/"/g, '""')}"\n`;
      if (a.coverage?.unnamed_driver_excess) csv += `Unnamed Driver Excess,"${String(a.coverage.unnamed_driver_excess).replace(/"/g, '""')}"\n`;
      if (a.coverage?.young_driver_excess) csv += `Young/Inexperienced Driver Excess,"${String(a.coverage.young_driver_excess).replace(/"/g, '""')}"\n`;
      if (a.coverage?.windscreen_excess) csv += `Windscreen Excess,"${String(a.coverage.windscreen_excess).replace(/"/g, '""')}"\n`;
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
    if (a.coverage?.vehicle_sum_insured) rows.push(['Sum Insured / Market Value', a.coverage.vehicle_sum_insured]);
    if (a.coverage?.third_party_liability) rows.push(['Third-Party Liability', a.coverage.third_party_liability]);
    if (a.coverage?.own_damage_excess) rows.push(['Own Damage Excess', a.coverage.own_damage_excess]);
    if (a.coverage?.unnamed_driver_excess) rows.push(['Unnamed Driver Excess', a.coverage.unnamed_driver_excess]);
    if (a.coverage?.young_driver_excess) rows.push(['Young/Inexperienced Driver Excess', a.coverage.young_driver_excess]);
    if (a.coverage?.windscreen_excess) rows.push(['Windscreen Excess', a.coverage.windscreen_excess]);
    if (a.coverage?.main_benefits?.length) {
      rows.push(['', '']);
      rows.push(['Coverage Benefits', '']);
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
      rows.push(['Deductibles / Excess', '']);
      a.deductibles_excess.forEach(d => rows.push(['', d]));
    }
    if (a.exclusions?.length) {
      rows.push(['', '']);
      rows.push(['Exclusions', '']);
      a.exclusions.forEach(ex => rows.push(['', ex]));
    }
    if (a.investment_linked?.is_ilp) {
      rows.push(['', '']);
      rows.push(['ILP Allocation', a.investment_linked.allocation || '']);
      rows.push(['ILP Returns', a.investment_linked.projected_returns || '']);
      if (a.investment_linked.funds?.length) {
        rows.push(['ILP Funds', a.investment_linked.funds.join(', ')]);
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
    <div className="min-h-screen bg-white text-slate-800">
      <Head>
        <title>Policy2Summary — AI Insurance Document Reader</title>
        <meta name="description" content="Upload your insurance certificates and get instant plain-English summaries. No signup, no data stored." />
      </Head>

      {/* Navigation */}
      <nav className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/images/logo.jpg"
              alt="Policy2Summary"
              className="w-9 h-9 rounded-lg object-cover"
            />
            <div>
              <h1 className="text-lg font-bold text-slate-900 tracking-tight leading-none">Policy2Summary</h1>
              <p className="text-[10px] text-slate-400 font-medium tracking-wider uppercase mt-0.5">AI Insurance Reader</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <a href="#how-it-works" className="hidden sm:inline-flex text-sm text-slate-500 hover:text-slate-800 transition-colors font-medium">How It Works</a>
            <a href="#upload-section" className="hidden sm:inline-flex text-sm text-slate-500 hover:text-slate-800 transition-colors font-medium">Analyze</a>
            {analyzedCount > 0 && (
              <button
                onClick={exportAllToCsv}
                className="inline-flex items-center gap-2 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-sm font-medium transition-colors shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Export ({analyzedCount})
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-b from-emerald-50 to-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-12 sm:pt-12 sm:pb-16">
          <div className="mb-4">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Free Tool — No Signup Required
            </div>
          </div>
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-4xl sm:text-5xl font-bold text-slate-900 leading-tight mb-6">
                Understand Your Insurance in{' '}
                <span className="text-emerald-600">Plain English</span>
              </h2>
              <p className="text-lg text-slate-600 mb-8 leading-relaxed max-w-lg">
                Upload any insurance policy — PDF, Word, or text. Our AI reads the fine print and tells you exactly what you are covered for, what is excluded, and what it costs.
              </p>
              <div className="flex flex-wrap gap-4">
                <button
                  onClick={() => { setShowUpload(true); setTimeout(() => document.getElementById('upload-section')?.scrollIntoView({ behavior: 'smooth' }), 100); }}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-base font-semibold transition-colors shadow-lg shadow-emerald-600/20"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  Upload Your Policy
                </button>
                <a href="#how-it-works" className="inline-flex items-center gap-2 px-6 py-3 bg-white border-2 border-slate-200 hover:border-slate-300 text-slate-700 rounded-xl text-base font-semibold transition-colors">
                  See How It Works
                </a>
              </div>
              <div className="flex items-center gap-6 mt-8 text-sm text-slate-500">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  No signup
                </div>
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  No data stored
                </div>
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Free forever
                </div>
              </div>
            </div>
            <div className="relative">
              <img
                src="/images/hero-image.jpg"
                alt="AI assistant transforming messy insurance documents into clear summaries"
                className="rounded-2xl w-full h-auto border border-slate-200 shadow-lg"
              />
              {/* Floating badge */}
              <div className="absolute -bottom-4 -left-4 bg-white rounded-xl shadow-lg border border-slate-100 p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">Policies Analyzed</p>
                  <p className="text-xs text-slate-500">Instant summaries in seconds</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-8 sm:py-10 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4">How It Works</h2>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto">
              Three simple steps to understand any insurance document — no insurance background needed.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {/* Step 1 */}
            <div className="text-center">
              <div className="relative mx-auto w-48 h-48 mb-6 rounded-2xl overflow-hidden border border-slate-200">
                <img
                  src="/images/step1-upload.jpg"
                  alt="Upload PDF, Word, or text files"
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-bold">1</div>
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Upload Your Policy</h3>
              <p className="text-slate-600">Drag and drop your PDF, Word document, or paste the text directly. We support password-protected PDFs too.</p>
            </div>
            {/* Step 2 */}
            <div className="text-center">
              <div className="relative mx-auto w-48 h-48 mb-6 rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-xl bg-white shadow-md flex items-center justify-center mx-auto mb-2">
                    <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  <p className="text-xs text-slate-400">Step 2 Image Placeholder</p>
                </div>
                <div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-bold">2</div>
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">AI Reads the Fine Print</h3>
              <p className="text-slate-600">Our AI extracts coverage details, exclusions, premiums, key dates, and hidden clauses you might have missed.</p>
            </div>
            {/* Step 3 */}
            <div className="text-center">
              <div className="relative mx-auto w-48 h-48 mb-6 rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-xl bg-white shadow-md flex items-center justify-center mx-auto mb-2">
                    <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p className="text-xs text-slate-400">Step 3 Image Placeholder</p>
                </div>
                <div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm font-bold">3</div>
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Get Your Summary</h3>
              <p className="text-slate-600">Receive a clear, structured breakdown. Export to CSV, compare multiple policies, and make informed decisions.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Features / Trust Section */}
      <section className="py-16 sm:py-20 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-6">
                Why Insurance Documents Are So Hard to Read
              </h2>
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">Exclusions Buried in Pages</h3>
                    <p className="text-slate-600">The things you are NOT covered for are often hidden in dense legal paragraphs. Most people never find them until it is too late.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">Key Dates Scattered Everywhere</h3>
                    <p className="text-slate-600">Issue dates, commencement dates, maturity dates, renewal dates — each buried in different sections of a 30-page document.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">Coverage Amounts in Fine Print</h3>
                    <p className="text-slate-600">What you are actually insured for — medical limits, trip cancellation caps, excess amounts — is rarely presented clearly.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="relative">
              <img
                src="/images/feature-illustration.jpg"
                alt="Person overwhelmed by scattered insurance documents and fine print"
                className="rounded-2xl w-full h-auto border border-slate-200 shadow-lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Supported Types */}
      <section className="py-16 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-slate-900 mb-4">All Insurance Types Supported</h2>
            <p className="text-lg text-slate-600">From travel to life insurance — if it is a policy document, we can read it.</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {['Travel Insurance', 'Life Insurance', 'Health Insurance', 'Car Insurance', 'Home Insurance', 'Investment-Linked Policies', 'Personal Accident', 'Corporate Policies'].map((type) => (
              <div key={type} className="bg-slate-50 rounded-xl p-4 text-center border border-slate-100 hover:border-emerald-200 transition-colors">
                <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-slate-700">{type}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Disclaimer Banner */}
      <section className="bg-amber-50 border-y border-amber-200 py-4">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm text-amber-800 font-medium">Important: AI-generated summaries for reference only</p>
            <p className="text-xs text-amber-600 mt-0.5">
              Always verify details with your insurer before making decisions. <a href="/disclaimer" className="underline hover:text-amber-800">Read full disclaimer</a>.
            </p>
          </div>
        </div>
      </section>

      {/* Upload Section */}
      <section id="upload-section" className="py-16 sm:py-20 bg-gradient-to-b from-emerald-50 to-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4">Upload Your Documents</h2>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto">
              Upload up to 5 policies to compare side by side. We accept PDF, Word, and text files.
            </p>
          </div>

          {/* Privacy Banner */}
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-8 flex items-start gap-3">
            <svg className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-emerald-800">Your documents are processed in memory only</p>
              <p className="text-xs text-emerald-600 mt-0.5">Nothing is stored on our servers. Files are deleted immediately after analysis.</p>
            </div>
          </div>

          {/* Document Cards */}
          <div className="space-y-6">
            {documents.map((doc, idx) => (
              <div key={doc.id} className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                {/* Card Header */}
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center text-sm font-bold text-slate-500">
                      {idx + 1}
                    </div>
                    <span className="font-medium text-slate-700">
                      {doc.file ? doc.file.name : 'Select a document'}
                    </span>
                    {doc.analysis && !doc.analysis.raw && (
                      <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-medium">
                        Analyzed
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {doc.analysis && !doc.analysis.raw && (
                      <button
                        onClick={() => exportSingleCsv(doc)}
                        className="p-2 text-slate-400 hover:text-slate-600 transition-colors"
                        title="Download CSV"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => removeDocument(doc.id)}
                      className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                      title="Remove"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Card Body */}
                <div className="p-6">
                  {!doc.file && !doc.analysis && (
                    <div
                      className={`border-2 border-dashed rounded-xl p-10 text-center transition-all ${
                        dragOverId === doc.id
                          ? 'border-emerald-400 bg-emerald-50'
                          : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
                      }`}
                      onDrop={(e) => handleDrop(e, doc.id)}
                      onDragOver={(e) => handleDragOver(e, doc.id)}
                      onDragLeave={handleDragLeave}
                    >
                      <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
                        <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                      </div>
                      <p className="text-base font-medium text-slate-700 mb-1">
                        {dragOverId === doc.id ? 'Drop your file here' : 'Drag & drop or browse'}
                      </p>
                      <p className="text-sm text-slate-500 mb-5">PDF, Word, or text files up to 50MB</p>
                      <label className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors shadow-sm">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                        Choose File
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
                    <div className="p-5 rounded-xl bg-amber-50 border border-amber-200">
                      <div className="flex items-center gap-2 mb-3">
                        <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                        <span className="text-sm font-semibold text-amber-800">Password Required</span>
                      </div>
                      <p className="text-sm text-amber-600 mb-4">This PDF is password-protected. Please enter the password to continue.</p>
                      <div className="flex gap-3">
                        <input
                          type="password"
                          value={doc.password}
                          onChange={(e) => updateDoc(doc.id, { password: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit(doc.id)}
                          placeholder="Enter PDF password"
                          className="flex-1 px-4 py-2.5 bg-white border border-amber-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                        />
                        <button
                          onClick={() => handlePasswordSubmit(doc.id)}
                          className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
                        >
                          Unlock
                        </button>
                        <button
                          onClick={() => {
                            updateDoc(doc.id, { needsPassword: false, password: '', pendingBuffer: null, file: null });
                          }}
                          className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-sm font-medium transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {doc.error && (
                    <div className="mt-4 p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                      {doc.error}
                    </div>
                  )}

                  {/* Loading */}
                  {doc.loading && (
                    <div className="mt-4 flex items-center gap-3 text-sm text-slate-500">
                      <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
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
                  {!doc.file && !doc.analysis && !doc.loading && !doc.needsPassword && (
                    <div className="mt-5">
                      <div className="flex items-center gap-4 mb-3">
                        <div className="h-px flex-1 bg-slate-200" />
                        <span className="text-sm text-slate-400 font-medium">or paste text directly</span>
                        <div className="h-px flex-1 bg-slate-200" />
                      </div>
                      <textarea
                        className="w-full h-28 bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-50 resize-none transition-all"
                        placeholder="Paste your insurance policy text here..."
                        value={doc.extractedText}
                        onChange={(e) => updateDoc(doc.id, { extractedText: e.target.value })}
                      />
                      {doc.extractedText.length > 500 && (
                        <button
                          onClick={() => analyzeDocText(doc.extractedText, doc.id)}
                          className="mt-3 w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold transition-colors"
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
                    <div className="mt-5 p-5 bg-slate-50 border border-slate-200 rounded-xl">
                      <h3 className="text-sm font-semibold text-slate-700 mb-3">AI Analysis (Raw)</h3>
                      <pre className="text-xs text-slate-600 whitespace-pre-wrap overflow-auto max-h-80 bg-white p-4 rounded-lg border border-slate-100">
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
              className="mt-6 w-full py-4 border-2 border-dashed border-slate-300 hover:border-emerald-400 hover:bg-emerald-50 rounded-2xl text-slate-500 hover:text-emerald-600 transition-all flex items-center justify-center gap-2 font-medium"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Another Document ({documents.length}/5)
            </button>
          )}
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 bg-slate-900">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Never Miss What Your Insurance Actually Covers</h2>
          <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
            Thousands of claims are denied every year because policyholders did not understand their coverage. Know exactly what you have — in plain English.
          </p>
          <button
            onClick={() => { document.getElementById('upload-section')?.scrollIntoView({ behavior: 'smooth' }); }}
            className="inline-flex items-center gap-2 px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-base font-semibold transition-colors shadow-lg shadow-emerald-600/25"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Analyze My Policy Now
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid md:grid-cols-3 gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <span className="font-bold text-slate-900">Policy2Summary</span>
              </div>
              <p className="text-sm text-slate-500">AI-powered insurance document reader. Making insurance understandable for everyone.</p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-3">Supported Formats</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li>PDF (including password-protected)</li>
                <li>Microsoft Word (.docx)</li>
                <li>Plain text (.txt)</li>
                <li>Paste text directly</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-3">Important</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li>AI-generated summaries for reference only</li>
                <li>Always verify with your insurer</li>
                <li>Not financial advice</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-slate-100 pt-6 text-center">
            <p className="text-sm text-slate-400 mb-3">
              Policy2Summary — Free tool. No data stored. Documents processed in memory only.
            </p>
            <div className="flex items-center justify-center gap-4 text-sm text-slate-400">
              <a href="/privacy" className="hover:text-slate-600 transition-colors">Privacy Policy</a>
              <span className="text-slate-300">|</span>
              <a href="/terms" className="hover:text-slate-600 transition-colors">Terms of Service</a>
              <span className="text-slate-300">|</span>
              <a href="/disclaimer" className="hover:text-slate-600 transition-colors">Disclaimer</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function AnalysisResults({ analysis }) {
  return (
    <div className="mt-6 space-y-5">
      {/* Summary */}
      <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h3 className="font-semibold text-emerald-800 text-sm">Summary</h3>
        </div>
        <p className="text-slate-700 text-sm leading-relaxed">{analysis.summary}</p>
        <div className="flex flex-wrap gap-2 mt-4">
          {analysis.policy_type && (
            <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-medium">
              {analysis.policy_type}
            </span>
          )}
          {analysis.insurer && (
            <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs">
              {analysis.insurer}
            </span>
          )}
          {analysis.maturity?.type && (
            <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs">
              {analysis.maturity.type}
            </span>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Premium */}
        {analysis.premium && (
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Premium
            </h3>
            <div className="space-y-2 text-sm">
              {analysis.premium.amount && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Amount</span>
                  <span className="text-slate-800 font-semibold">{analysis.premium.amount}</span>
                </div>
              )}
              {analysis.premium.frequency && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Frequency</span>
                  <span className="text-slate-600">{analysis.premium.frequency}</span>
                </div>
              )}
              {analysis.premium.total_annual && (
                <div className="flex justify-between border-t border-slate-100 pt-2 mt-2">
                  <span className="text-slate-500">Annual</span>
                  <span className="text-emerald-600 font-semibold">{analysis.premium.total_annual}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Key Dates */}
        {analysis.key_dates && Object.values(analysis.key_dates).some(Boolean) && (
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Key Dates
            </h3>
            <div className="space-y-2 text-sm">
              {analysis.key_dates.issue_date && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Issued</span>
                  <span className="text-slate-700">{analysis.key_dates.issue_date}</span>
                </div>
              )}
              {analysis.key_dates.commencement_date && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Commences</span>
                  <span className="text-slate-700">{analysis.key_dates.commencement_date}</span>
                </div>
              )}
              {analysis.key_dates.maturity_date && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Matures</span>
                  <span className="text-blue-600 font-medium">{analysis.key_dates.maturity_date}</span>
                </div>
              )}
              {analysis.key_dates.renewal_date && (
                <div className="flex justify-between border-t border-slate-100 pt-2 mt-2">
                  <span className="text-slate-500">Renews</span>
                  <span className="text-amber-600 font-medium">{analysis.key_dates.renewal_date}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Coverage Amounts */}
      {(analysis.coverage?.medical_expenses || analysis.coverage?.trip_cancellation || analysis.coverage?.baggage_loss || analysis.coverage?.personal_accident || analysis.coverage?.travel_delay) && (
        <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-emerald-800 mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Coverage Limits
          </h3>
          <div className="space-y-2.5 text-sm">
            {analysis.coverage.medical_expenses && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Medical Expenses</span>
                <span className="text-slate-900 font-semibold">{analysis.coverage.medical_expenses}</span>
              </div>
            )}
            {analysis.coverage.trip_cancellation && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Trip Cancellation</span>
                <span className="text-slate-900 font-semibold">{analysis.coverage.trip_cancellation}</span>
              </div>
            )}
            {analysis.coverage.baggage_loss && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Baggage Loss</span>
                <span className="text-slate-900 font-semibold">{analysis.coverage.baggage_loss}</span>
              </div>
            )}
            {analysis.coverage.personal_accident && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Personal Accident</span>
                <span className="text-slate-900 font-semibold">{analysis.coverage.personal_accident}</span>
              </div>
            )}
            {analysis.coverage.travel_delay && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Travel Delay</span>
                <span className="text-slate-900 font-semibold">{analysis.coverage.travel_delay}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Coverage Benefits List */}
      {analysis.coverage?.main_benefits?.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Other Coverage
          </h3>
          <ul className="space-y-2">
            {analysis.coverage.main_benefits.map((benefit, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0" />
                <span className="text-slate-700">{benefit}</span>
              </li>
            ))}
          </ul>
          {analysis.coverage.riders?.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs text-slate-500 mb-2 font-medium">Riders</p>
              {analysis.coverage.riders.map((rider, i) => (
                <p key={i} className="text-xs text-slate-600">• {rider}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Car Insurance Coverage */}
      {(analysis.coverage?.vehicle_sum_insured || analysis.coverage?.third_party_liability || analysis.coverage?.own_damage_excess || analysis.coverage?.unnamed_driver_excess || analysis.coverage?.young_driver_excess || analysis.coverage?.windscreen_excess) && (
        <div className="bg-gradient-to-br from-blue-50 to-white border border-blue-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-blue-800 mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Car Coverage & Excess
          </h3>
          <div className="space-y-2.5 text-sm">
            {analysis.coverage.vehicle_sum_insured && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Sum Insured / Market Value</span>
                <span className="text-slate-900 font-semibold">{analysis.coverage.vehicle_sum_insured}</span>
              </div>
            )}
            {analysis.coverage.third_party_liability && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Third-Party Liability</span>
                <span className="text-slate-900 font-semibold">{analysis.coverage.third_party_liability}</span>
              </div>
            )}
            {analysis.coverage.own_damage_excess && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Own Damage Excess</span>
                <span className="text-amber-600 font-semibold">{analysis.coverage.own_damage_excess}</span>
              </div>
            )}
            {analysis.coverage.unnamed_driver_excess && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Unnamed Driver Excess</span>
                <span className="text-amber-600 font-semibold">{analysis.coverage.unnamed_driver_excess}</span>
              </div>
            )}
            {analysis.coverage.young_driver_excess && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Young/Inexperienced Driver Excess</span>
                <span className="text-amber-600 font-semibold">{analysis.coverage.young_driver_excess}</span>
              </div>
            )}
            {analysis.coverage.windscreen_excess && (
              <div className="flex justify-between py-1">
                <span className="text-slate-600">Windscreen Excess</span>
                <span className="text-amber-600 font-semibold">{analysis.coverage.windscreen_excess}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Payout Criteria */}
      {analysis.payout_criteria?.length > 0 && (
        <div className="bg-white border border-emerald-100 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-emerald-700 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            Payout Criteria
          </h3>
          <ul className="space-y-2">
            {analysis.payout_criteria.map((c, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0" />
                <span className="text-slate-700">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Deductibles / Excess */}
      {analysis.deductibles_excess?.length > 0 && (
        <div className="bg-white border border-amber-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-700 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Deductibles & Excess
          </h3>
          <ul className="space-y-2">
            {analysis.deductibles_excess.map((d, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                <span className="text-slate-700">{d}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Exclusions */}
      {analysis.exclusions?.length > 0 && (
        <div className="bg-white border border-red-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-red-700 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Exclusions
          </h3>
          <ul className="space-y-2">
            {analysis.exclusions.map((ex, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 mt-1.5 flex-shrink-0" />
                <span className="text-slate-600">{ex}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ILP */}
      {analysis.investment_linked?.is_ilp && (
        <div className="bg-gradient-to-br from-purple-50 to-white border border-purple-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-purple-700 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            Investment-Linked Details
          </h3>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            {analysis.investment_linked.allocation && (
              <div>
                <span className="text-slate-500">Allocation</span>
                <p className="text-slate-800 mt-0.5">{analysis.investment_linked.allocation}</p>
              </div>
            )}
            {analysis.investment_linked.projected_returns && (
              <div>
                <span className="text-slate-500">Projected Returns</span>
                <p className="text-emerald-600 font-medium mt-0.5">{analysis.investment_linked.projected_returns}</p>
              </div>
            )}
          </div>
          {analysis.investment_linked.funds?.length > 0 && (
            <div className="mt-3">
              <span className="text-xs text-slate-500 mb-2 block">Funds</span>
              <div className="flex flex-wrap gap-1.5">
                {analysis.investment_linked.funds.map((f, i) => (
                  <span key={i} className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Warnings */}
      {analysis.warnings?.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-700 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Important Notes
          </h3>
          <ul className="space-y-2">
            {analysis.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                <span className="text-slate-700">{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
