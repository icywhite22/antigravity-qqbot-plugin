export const DEFAULT_TEXT_CHUNK_LIMIT = 4500;

interface FenceBlock {
  type: 'fence';
  openLine: string;
  bodyLines: string[];
  closeLine?: string;
  fenceMarker: string;
  raw: string;
}

interface TableBlock {
  type: 'table';
  headerLine: string;
  separatorLine: string;
  bodyLines: string[];
  raw: string;
}

interface LineBlock {
  type: 'line';
  raw: string;
}

type MarkdownBlock = FenceBlock | TableBlock | LineBlock;

interface FenceMatch {
  indent: string;
  fenceChar: '`' | '~';
  fenceLen: number;
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_TEXT_CHUNK_LIMIT;
  }
  return Math.floor(limit);
}

function adjustSurrogateBoundary(text: string, start: number, end: number): number {
  if (end >= text.length || end <= start + 1) {
    return end;
  }
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    return end - 1;
  }
  return end;
}

/**
 * Hard-split a string at `limit` characters without corrupting UTF-16 surrogate pairs.
 */
function hardSplitRaw(text: string, limit: number): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const rawEnd = Math.min(cursor + limit, text.length);
    const end = adjustSurrogateBoundary(text, cursor, rawEnd);
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

/**
 * Split a single long prose line, preferring whitespace boundaries before falling back to hard split.
 */
function splitLongProseLine(line: string, limit: number): string[] {
  if (!line) return [];
  if (line.length <= limit) return [line];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const remaining = line.length - cursor;
    if (remaining <= limit) {
      const tail = line.slice(cursor);
      if (tail.length > 0) chunks.push(tail);
      break;
    }

    const windowEnd = cursor + limit;
    const minBreak = cursor + Math.floor(limit * 0.5);
    let breakAt = -1;
    for (let i = windowEnd; i >= minBreak; i--) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t') {
        breakAt = i;
        break;
      }
    }

    if (breakAt > cursor) {
      const piece = line.slice(cursor, breakAt);
      if (piece.length > 0) {
        chunks.push(piece);
      }
      cursor = breakAt + 1;
      while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) {
        cursor++;
      }
    } else {
      const end = adjustSurrogateBoundary(line, cursor, windowEnd);
      chunks.push(line.slice(cursor, end));
      cursor = end;
    }
  }

  return chunks;
}

function matchFenceOpen(line: string): FenceMatch | null {
  const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const indent = match[1] ?? '';
  const marker = match[2] ?? '';
  const info = match[3] ?? '';
  const fenceChar = marker[0] as '`' | '~' | undefined;
  if (!fenceChar) return null;
  if (fenceChar === '`' && info.includes('`')) {
    return null;
  }
  return { indent, fenceChar, fenceLen: marker.length };
}

function isFenceClose(line: string, open: FenceMatch): boolean {
  const escaped = open.fenceChar === '`' ? '`' : '~';
  const closeRe = new RegExp(`^\\s*${escaped}{${open.fenceLen},}\\s*$`);
  return closeRe.test(line);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('|')) {
    return false;
  }
  return matchFenceOpen(line) === null;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('|')) {
    return false;
  }
  return (
    /^\|(?:\s*:?-{1,}:?\s*\|)+\s*$/.test(trimmed) ||
    /^:?-{1,}:?(?:\s*\|\s*:?-{1,}:?)+\s*\|?\s*$/.test(trimmed)
  );
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? '';
    const fenceOpen = matchFenceOpen(line);
    if (fenceOpen) {
      const bodyLines: string[] = [];
      let closeLine: string | undefined;
      let j = i + 1;
      while (j < lines.length) {
        const candidate = lines[j] ?? '';
        if (isFenceClose(candidate, fenceOpen)) {
          closeLine = candidate;
          j++;
          break;
        }
        bodyLines.push(candidate);
        j++;
      }
      const fenceMarker = `${fenceOpen.indent}${fenceOpen.fenceChar.repeat(fenceOpen.fenceLen)}`;
      const rawLines = [line, ...bodyLines, ...(closeLine !== undefined ? [closeLine] : [])];
      blocks.push({
        type: 'fence',
        openLine: line,
        bodyLines,
        ...(closeLine !== undefined ? { closeLine } : {}),
        fenceMarker,
        raw: rawLines.join('\n'),
      });
      i = j;
      continue;
    }

    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
    if (nextLine !== undefined && isTableRow(line) && isTableSeparator(nextLine)) {
      const bodyLines: string[] = [];
      let j = i + 2;
      while (j < lines.length) {
        const candidate = lines[j] ?? '';
        if (!isTableRow(candidate)) {
          break;
        }
        bodyLines.push(candidate);
        j++;
      }
      blocks.push({
        type: 'table',
        headerLine: line,
        separatorLine: nextLine,
        bodyLines,
        raw: [line, nextLine, ...bodyLines].join('\n'),
      });
      i = j;
      continue;
    }

    blocks.push({ type: 'line', raw: line });
    i++;
  }

  return blocks;
}

