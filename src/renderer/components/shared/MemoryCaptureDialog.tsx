/**
 * Quick-capture dialog for the memory subsystem.
 *
 * Three modes the user can flip between:
 *  - **Text** — paste anything. The largest free-form area; submits the raw
 *    body to `/api/memory` with kind='text'.
 *  - **URL** — paste a URL. Server fetches the page and stores the markdown.
 *  - **Snippet** — paste text WITH an optional source URL (e.g. "I copied
 *    this paragraph from <link>"). Stored as text but the source is preserved.
 *
 * Tags are optional. Title is optional — Claude fills it in during enrichment
 * if the user leaves it blank.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Textarea } from '@/renderer/components/ui/textarea';
import { useToast } from '@/renderer/components/ui/use-toast';
import { useCaptureMemory } from '@/renderer/lib/query';
import { ApiError } from '@/renderer/lib/api';

interface MemoryCaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-select the kind when the dialog opens — used by command-palette entries. */
  initialKind?: 'text' | 'url';
  /** Pre-fill content (e.g., from clipboard). */
  initialContent?: string;
}

export function MemoryCaptureDialog({
  open,
  onOpenChange,
  initialKind = 'text',
  initialContent = '',
}: MemoryCaptureDialogProps): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const capture = useCaptureMemory();

  const [kind, setKind] = useState<'text' | 'url'>(initialKind);
  const [content, setContent] = useState(initialContent);
  const [title, setTitle] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  // Reset when the dialog re-opens — we want a clean form each time.
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setContent(initialContent);
      setTitle('');
      setTagsInput('');
    }
  }, [open, initialKind, initialContent]);

  const placeholder =
    kind === 'url'
      ? 'https://example.com/article'
      : 'Paste anything — text, a quote, an idea…';

  const submit = async (): Promise<void> => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'))
      .filter((t) => t.length > 0 && t.length <= 64)
      .slice(0, 12);

    try {
      const res = await capture.mutateAsync({
        kind,
        ...(kind === 'url' ? { url: trimmed } : { content: trimmed }),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      });
      toast({
        title: 'Captured',
        description:
          res.item.title ??
          (res.item.summary ?? trimmed.slice(0, 80) + (trimmed.length > 80 ? '…' : '')),
      });
      onOpenChange(false);
      // Navigate to the detail so the user can watch enrichment land in real time.
      navigate(`/memory/${res.item.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.body) {
        const body = err.body as { error?: { code?: string; details?: { existing_id?: string } } };
        if (body.error?.code === 'duplicate' && body.error.details?.existing_id) {
          const existingId = body.error.details.existing_id;
          toast({
            title: 'Already captured',
            description: 'Opening the existing item.',
          });
          onOpenChange(false);
          navigate(`/memory/${existingId}`);
          return;
        }
      }
      toast({
        title: 'Capture failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" aria-label="memory-capture-dialog">
        <DialogHeader>
          <DialogTitle>Capture to memory</DialogTitle>
          <DialogDescription>
            Drop in text or a URL. The AI summarises, tags, and links it to
            related items in the background.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className={`rounded-md border px-3 py-1.5 transition-colors ${
                kind === 'text'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setKind('text')}
              aria-label="memory-kind-text"
            >
              Text
            </button>
            <button
              type="button"
              className={`rounded-md border px-3 py-1.5 transition-colors ${
                kind === 'url'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setKind('url')}
              aria-label="memory-kind-url"
            >
              URL
            </button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="memory-content" className="text-xs">
              {kind === 'url' ? 'URL' : 'Content'}
            </Label>
            {kind === 'url' ? (
              <Input
                id="memory-content"
                type="url"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={placeholder}
                aria-label="memory-content-input"
              />
            ) : (
              <Textarea
                id="memory-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={placeholder}
                rows={10}
                aria-label="memory-content-input"
                className="font-mono text-sm"
              />
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="memory-title" className="text-xs">
                Title (optional)
              </Label>
              <Input
                id="memory-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to AI-derived title"
                aria-label="memory-title-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memory-tags" className="text-xs">
                Tags (comma-separated)
              </Label>
              <Input
                id="memory-tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="b2b-saas, pricing, idea"
                aria-label="memory-tags-input"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            aria-label="memory-capture-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={capture.isPending || content.trim().length === 0}
            aria-label="memory-capture-submit"
          >
            {capture.isPending ? 'Capturing…' : 'Capture'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
