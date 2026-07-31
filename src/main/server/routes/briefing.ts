/**
 * `/api/briefing/...` routes — morning brief read + regenerate surface.
 *
 *   GET    /api/briefing/morning           → cached markdown (regenerates when missing)
 *   POST   /api/briefing/morning/regenerate → force a fresh render
 */

import { Router } from 'express';

import {
  generateMorningBrief,
  isMorningBriefDue,
  morningBriefPath,
  readMorningBrief,
} from '@/main/briefing/morning-brief';
import {
  generateSelfProfile,
  isSelfProfileDue,
  readSelfProfile,
  selfProfilePath,
} from '@/main/self-profile';

import { asyncHandler } from '../middleware';

export function briefingRouter(): Router {
  const router = Router();

  router.get(
    '/morning',
    asyncHandler(async (_req, res) => {
      let markdown = await readMorningBrief();
      let regenerated = false;
      if (markdown === null || isMorningBriefDue()) {
        const result = await generateMorningBrief();
        markdown = result.markdown;
        regenerated = true;
      }
      res.json({
        markdown,
        path: morningBriefPath(),
        regenerated,
        is_due: isMorningBriefDue(),
      });
    }),
  );

  router.post(
    '/morning/regenerate',
    asyncHandler(async (_req, res) => {
      const result = await generateMorningBrief();
      res.json({
        markdown: result.markdown,
        path: result.path,
        date: result.date,
        bytes: result.bytes,
      });
    }),
  );

  router.get(
    '/self-profile',
    asyncHandler(async (_req, res) => {
      let markdown = await readSelfProfile();
      let regenerated = false;
      if (markdown === null || isSelfProfileDue()) {
        const result = await generateSelfProfile();
        markdown = result.markdown;
        regenerated = true;
      }
      res.json({
        markdown,
        path: selfProfilePath(),
        regenerated,
        is_due: isSelfProfileDue(),
      });
    }),
  );

  router.post(
    '/self-profile/regenerate',
    asyncHandler(async (_req, res) => {
      const result = await generateSelfProfile();
      res.json({
        markdown: result.markdown,
        path: result.path,
        date: result.date,
        bytes: result.bytes,
      });
    }),
  );

  return router;
}
