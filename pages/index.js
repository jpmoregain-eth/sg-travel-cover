import React, { useState } from 'react';
import Head from 'next/head';

const QUESTIONS = [
  {
    id: 'destination',
    label: 'Where are you going?',
    options: ['Asia', 'Schengen/Europe', 'USA/Canada', 'Australia/NZ', 'Worldwide']
  },
  {
    id: 'duration',
    label: 'Trip duration?',
    options: ['1-7 days', '1-2 weeks', '2-4 weeks', '1-3 months', 'Annual multi-trip']
  },
  {
    id: 'age',
    label: 'Age group?',
    options: ['18-30', '31-50', '51-65', '65+']
  },
  {
    id: 'medical',
    label: 'Pre-existing medical conditions?',
    options: ['No', 'Yes — need coverage']
  },
  {
    id: 'adventure',
    label: 'Adventure / extreme sports?',
    options: ['No', 'Yes — need coverage']
  },
  {
    id: 'budget',
    label: 'Budget priority?',
    options: ['Cheapest price', 'Best coverage', 'Balanced']
  }
];

const PLANS = [
  {
    provider: 'FWD',
    plan: 'Premium',
    price: 68,
    destinations: ['Asia', 'Schengen/Europe', 'USA/Canada', 'Australia/NZ', 'Worldwide'],
    durations: ['1-7 days', '1-2 weeks', '2-4 weeks', '1-3 months', 'Annual multi-trip'],
    ageMax: 99,
    preExisting: false,
    adventure: true,
    medicalCover: 1000000,
    cancelCover: 10000,
    baggageCover: 5000,
    url: 'https://www.fwd.com.sg/travel-insurance/',
    rating: 4.5
  },
  {
    provider: 'MSIG',
    plan: 'TravelEasy Elite',
    price: 95,
    destinations: ['Asia', 'Schengen/Europe', 'USA/Canada', 'Australia/NZ', 'Worldwide'],
    durations: ['1-7 days', '1-2 weeks', '2-4 weeks', '1-3 months', 'Annual multi-trip'],
    ageMax: 99,
    preExisting: true,
    adventure: true,
    medicalCover: 1000000,
    cancelCover: 15000,
    baggageCover: 7000,
    url: 'https://www.msig.com.sg/personal/travel-insurance',
    rating: 4.7
  },
  {
    provider: 'Income',
    plan: 'Travel Insurance Classic',
    price: 55,
    destinations: ['Asia', 'Schengen/Europe', 'USA/Canada', 'Australia/NZ', 'Worldwide'],
    durations: ['1-7 days', '1-2 weeks', '2-4 weeks', '1-3 months', 'Annual multi-trip'],
    ageMax: 99,
    preExisting: false,
    adventure: false,
    medicalCover: 500000,
    cancelCover: 5000,
    baggageCover: 3000,
    url: 'https://www.income.com.sg/travel-insurance',
    rating: 4.3
  },
  {
    provider: 'Allianz',
    plan: 'Travel Silver',
    price: 72,
    destinations: ['Asia', 'Schengen/Europe', 'USA/Canada', 'Australia/NZ', 'Worldwide'],
    durations: ['1-7 days', '1-2 weeks', '2-4 weeks', '1-3 months', 'Annual multi-trip'],
    ageMax: 99,
    preExisting: false,
    adventure: false,
    medicalCover: 750000,
    cancelCover: 10000,
    baggageCover: 5000,
    url: 'https://www.allianztravel.com.sg/',
    rating: 4.4
  },
  {
    provider: 'Singlife',
    plan: 'Travel Plus',
    price: 62,
    destinations: ['Asia', 'Schengen/Europe', 'USA/Canada', 'Australia/NZ', 'Worldwide'],
    durations: ['1-7 days', '1-2 weeks', '2-4 weeks', '1-3 months'],
    ageMax: 99,
    preExisting: false,
    adventure: true,
    medicalCover: 500000,
    cancelCover: 10000,
    baggageCover: 5000,
    url: 'https://singlife.com/en/travel-insurance.html',
    rating: 4.2
  }
];

