/**
 * Onboarding step 4 — Claude integration tips.
 *
 * Hands the user two copyable snippets:
 *   1. MCP server config to drop into their Claude Desktop / Claude Code config
 *      (so Claude can call TaskPilot tools).
 *   2. A Cowork mode tip (cowork mode means Claude proposes changes the user
 *      reviews — recommended for any task that lands in the Review queue).
 *
 * Both blocks render in a fixed-width "code" style with a copy button. We
 * don't validate that Claude is installed — this step is informational.
 */

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/renderer/lib/utils';

// Keep this identical to the snippet shown in About.tsx so both screens stay
// in lock-step — one source of truth for "how do I wire Claude up".
const MCP_CONFIG_SNIPPET = `claude mcp add --scope user taskpilot \\
  --command "taskpilot" --args "mcp"`;

const COWORK_TIP_SNIPPET = `# In Claude Code:
# Use "cowork" mode for any TaskPilot task that needs human review.
# Cowork = Claude proposes; you approve before changes land.

claude --mode cowork`;

export interface Step4ClaudeProps {
  /**
   * Optional — historically surfaced as the "MCP path" placeholder. The new
   * snippet doesn't need a path (the CLI shim resolves it), so we just
   * ignore the prop. Kept on the type for backwards compat with callers.
   */
  mcpEntryPath?: string | null;
}

export default function Step4Claude(_props: Step4ClaudeProps): JSX.Element {
  return (
    <section aria-label="onboarding-step-4" className="space-y-6">
      <header className="space-y-2 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Connect Claude</h2>
        <p className="mx-auto max-w-lg text-sm text-muted-foreground">
          TaskPilot exposes an MCP server so Claude (Desktop, Code, or any MCP
          client) can read and write tasks directly. Run this from a terminal
          to register TaskPilot with the Claude CLI.
        </p>
      </header>

      <CodeBlock label="MCP server registration" value={MCP_CONFIG_SNIPPET} />

      <div className="rounded-lg border border-border/50 bg-card/50 p-4 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">Cowork mode tip</p>
        <p>
          For tasks routed to Claude Code, use cowork mode. Claude proposes
          changes and TaskPilot routes the result to your Review queue.
        </p>
      </div>

      <CodeBlock label="Cowork command" value={COWORK_TIP_SNIPPET} />

      <p className="text-center text-xs text-muted-foreground">
        You can come back to these snippets any time from{' '}
        <span className="font-medium">Settings → About</span>.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Copyable code block                                                       */
/* -------------------------------------------------------------------------- */

interface CodeBlockProps {
  label: string;
  value: string;
}

function CodeBlock({ label, value }: CodeBlockProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be unavailable (e.g. older Electron without secure
      // context) — silent failure is fine, the user can select manually.
    }
  };

  return (
    <div className="rounded-lg border border-border/50 bg-card/60">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={() => {
            void copy();
          }}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            'hover:bg-accent',
          )}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs text-foreground/90">
        <code>{value}</code>
      </pre>
    </div>
  );
}
