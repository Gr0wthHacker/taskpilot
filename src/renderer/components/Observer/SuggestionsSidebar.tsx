/**
 * "What's Next?" sidebar showing top suggestions.
 */

import { useEffect, useState } from 'react';
import type { Suggestion } from '@/shared/schema-v2';

interface SuggestionsSidebarProps {
  onExecute: (id: string) => void;
  onDismiss: (id: string) => void;
}

export function SuggestionsSidebar({ onExecute, onDismiss }: SuggestionsSidebarProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSuggestions = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/observer/suggestions?limit=5', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('api_token') || ''}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setSuggestions(data);
      }
    } catch (err) {
      console.debug('Failed to fetch suggestions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSuggestions();
    // Refresh every minute
    const interval = setInterval(fetchSuggestions, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-80 border-l border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-700">
        <h2 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <span>💡</span>
          What's Next?
        </h2>
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
          Suggested based on your work
        </p>
      </div>

      {/* Suggestions List */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 text-center text-slate-600 dark:text-slate-400">
            Loading...
          </div>
        )}

        {!loading && suggestions.length === 0 && (
          <div className="p-4 text-center text-slate-600 dark:text-slate-400">
            <div className="text-sm">No suggestions yet.</div>
            <div className="text-xs mt-1">Keep working — suggestions will appear as context builds.</div>
          </div>
        )}

        {suggestions.map((suggestion) => {
          const typeEmoji = {
            next_step: '⚡',
            related_research: '🔍',
            risk: '⚠️',
            connection: '🔗',
          }[suggestion.type] || '💡';

          const urgencyColor = {
            high: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
            medium: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
            low: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
          }[suggestion.urgency] || 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';

          return (
            <div
              key={suggestion.id}
              className="p-3 border-b border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 transition-colors group"
            >
              <div className="flex items-start gap-2">
                <span className="text-lg flex-shrink-0">{typeEmoji}</span>
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-white truncate group-hover:text-blue-600 dark:group-hover:text-blue-400">
                    {suggestion.title}
                  </h4>
                  {suggestion.description && (
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">
                      {suggestion.description}
                    </p>
                  )}
                  <div className="flex gap-2 mt-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${urgencyColor}`}>
                      {suggestion.urgency}
                    </span>
                    {suggestion.estimated_minutes && (
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                        {suggestion.estimated_minutes} min
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex gap-2 mt-3 ml-6">
                <button
                  onClick={() => onExecute(suggestion.id)}
                  className="flex-1 px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                >
                  Do It
                </button>
                <button
                  onClick={() => onDismiss(suggestion.id)}
                  className="flex-1 px-2 py-1 text-xs rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-700 text-center text-xs">
        <button
          onClick={fetchSuggestions}
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
