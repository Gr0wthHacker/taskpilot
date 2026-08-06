/**
 * Morning briefing modal.
 * Shows at 8 AM with daily summary and focus.
 */

import { useState } from 'react';
import type { BriefingContent } from '@/main/observer/briefing-generator';

interface MorningBriefingProps {
  briefing: BriefingContent;
  onDismiss: () => void;
  onViewAll: () => void;
}

export function MorningBriefing({ briefing, onDismiss, onViewAll }: MorningBriefingProps) {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border-b border-amber-200 dark:border-amber-800/50 p-6">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">
            Good morning! ☀️
          </h1>
          <p className="text-slate-600 dark:text-slate-400">
            {briefing.summary}
          </p>
        </div>

        <div className="p-6 space-y-8">
          {/* Yesterday's Work */}
          <section>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
              Yesterday's Work
            </h2>
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-slate-700 dark:text-slate-300">
                <span className="text-2xl">✓</span>
                <span>Completed <strong>{briefing.yesterday.tasks_completed}</strong> task{briefing.yesterday.tasks_completed !== 1 ? 's' : ''}</span>
              </div>
              {briefing.yesterday.files_modified > 0 && (
                <div className="flex items-center gap-3 text-slate-700 dark:text-slate-300">
                  <span className="text-2xl">📝</span>
                  <span>Modified <strong>{briefing.yesterday.files_modified}</strong> file{briefing.yesterday.files_modified !== 1 ? 's' : ''}</span>
                </div>
              )}
              {briefing.yesterday.research_threads.length > 0 && (
                <div className="flex items-center gap-3 text-slate-700 dark:text-slate-300">
                  <span className="text-2xl">🔍</span>
                  <span>Researched: <strong>{briefing.yesterday.research_threads.join(', ')}</strong></span>
                </div>
              )}
            </div>
          </section>

          {/* Today's Focus */}
          <section>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
              Today's Suggested Focus
            </h2>
            <div className="space-y-3">
              {briefing.today.suggestions.map((s) => (
                <div
                  key={s.rank}
                  className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {s.rank}. {s.title}
                      </div>
                      <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                        {s.estimated_minutes} minutes
                      </div>
                    </div>
                    <div className="text-2xl">→</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Overnight Changes */}
          {(briefing.overnight_changes.new_comments_on_prs > 0 ||
            briefing.overnight_changes.new_issues > 0 ||
            briefing.overnight_changes.deployed_changes) && (
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
                What Changed Overnight
              </h2>
              <div className="space-y-2">
                {briefing.overnight_changes.new_comments_on_prs > 0 && (
                  <div className="flex items-center gap-3 text-slate-700 dark:text-slate-300">
                    <span>💬</span>
                    <span>{briefing.overnight_changes.new_comments_on_prs} new comment{briefing.overnight_changes.new_comments_on_prs !== 1 ? 's' : ''} on your PRs</span>
                  </div>
                )}
                {briefing.overnight_changes.new_issues > 0 && (
                  <div className="flex items-center gap-3 text-slate-700 dark:text-slate-300">
                    <span>⚠️</span>
                    <span>{briefing.overnight_changes.new_issues} new issue{briefing.overnight_changes.new_issues !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {briefing.overnight_changes.deployed_changes && (
                  <div className="flex items-center gap-3 text-slate-700 dark:text-slate-300">
                    <span>🚀</span>
                    <span>Changes deployed</span>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-slate-200 dark:border-slate-700 p-6 flex gap-3 justify-end bg-slate-50 dark:bg-slate-800/50">
          <button
            onClick={() => {
              setVisible(false);
              onDismiss();
            }}
            className="px-4 py-2 rounded text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            Got it
          </button>
          <button
            onClick={() => {
              setVisible(false);
              onViewAll();
            }}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            View All Suggestions
          </button>
        </div>
      </div>
    </div>
  );
}