export default function TravelInsuranceFinder() {
  const [answers, setAnswers] = useState({});
  const [showResults, setShowResults] = useState(false);

  const toggleAnswer = (questionId, option) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: prev[questionId] === option ? null : option
    }));
  };

  const allAnswered = QUESTIONS.every(q => answers[q.id]);

  const getMatchingPlans = () => {
    let matched = PLANS.filter(plan => {
      if (answers.destination && !plan.destinations.includes(answers.destination)) return false;
      if (answers.duration && !plan.durations.includes(answers.duration)) return false;
      if (answers.medical === 'Yes — need coverage' && !plan.preExisting) return false;
      if (answers.adventure === 'Yes — need coverage' && !plan.adventure) return false;
      return true;
    });

    if (answers.budget === 'Cheapest price') {
      matched.sort((a, b) => a.price - b.price);
    } else if (answers.budget === 'Best coverage') {
      matched.sort((a, b) => b.medicalCover - a.medicalCover);
    }

    return matched;
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <Head>
        <title>SG Travel Insurance Finder</title>
        <meta name="description" content="Compare travel insurance in Singapore" />
      </Head>

      <div className="bg-slate-900 text-white py-12 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-3xl font-bold mb-3">Find the Best Travel Insurance</h1>
          <p className="text-slate-300">Compare plans from Singapore's top providers</p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8">
        {!showResults && QUESTIONS.map(q => (
          <div key={q.id} className="mb-8">
            <h2 className="text-lg font-semibold text-slate-800 mb-3">{q.label}</h2>
            <div className="flex flex-wrap gap-2">
              {q.options.map(opt => (
                <button
                  key={opt}
                  onClick={() => toggleAnswer(q.id, opt)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                    answers[q.id] === opt
                      ? 'bg-slate-900 text-white shadow-md'
                      : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-400'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        ))}

        {!showResults && (
          <button
            onClick={() => setShowResults(true)}
            disabled={!allAnswered}
            className={`w-full py-4 rounded-xl font-semibold text-lg transition-all ${
              allAnswered
                ? 'bg-emerald-500 text-white hover:bg-emerald-600 shadow-lg'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            {allAnswered ? 'Show Matching Plans' : 'Answer all questions above'}
          </button>
        )}

        {showResults && (
          <div>
            {/* Disclaimer - shown on results page */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
              <p className="text-sm text-amber-800">
                <strong>Data snapshotted 2-3 May 2026.</strong> We extract coverage details from insurer prospectuses during the first 2-3 days of each month. Insurance companies may update products anytime. Always verify current terms directly with the provider before purchasing. This site does not constitute financial or insurance advice.
              </p>
            </div>

            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-slate-800">
                {getMatchingPlans().length} plans match your criteria
              </h2>
              <button
                onClick={() => { setShowResults(false); setAnswers({}); }}
                className="text-slate-500 hover:text-slate-700 text-sm"
              >
                Start over
              </button>
            </div>

            {getMatchingPlans().map(plan => (
              <div key={`${plan.provider}-${plan.plan}`} className="bg-white rounded-xl p-6 mb-4 shadow-sm border border-slate-100">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-bold text-slate-800">{plan.provider}</h3>
                    <p className="text-slate-500 text-sm">{plan.plan}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-emerald-600">S${plan.price}</p>
                    <p className="text-xs text-slate-400">est. for 1 week</p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="bg-slate-50 rounded-lg p-3 text-center">
                    <p className="text-lg font-semibold text-slate-700">{(plan.medicalCover/1000000).toFixed(1)}M</p>
                    <p className="text-xs text-slate-400">Medical</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 text-center">
                    <p className="text-lg font-semibold text-slate-700">{(plan.cancelCover/1000).toFixed(0)}K</p>
                    <p className="text-xs text-slate-400">Trip Cancel</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 text-center">
                    <p className="text-lg font-semibold text-slate-700">{(plan.baggageCover/1000).toFixed(0)}K</p>
                    <p className="text-xs text-slate-400">Baggage</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 mb-4">
                  {plan.preExisting && (
                    <span className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded">Pre-existing ✓</span>
                  )}
                  {plan.adventure && (
                    <span className="text-xs bg-orange-50 text-orange-600 px-2 py-1 rounded">Adventure sports ✓</span>
                  )}
                  <span className="text-xs bg-yellow-50 text-yellow-600 px-2 py-1 rounded">⭐ {plan.rating}</span>
                </div>

                <a
                  href={plan.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center py-3 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 transition-colors"
                >
                  View on {plan.provider} →
                </a>
              </div>
            ))}
          </div>
        )}

        {/* Footer disclaimer */}
        <div className="mt-12 pt-8 border-t border-slate-200">
          <div className="text-center mb-4">
            <p className="text-xs text-slate-400">
              <strong>Data snapshotted 2-3 May 2026.</strong> We extract coverage details from insurer prospectuses during the first 2-3 days of each month. Insurance companies may update products, coverage, or pricing at any time. Always verify current terms directly with the provider before purchasing.
            </p>
          </div>
          <p className="text-center text-slate-400 text-xs">
            This website is a comparison tool only. We are not an insurance broker or agent. This does not constitute financial or insurance advice.
          </p>
        </div>
      </div>
    </div>
  );
}
