/**
 * Observer API routes.
 * Mount on main HTTP server at /api/observer/*
 *
 * Provides:
 * - GET /observer/context — current context state
 * - GET /observer/suggestions — top suggestions
 * - POST /observer/suggestions/:id/action — user takes action on suggestion
 * - GET /observer/status — observer status
 * - GET /observer/events — query observation events
 */

import type { Router } from 'express';

import {
  getContextStateDecoded,
} from '@/main/db/repositories/context-state';
import {
  getActiveSuggestions,
  actionSuggestion as actionDb,
  dismissSuggestion as dismissDb,
} from '@/main/db/repositories/suggestions-repo';
import { getObserverStatus } from './service';
import { listObservationEvents } from '@/main/db/repositories/observation-events';

export function setupObserverRoutes(router: Router): void {
  /**
   * GET /api/observer/context
   * Returns current context state.
   */
  router.get('/observer/context', (_req, res) => {
    try {
      const context = getContextStateDecoded();
      res.json(context);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /api/observer/suggestions
   * Returns top active suggestions.
   */
  router.get('/observer/suggestions', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 5, 20);
      const suggestions = getActiveSuggestions(limit);

      res.json(
        suggestions.map((s) => ({
          ...s,
          evidence: JSON.parse(s.evidence ?? '[]'),
        }))
      );
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * POST /api/observer/suggestions/:id/action
   * User acted on a suggestion (convert to task or dismiss).
   */
  router.post('/observer/suggestions/:id/action', (req, res) => {
    try {
      const { id } = req.params;
      const { action } = req.body as { action: 'execute' | 'dismiss' | 'defer' };

      if (action === 'dismiss') {
        const updated = dismissDb(id);
        res.json(updated);
      } else if (action === 'execute') {
        const updated = actionDb(id);
        res.json(updated);
      } else {
        res.status(400).json({ error: 'Invalid action' });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /api/observer/status
   * Returns observer service status.
   */
  router.get('/observer/status', (req, res) => {
    try {
      const status = getObserverStatus();
      res.json({ collectors: status });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /api/observer/events
   * Query observation events.
   * Query params: source, type, limit, offset
   */
  router.get('/observer/events', (req, res) => {
    try {
      const { source, type, limit, offset } = req.query;

      const events = listObservationEvents({
        source: source as string | undefined,
        type: type as string | undefined,
        limit: limit ? parseInt(limit as string) : 100,
        offset: offset ? parseInt(offset as string) : 0,
      });

      res.json(
        events.map((e) => ({
          ...e,
          data: JSON.parse(e.data),
          tags: JSON.parse(e.tags ?? '[]'),
        }))
      );
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
