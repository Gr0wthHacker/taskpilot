/**
 * `/api/tasks/:id/attachments/...` routes (Wave 13).
 *
 * Multipart upload + download for per-task file attachments. Storage and
 * metadata are owned by `@/main/attachments`; this module is a thin HTTP
 * skin around it.
 *
 * Endpoints:
 *   POST   /api/tasks/:id/attachments         (multipart/form-data)
 *   GET    /api/tasks/:id/attachments         → list metadata
 *   GET    /api/tasks/:id/attachments/:filename → download bytes
 *   DELETE /api/tasks/:id/attachments/:filename → remove
 *
 * We deliberately avoid pulling in `multer` so the dep tree stays slim — the
 * inline RFC 7578 parser at the bottom of this file handles the body. It's
 * scoped to UTF-8 form names + binary content, which is everything a drag-
 * drop UI sends.
 */

import { Router, type Request, type Response } from 'express';

import { taskIdSchema } from '@/shared/io-schemas';
import {
  AttachmentError,
  deleteAttachment,
  listAttachments,
  readAttachmentBytes,
  readAttachmentLimits,
  saveAttachment,
  sanitizeAttachmentFilename,
} from '@/main/attachments';
import { extractAttachmentText } from '@/main/attachments/extract';
import type { Attachment } from '@/shared/types';

