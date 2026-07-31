/**
 * Text extraction for knowledge resources.
 *
 * Plain-text formats (.md/.txt/.csv/.json) are read natively in Node. Binary
 * decks (.pptx/.pdf/.docx) are handed to a short inline Python program that
 * uses python-pptx / pypdf / python-docx. We pass the Python source via
 * `-c` so there's no separate script file to locate at runtime.
 *
 * Everything degrades gracefully: if Python or a parser lib is missing, we
 * return `{ extracted: false }` with a reason rather than throwing, so a
 * missing toolchain never breaks indexing (the file is still cataloged by
 * filename).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const NATIVE_TEXT_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
]);

const PYTHON_EXT = new Set(['.pdf', '.docx', '.pptx']);

/** Python commands to try, in order. */
const PYTHON_CMDS = ['python', 'python3', 'py'];

/** Cap extracted text so a giant deck can't blow up the catalog/sidecar. */
const MAX_EXTRACT_CHARS = 200_000;

export interface ExtractResult {
  text: string;
  extracted: boolean;
  /** 'native' | 'python' | 'unsupported' | 'missing_dep' | 'no_python' | 'error' */
  reason: string;
  /** Parser lib name when reason === 'missing_dep'. */
  missing_dep?: string;
}

/** The inline Python extractor. Reads argv[1], prints text to stdout. */
const PY_EXTRACTOR = `
import sys
p = sys.argv[1]
ext = p.lower().rsplit('.', 1)[-1] if '.' in p else ''
parts = []
try:
    if ext == 'pdf':
        from pypdf import PdfReader
        for page in PdfReader(p).pages:
            parts.append(page.extract_text() or '')
    elif ext == 'docx':
        import docx
        for para in docx.Document(p).paragraphs:
            parts.append(para.text)
    elif ext == 'pptx':
        from pptx import Presentation
        for slide in Presentation(p).slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        parts.append(''.join(r.text for r in para.runs))
    else:
        sys.stderr.write('UNSUPPORTED')
        sys.exit(3)
except ImportError as e:
    sys.stderr.write('MISSING_DEP:' + (getattr(e, 'name', '') or str(e)))
    sys.exit(4)
except Exception as e:
    sys.stderr.write('ERROR:' + str(e))
    sys.exit(5)
sys.stdout.write('\\n'.join(parts))
`.trim();

function clamp(text: string): string {
  return text.length > MAX_EXTRACT_CHARS ? text.slice(0, MAX_EXTRACT_CHARS) : text;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: NodeJS.ErrnoException | null;
}

function runPython(cmd: string, filePath: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      ['-c', PY_EXTRACTOR, filePath],
      {
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        resolve({
          code: e && typeof e.code === 'number' ? e.code : err ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          spawnError: e && e.code === 'ENOENT' ? e : null,
        });
      },
    );
  });
}

async function extractViaPython(filePath: string): Promise<ExtractResult> {
  let sawSpawnError = false;
  for (const cmd of PYTHON_CMDS) {
    const res = await runPython(cmd, filePath);
    if (res.spawnError) {
      sawSpawnError = true;
      continue; // try the next python command
    }
    if (res.code === 0) {
      return { text: clamp(res.stdout), extracted: true, reason: 'python' };
    }
    if (res.stderr.startsWith('MISSING_DEP')) {
      return {
        text: '',
        extracted: false,
        reason: 'missing_dep',
        missing_dep: res.stderr.split(':', 2)[1] ?? 'unknown',
      };
    }
    // A real interpreter ran but extraction failed (corrupt file, etc).
    return { text: '', extracted: false, reason: 'error' };
  }
  return {
    text: '',
    extracted: false,
    reason: sawSpawnError ? 'no_python' : 'error',
  };
}

/** Extract plain text from a knowledge file. Never throws. */
export async function extractText(filePath: string): Promise<ExtractResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (NATIVE_TEXT_EXT.has(ext)) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return { text: clamp(raw), extracted: true, reason: 'native' };
    } catch {
      return { text: '', extracted: false, reason: 'error' };
    }
  }
  if (PYTHON_EXT.has(ext)) {
    return extractViaPython(filePath);
  }
  return { text: '', extracted: false, reason: 'unsupported' };
}

/** Lightweight probe: is a usable Python interpreter on PATH? */
export async function probePython(): Promise<{ available: boolean }> {
  for (const cmd of PYTHON_CMDS) {
    const res = await new Promise<RunResult>((resolve) => {
      execFile(cmd, ['--version'], { windowsHide: true }, (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        resolve({
          code: err ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          spawnError: e && e.code === 'ENOENT' ? e : null,
        });
      });
    });
    if (!res.spawnError && res.code === 0) return { available: true };
  }
  return { available: false };
}