function splitOversizedFence(block: FenceBlock, limit: number): string[] {
  const openFence = block.openLine;
  const closeFence = block.closeLine ?? block.fenceMarker;
  const overhead = openFence.length + 1 + 1 + closeFence.length;

  if (overhead >= limit || block.bodyLines.length === 0) {
    return hardSplitRaw(block.raw, limit);
  }

  const interiorBudget = limit - overhead;
  const out: string[] = [];
  let body = '';
  let hasBody = false;

  const pushFenceChunk = (content: string): void => {
    out.push(`${openFence}\n${content}\n${closeFence}`);
  };

  for (const line of block.bodyLines) {
    if (line.length <= interiorBudget) {
      if (!hasBody) {
        body = line;
        hasBody = true;
      } else if (body.length + 1 + line.length <= interiorBudget) {
        body += `\n${line}`;
      } else {
        pushFenceChunk(body);
        body = line;
        hasBody = true;
      }
    } else {
      if (hasBody) {
        pushFenceChunk(body);
        body = '';
        hasBody = false;
      }
      for (const piece of hardSplitRaw(line, interiorBudget)) {
        pushFenceChunk(piece);
      }
    }
  }

  if (hasBody) {
    pushFenceChunk(body);
  }

  return out.length > 0 ? out : hardSplitRaw(block.raw, limit);
}

function splitOversizedTable(block: TableBlock, limit: number): string[] {
  const header = `${block.headerLine}\n${block.separatorLine}`;
  if (header.length + 1 >= limit || block.bodyLines.length === 0) {
    const fallbackOut: string[] = [];
    for (const line of [block.headerLine, block.separatorLine, ...block.bodyLines]) {
      fallbackOut.push(...hardSplitRaw(line, limit));
    }
    return fallbackOut;
  }

  const rowBudget = limit - header.length - 1;
  const out: string[] = [];
  let rows = '';

  for (const row of block.bodyLines) {
    if (row.length <= rowBudget) {
      if (rows === '') {
        rows = row;
      } else if (rows.length + 1 + row.length <= rowBudget) {
        rows += `\n${row}`;
      } else {
        out.push(`${header}\n${rows}`);
        rows = row;
      }
    } else {
      if (rows !== '') {
        out.push(`${header}\n${rows}`);
        rows = '';
      }
      out.push(...hardSplitRaw(row, limit));
    }
  }

  if (rows !== '') {
    out.push(`${header}\n${rows}`);
  }

  return out;
}

function enforceChunkInvariant(chunks: string[], limit: number): string[] {
  const safe: string[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (chunk.length <= limit) {
      safe.push(chunk);
    } else {
      safe.push(...hardSplitRaw(chunk, limit));
    }
  }
  return safe;
}

/**
 * Split plain text into chunks of at most `limit` characters, preferring line
 * and whitespace boundaries with hard-split fallback for oversized lines.
 */
export function chunkText(text: string, limit?: number): string[] {
  if (!text) return [];
  const maxLen = normalizeLimit(limit);
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.length <= maxLen) {
    return [normalized];
  }

  const lines = normalized.split('\n');
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    const trimmed = current.replace(/^\n+|\n+$/g, '');
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
    current = '';
  };

  for (const line of lines) {
    if (line.length <= maxLen) {
      if (current === '') {
        if (line.trim() !== '') {
          current = line;
        }
      } else if (current.length + 1 + line.length <= maxLen) {
        current += `\n${line}`;
      } else {
        flush();
        if (line.trim() !== '') {
          current = line;
        }
      }
    } else {
      flush();
      const pieces = splitLongProseLine(line, maxLen);
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (!piece) continue;
        if (i < pieces.length - 1) {
          chunks.push(piece);
        } else {
          current = piece;
        }
      }
    }
  }

  flush();
  return enforceChunkInvariant(chunks, maxLen);
}

/**
 * Split Markdown text into chunks of at most `limit` characters without breaking
 * fenced code blocks or GFM tables when they fit, with balanced-header splitting
 * and hard-split fallback for oversized single lines or blocks.
 */
export function chunkMarkdownText(text: string, limit?: number): string[] {
  if (!text) return [];
  const maxLen = normalizeLimit(limit);
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.length <= maxLen) {
    return [normalized];
  }

  const blocks = parseMarkdownBlocks(normalized);
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    const trimmed = current.replace(/^\n+|\n+$/g, '');
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
    current = '';
  };

  for (const block of blocks) {
    if (block.raw.length <= maxLen) {
      if (current === '') {
        if (block.type !== 'line' || block.raw.trim() !== '') {
          current = block.raw;
        }
      } else if (current.length + 1 + block.raw.length <= maxLen) {
        current += `\n${block.raw}`;
      } else {
        flush();
        if (block.type !== 'line' || block.raw.trim() !== '') {
          current = block.raw;
        }
      }
      continue;
    }

    flush();
    if (block.type === 'fence') {
      chunks.push(...splitOversizedFence(block, maxLen));
    } else if (block.type === 'table') {
      chunks.push(...splitOversizedTable(block, maxLen));
    } else {
      const pieces = splitLongProseLine(block.raw, maxLen);
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (!piece) continue;
        if (i < pieces.length - 1) {
          chunks.push(piece);
        } else {
          current = piece;
        }
      }
    }
  }

  flush();
  return enforceChunkInvariant(chunks, maxLen);
}