import { ApiHttpError } from '../errors';
import { asyncHandler } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function assertValidId(id: string): void {
  const parsed = taskIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${id}`);
  }
}

function attachmentErrorToHttp(err: AttachmentError): ApiHttpError {
  switch (err.code) {
    case 'not_found':
      return new ApiHttpError(404, 'not_found', err.message);
    case 'invalid_filename':
    case 'invalid_task_id':
      return new ApiHttpError(400, err.code, err.message);
    case 'file_too_large':
      return new ApiHttpError(413, 'payload_too_large', err.message);
    case 'task_quota_exceeded':
      return new ApiHttpError(413, 'task_quota_exceeded', err.message);
    default:
      return new ApiHttpError(500, 'internal_error', err.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Inline multipart/form-data parser                                         */
/* -------------------------------------------------------------------------- */

interface UploadedFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/**
 * Read the raw request body into a single Buffer. Capped at `limit` bytes —
 * we don't want a malicious client to OOM the server by streaming forever.
 */
function readRawBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        req.removeListener('data', onData);
        reject(
          new ApiHttpError(
            413,
            'payload_too_large',
            `Upload exceeds limit (${limit} bytes)`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Extract a quoted or bare token from a Content-* header parameter list.
 * Returns null when the parameter is absent.
 */
function headerParam(value: string, name: string): string | null {
  const lc = value.toLowerCase();
  const idx = lc.indexOf(`${name}=`);
  if (idx === -1) return null;
  let cursor = idx + name.length + 1;
  if (value[cursor] === '"') {
    const end = value.indexOf('"', cursor + 1);
    if (end === -1) return null;
    return value.slice(cursor + 1, end);
  }
  const end = value.indexOf(';', cursor);
  return value.slice(cursor, end === -1 ? undefined : end).trim();
}

/**
 * Parse a single multipart part into a file or skip when the part is just a
 * form field. Returns `null` when the part has no filename (i.e. it's a
 * plain `name=value` field — we ignore those for upload routes).
 */
function parsePart(buffer: Buffer): UploadedFile | null {
  // Headers end at the first CRLF CRLF.
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const headerText = buffer.slice(0, headerEnd).toString('utf8');
  let body = buffer.slice(headerEnd + 4);
  // RFC 7578: each part body ends with a trailing CRLF before the next
  // delimiter. Strip it so we don't append two stray bytes to every file.
  if (
    body.length >= 2 &&
    body[body.length - 2] === 0x0d &&
    body[body.length - 1] === 0x0a
  ) {
    body = body.slice(0, body.length - 2);
  }

  let disposition = '';
  let contentType = 'application/octet-stream';
  for (const rawLine of headerText.split('\r\n')) {
    const colon = rawLine.indexOf(':');
    if (colon === -1) continue;
    const name = rawLine.slice(0, colon).trim().toLowerCase();
    const value = rawLine.slice(colon + 1).trim();
    if (name === 'content-disposition') disposition = value;
    else if (name === 'content-type') contentType = value;
  }
  if (!disposition.toLowerCase().includes('form-data')) return null;
  const fieldName = headerParam(disposition, 'name') ?? '';
  const filename = headerParam(disposition, 'filename');
  if (filename === null) return null;
  return {
    fieldName,
    filename,
    contentType,
    data: body,
  };
}

/**
 * Parse a `multipart/form-data` request body. Returns the file parts (form
 * fields without filenames are dropped — this is an upload route, not a
 * generic form sink).
 */
async function parseMultipart(
  req: Request,
  limit: number,
): Promise<UploadedFile[]> {
  const contentType = req.headers['content-type'] ?? '';
  const boundary = headerParam(contentType, 'boundary');
  if (!boundary) {
    throw new ApiHttpError(
      400,
      'invalid_multipart',
      'Missing multipart boundary',
    );
  }
  const raw = await readRawBody(req, limit);
  const delimiter = Buffer.from(`--${boundary}`);
  const closing = Buffer.from(`--${boundary}--`);
  const out: UploadedFile[] = [];
  let cursor = raw.indexOf(delimiter);
  if (cursor === -1) return out;
  cursor += delimiter.length;
  // Skip CRLF after the delimiter on the first part.
  if (raw[cursor] === 0x0d && raw[cursor + 1] === 0x0a) cursor += 2;

  while (cursor < raw.length) {
    const next = raw.indexOf(delimiter, cursor);
    if (next === -1) break;
    // Part runs from cursor up to next delimiter; strip the trailing CRLF
    // that precedes the boundary.
    let partEnd = next;
    if (
      partEnd >= 2 &&
      raw[partEnd - 2] === 0x0d &&
      raw[partEnd - 1] === 0x0a
    ) {
      partEnd -= 2;
    }
    const partBuf = raw.slice(cursor, partEnd);
    const parsed = parsePart(partBuf);
    if (parsed) out.push(parsed);
    // Is the next boundary the closing one?
    const after = raw.slice(next, next + closing.length);
    if (after.equals(closing)) break;
    cursor = next + delimiter.length;
    if (raw[cursor] === 0x0d && raw[cursor + 1] === 0x0a) cursor += 2;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function attachmentsRouter(): Router {
  const router = Router({ mergeParams: true });

  // POST /api/tasks/:id/attachments ----------------------------------------
  // Multipart upload. Accepts one or more files in any field name; the
  // sanitized filename wins over field name. Returns the list of saved
  // metadata.
  router.post(
    '/:id/attachments',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      assertValidId(id);

      const limits = readAttachmentLimits();
      // Cap the parsed body at the per-task quota + a small fudge for
      // multipart framing — anything bigger is by definition over budget.
      const bodyCap = limits.maxTaskBytes + 64 * 1024;
      let files: UploadedFile[];
      try {
        files = await parseMultipart(req, bodyCap);
      } catch (err) {
        if (err instanceof ApiHttpError) throw err;
        throw new ApiHttpError(
          400,
          'invalid_multipart',
          err instanceof Error ? err.message : 'Failed to parse upload',
        );
      }
      if (files.length === 0) {
        throw new ApiHttpError(
          400,
          'no_files',
          'No file parts found in upload',
        );
      }

      const saved: Attachment[] = [];
      for (const file of files) {
        try {
          const result = await saveAttachment({
            taskId: id,
            filename: file.filename,
            data: file.data,
            contentType: file.contentType,
          });
          saved.push({
            filename: result.filename,
            size_bytes: result.size_bytes,
            content_type: result.content_type,
            added_at: result.added_at,
          });
        } catch (err) {
          if (err instanceof AttachmentError) {
            throw attachmentErrorToHttp(err);
          }
          throw err;
        }
      }
      res.status(201).json({ ok: true, attachments: saved });
    }),
  );

  // GET /api/tasks/:id/attachments -----------------------------------------
  router.get(
    '/:id/attachments',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      try {
        const attachments = listAttachments(id);
        res.json({ attachments });
      } catch (err) {
        if (err instanceof AttachmentError) throw attachmentErrorToHttp(err);
        throw err;
      }
    }),
  );

  // GET /api/tasks/:id/attachments/:filename -------------------------------
  router.get(
    '/:id/attachments/:filename',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const filename = sanitizeAttachmentFilename(String(req.params.filename));
      // If sanitization changed the filename, the caller asked for something
      // unsafe — refuse rather than silently substitute.
      if (filename !== String(req.params.filename)) {
        throw new ApiHttpError(
          400,
          'invalid_filename',
          'Filename contains disallowed characters',
        );
      }
      try {
        const { data, meta } = await readAttachmentBytes(id, filename);
        res.setHeader('Content-Type', meta.content_type);
        res.setHeader('Content-Length', String(data.byteLength));
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${meta.filename}"`,
        );
        res.status(200).end(data);
      } catch (err) {
        if (err instanceof AttachmentError) throw attachmentErrorToHttp(err);
        throw err;
      }
    }),
  );

  // GET /api/tasks/:id/attachments/:filename/text -------------------------
  // Returns extracted plain text from PDF/DOCX/XLSX/CSV/text attachments.
  // Cached after the first read; subsequent calls are a single file read.
  router.get(
    '/:id/attachments/:filename/text',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const filename = sanitizeAttachmentFilename(String(req.params.filename));
      if (filename !== String(req.params.filename)) {
        throw new ApiHttpError(
          400,
          'invalid_filename',
          'Filename contains disallowed characters',
        );
      }
      try {
        // Verify the attachment exists first — extractAttachmentText returns
        // a structured failure rather than 404ing, and we want the route to
        // distinguish "no such attachment" (404) from "exists but unparseable"
        // (200 with ok: false).
        const list = listAttachments(id);
        if (!list.some((a) => a.filename === filename)) {
          throw new ApiHttpError(
            404,
            'not_found',
            `Attachment ${filename} not found on task ${id}`,
          );
        }
        const result = await extractAttachmentText(id, filename);
        res.json({
          ok: result.ok,
          filename,
          format: result.format,
          byte_length: result.byte_length,
          truncated: result.truncated,
          cached: result.cached,
          reason: result.reason,
          text: result.text,
        });
      } catch (err) {
        if (err instanceof ApiHttpError) throw err;
        if (err instanceof AttachmentError) throw attachmentErrorToHttp(err);
        throw err;
      }
    }),
  );

  // DELETE /api/tasks/:id/attachments/:filename ----------------------------
  router.delete(
    '/:id/attachments/:filename',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const filename = sanitizeAttachmentFilename(String(req.params.filename));
      if (filename !== String(req.params.filename)) {
        throw new ApiHttpError(
          400,
          'invalid_filename',
          'Filename contains disallowed characters',
        );
      }
      try {
        await deleteAttachment(id, filename);
        res.json({ ok: true, filename });
      } catch (err) {
        if (err instanceof AttachmentError) throw attachmentErrorToHttp(err);
        throw err;
      }
    }),
  );

  return router;
}
