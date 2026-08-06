/**
 * Toast notification for high-urgency suggestions.
 * Shows at most 1 per 15 minutes.
 */

import { useEffect, useState } from 'react';
import type { Suggestion } from '@/shared/schema-v2';

interface SuggestionToastProps {
  suggestion: Suggestion;
  onDismiss: (id: string) => void;
  onExecute: (id: string) => void;
}

export function SuggestionToast({ suggestion, onDismiss, onExecute }: SuggestionToastProps) {
  const [visible, setVisible] = useState(true);

  // Auto-dismiss after 8 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
    }, 8000);

    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const urgencyColor = {
    high: 'bg-red-500',
    medium: 'bg-yellow-500',
    low: 'bg-blue-500',
  }[suggestion.urgency] || 'bg-blue-500';

  return (
    <div className="fixed bottom-6 right-6 max-w-md animate-in slide-in-from-bottom-4 duration-300 z-50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className={`h-1 ${urgencyColor}`} />
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h3 className="font-semibold text-slate-900 dark:text-white mb-1">
                {suggestion.title}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {suggestion.description}
              </p>
              <div className="flex gap-2 mt-3">
                <span className={`text-xs px-2 py-1 rounded ${
                  suggestion.urgency === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' :
                  suggestion.urgency === 'medium' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300' :
                  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                }`}>
                  {suggestion.urgency}
                </span>
                {suggestion.estimated_minutes && (
                  <span className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    {suggestion.estimated_minutes} min
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => {
                setVisible(false);
                onDismiss(suggestion.id);
              }}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            >
              ✕
            </button>
          </div>

          <div className="flex gap-2 mt-4">
            <button
              onClick={() => {
                setVisible(false);
                onExecute(suggestion.id);
              }}
              className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
            >
              Do It
            </button>
            <button
              onClick={() => {
                setVisible(false);
                onDismiss(suggestion.id);
              }}
              className="flex-1 px-3 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded text-sm font-medium transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
