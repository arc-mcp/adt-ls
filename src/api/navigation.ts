/**
 * LSP code-intelligence (the SECOND channel — adt-ls is a language server). Thin proxies
 * over standard `textDocument/*` methods: outline, definition, where-used, type hierarchy,
 * syntax check, hover, document-highlight, completion. All READS.
 *
 * Per call: resolve name → repotree AFF URI (lifecycle.resolveAffUri) → readFile →
 * `textDocument/didOpen` (NOTIFICATION) → query → `didClose`.
 */
import type { LspClient } from '../driver.js';
import type { Lifecycle, ObjectRef } from './lifecycle.js';
import { type ObjectAccess, createObjectAccess } from './object-access.js';
import { readFile } from './repository.js';

/** Where to point a position-based query: a declared symbol name, OR an explicit 1-based
 * line+character (editor convention; converted to LSP 0-based). */
export interface Locator {
  symbol?: string;
  line?: number;
  character?: number;
}

/** A 0-based LSP position (as adt-ls emits). */
export interface Position {
  line: number;
  character: number;
}
interface DocumentSymbol {
  name: string;
  kind: number;
  selectionRange: { start: Position };
  children?: DocumentSymbol[];
}

/** A standard LSP text edit (0-based positions). */
export interface TextEdit {
  range: { start: Position; end: Position };
  newText: string;
}

/**
 * Apply LSP `TextEdit[]` to source text (pure). Edits are non-overlapping per the LSP
 * spec; we sort by start offset descending so applying one never shifts the offsets of
 * those not yet applied. Positions are UTF-16 code-unit based, matching JS string indices.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  if (!edits || edits.length === 0) return text;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const toOffset = (p: Position): number => {
    // A line past the end (servers often emit a sentinel end like {line: 1e9, character: 0}
    // for a whole-document replace) means end-of-text — NOT the start of the last line.
    if (p.line >= lineStarts.length) return text.length;
    const lineStart = lineStarts[p.line];
    // End of this line's CONTENT (exclude the trailing '\n'); for the last line, end-of-text.
    const lineEnd = p.line + 1 < lineStarts.length ? lineStarts[p.line + 1] - 1 : text.length;
    return Math.min(lineStart + Math.max(0, p.character), lineEnd);
  };
  const sorted = [...edits].sort((a, b) => toOffset(b.range.start) - toOffset(a.range.start));
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, toOffset(e.range.start)) + e.newText + out.slice(toOffset(e.range.end));
  }
  return out;
}

/** The server's semantic-tokens legend (from `initialize` capabilities). */
export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}
/** One decoded semantic token (absolute position + resolved names). */
export interface DecodedToken {
  line: number;
  character: number;
  length: number;
  tokenType: string;
  tokenModifiers: string[];
}

/**
 * Decode LSP delta-encoded semantic tokens (flat int array of 5-tuples
 * `[ΔlineFromPrev, ΔstartChar, length, tokenTypeIdx, modifierBitset]`) into absolute,
 * name-resolved tokens (pure). Positions are 0-based, as LSP emits them.
 */
export function decodeSemanticTokens(data: number[] | undefined, legend: SemanticTokensLegend): DecodedToken[] {
  if (!Array.isArray(data)) return [];
  const out: DecodedToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [dLine, dChar, length, typeIdx, modBits] = data.slice(i, i + 5);
    if (dLine > 0) {
      line += dLine;
      char = dChar;
    } else {
      char += dChar;
    }
    const tokenModifiers = legend.tokenModifiers.filter((_, b) => (modBits & (1 << b)) !== 0);
    out.push({
      line,
      character: char,
      length,
      tokenType: legend.tokenTypes[typeIdx] ?? String(typeIdx),
      tokenModifiers,
    });
  }
  return out;
}

export interface NavigationDeps {
  lsp: LspClient;
  /** Reused for name → repotree AFF URI (carries the destination). */
  lifecycle: Pick<Lifecycle, 'resolveAffUri'>;
  /** Server semantic-tokens legend (from initialize) — enables `semanticTokens` decoding. */
  semanticTokensLegend?: SemanticTokensLegend;
  /** Shared with version-aware reads and writes in the unified client. */
  objectAccess?: ObjectAccess;
}

/** LSP code-intelligence surface (the `navigation` namespace). Positions are a declared
 * `symbol` name or explicit 1-based `line` + `character`. */
export interface Navigation {
  /** Object outline (LSP `DocumentSymbol[]` — kinds + ranges + children). */
  documentSymbols(ref: ObjectRef): Promise<unknown>;
  /** ABAP syntax check WITHOUT activating (pull diagnostics). */
  checkSyntax(ref: ObjectRef): Promise<unknown>;
  /** Go to a symbol's definition (the implementation). */
  goToDefinition(ref: ObjectRef, locator: Locator): Promise<unknown>;
  /** Go to a symbol's declaration (the signature). */
  goToDeclaration(ref: ObjectRef, locator: Locator): Promise<unknown>;
  /** Hover info — ABAP signature + ABAP-Doc, or CDS element info. */
  hover(ref: ObjectRef, locator: Locator): Promise<unknown>;
  /** Read/write/text occurrences of the symbol within the document. */
  documentHighlight(ref: ObjectRef, locator: Locator): Promise<unknown>;
  /** Where-used (`Location[]`). Timeout-guarded — heavily-used globals can hang. */
  findReferences(
    ref: ObjectRef,
    locator: Locator,
    opts?: { includeDeclaration?: boolean; timeoutMs?: number },
  ): Promise<unknown>;
  /** Inheritance / implementation tree (prepare → super/sub). */
  typeHierarchy(
    ref: ObjectRef,
    locator: Locator,
    opts?: { direction?: 'supertypes' | 'subtypes' | 'both' },
  ): Promise<unknown>;
  /** Code completion at a position (capped — lists are huge). When `resolve` is set, each
   * returned item is enriched via `completionItem/resolve` (adds signatures / ABAP-Doc). */
  completion(
    ref: ObjectRef,
    locator: Locator,
    opts?: { maxItems?: number; resolve?: boolean; resolveLimit?: number },
  ): Promise<unknown>;
  /** Format source via the ABAP Pretty-Printer (whole document). Returns the formatted
   * source plus the raw LSP `TextEdit[]`. (`tabSize`/`insertSpaces` are passed through; the
   * pretty-printer largely applies its own ABAP rules.) */
  format(
    ref: ObjectRef,
    opts?: { tabSize?: number; insertSpaces?: boolean },
  ): Promise<{ formatted: string; edits: TextEdit[] }>;
  /** Semantic tokens for the object, decoded to absolute, name-resolved tokens (the same
   * pass that primes hover/highlight). Returns `{ legend, tokens }`. */
  semanticTokens(ref: ObjectRef): Promise<{ legend: SemanticTokensLegend; tokens: DecodedToken[] }>;
}

export function createNavigation(deps: NavigationDeps): Navigation {
  const { lsp, lifecycle } = deps;

  // Per-object serialization: didOpen/didClose share ONE LSP connection, so two concurrent
  // ops on the SAME object would duplicate-open and let the first's didClose pull the
  // document out from under the second's in-flight query. Different objects still run in
  // parallel.
  const runExclusive = deps.objectAccess ?? createObjectAccess();

  /** Open the object's document, run fn (with its source), always didClose. */
  async function withOpenDocument<T>(ref: ObjectRef, fn: (uri: string, content: string) => Promise<T>): Promise<T> {
    const uri = await lifecycle.resolveAffUri(ref);
    return runExclusive(uri, async () => {
      const text = await readFile(lsp, uri);
      await lsp.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'abap', version: 1, text },
      });
      try {
        return await fn(uri, text);
      } finally {
        await lsp.sendNotification('textDocument/didClose', { textDocument: { uri } }).catch(() => {});
      }
    });
  }

  function findSymbol(symbols: DocumentSymbol[], name: string): DocumentSymbol | undefined {
    const lower = name.toLowerCase();
    for (const s of symbols) {
      if (s.name?.toLowerCase() === lower) return s;
      const c = s.children ? findSymbol(s.children, name) : undefined;
      if (c) return c;
    }
    return undefined;
  }
  function symbolNames(symbols: DocumentSymbol[]): string[] {
    return symbols.flatMap((s) => [s.name, ...(s.children ? symbolNames(s.children) : [])]);
  }

  /** Locate a name's first word-boundary occurrence → 0-based position. Fallback for when
   * documentSymbol misses the symbol (notably CDS/DDLS, whose outline is empty headless). */
  function findInSource(content: string, name: string): Position | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    const lines = content.split('\n');
    for (let line = 0; line < lines.length; line++) {
      const m = re.exec(lines[line]);
      if (m) return { line, character: m.index };
    }
    return undefined;
  }

  /** Strip an LSP node's opaque `data` blob (resolve payload) — dead weight + token sink. */
  function stripData<T>(node: T): T {
    if (node && typeof node === 'object' && 'data' in node) {
      const { data: _data, ...rest } = node as Record<string, unknown>;
      return rest as T;
    }
    return node;
  }

  /** Point at the symbol's NAME token. adt-ls's selectionRange for a class/interface spans
   * the whole body and starts at column 0 (the keyword), which breaks position queries, so
   * locate the name within its declaration line; fall back to selectionRange.start. */
  function positionOfSymbol(content: string, hit: DocumentSymbol): Position {
    const start = hit.selectionRange.start;
    if (start.character > 0) return start;
    const lineText = content.split('\n')[start.line] ?? '';
    const escaped = hit.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`\\b${escaped}\\b`, 'i').exec(lineText);
    return m ? { line: start.line, character: m.index } : start;
  }

  /** Prime the ABAP token cache so hover/documentHighlight pass the backend gate. adt-ls's
   * hover/highlight services short-circuit to null/[] unless the token under the cursor is
   * in AbapDocumentTokenCache — populated ONLY by `semanticTokens/full` (same doc version).
   * Best-effort (DDLS/JSON parse inline and don't need it). */
  async function primeTokens(uri: string): Promise<void> {
    await lsp.sendRequest('textDocument/semanticTokens/full', { textDocument: { uri } }).catch(() => {});
  }

  /** Resolve a locator → 0-based LSP position. Doc must already be open (symbol lookup). */
  async function resolvePosition(uri: string, content: string, locator: Locator): Promise<Position> {
    if (locator.line !== undefined && locator.character !== undefined) {
      return { line: Math.max(0, locator.line - 1), character: Math.max(0, locator.character - 1) };
    }
    if (locator.symbol) {
      const symbols =
        (await lsp.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', { textDocument: { uri } })) ?? [];
      const hit = findSymbol(symbols, locator.symbol);
      if (hit) return positionOfSymbol(content, hit);
      const fromSource = findInSource(content, locator.symbol);
      if (fromSource) return fromSource;
      throw new Error(
        `Symbol "${locator.symbol}" not found in the outline or source. Declared symbols: ${
          symbolNames(symbols).slice(0, 40).join(', ') || '(none)'
        }. For CDS, pass explicit 1-based line + character instead.`,
      );
    }
    throw new Error('Provide a `symbol` name or explicit `line` + `character` (1-based).');
  }

  return {
    /** Object outline (LSP DocumentSymbol[] — kinds + ranges + children). */
    documentSymbols(ref: ObjectRef): Promise<unknown> {
      return withOpenDocument(ref, (uri) => lsp.sendRequest('textDocument/documentSymbol', { textDocument: { uri } }));
    },

    /** ABAP syntax check WITHOUT activating (pull diagnostics). */
    checkSyntax(ref: ObjectRef): Promise<unknown> {
      return withOpenDocument(ref, (uri) => lsp.sendRequest('textDocument/diagnostic', { textDocument: { uri } }));
    },

    /** Jump to a symbol's definition (LocationLink[]). */
    goToDefinition(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/definition', { textDocument: { uri }, position });
      });
    },

    /** Jump to a symbol's declaration/signature (LocationLink[]). */
    goToDeclaration(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/declaration', { textDocument: { uri }, position });
      });
    },

    /** Hover info at a position (ABAP signature + ABAP-Doc, or CDS element info). Primes the
     * token cache first; null when there's no element under the cursor. */
    hover(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        await primeTokens(uri);
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/hover', { textDocument: { uri }, position });
      });
    },

    /** Occurrences of the symbol at a position (DocumentHighlight[]). Same gate as hover. */
    documentHighlight(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        await primeTokens(uri);
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/documentHighlight', { textDocument: { uri }, position });
      });
    },

    /** Where-used (Location[]). Timeout-guarded: heavily-used global symbols can hang. */
    findReferences(
      ref: ObjectRef,
      locator: Locator,
      opts: { includeDeclaration?: boolean; timeoutMs?: number } = {},
    ): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        const timeoutMs = opts.timeoutMs ?? 20_000;
        const narrowHint =
          'the symbol is likely too heavily used (e.g. a global class/method); narrow to a local or less-referenced symbol.';
        const req = lsp.sendRequest('textDocument/references', {
          textDocument: { uri },
          position,
          context: { includeDeclaration: opts.includeDeclaration ?? true },
        });
        req.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            req,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`findReferences timed out after ${timeoutMs}ms — ${narrowHint}`)),
                timeoutMs,
              );
            }),
          ]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/internal error/i.test(msg)) throw new Error(`findReferences failed (${msg}) — ${narrowHint}`);
          throw e;
        } finally {
          if (timer) clearTimeout(timer);
        }
      });
    },

    /** Inheritance / implementation tree (prepareTypeHierarchy → super/sub). */
    typeHierarchy(
      ref: ObjectRef,
      locator: Locator,
      opts: { direction?: 'supertypes' | 'subtypes' | 'both' } = {},
    ): Promise<unknown> {
      const direction = opts.direction ?? 'both';
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        const items =
          (await lsp.sendRequest<unknown[]>('textDocument/prepareTypeHierarchy', {
            textDocument: { uri },
            position,
          })) ?? [];
        if (!Array.isArray(items) || !items[0]) return { item: null, supertypes: [], subtypes: [] };
        const item = items[0];
        const stripList = (v: unknown) => (Array.isArray(v) ? v.map(stripData) : v);
        const result: { item: unknown; supertypes?: unknown; subtypes?: unknown } = { item: stripData(item) };
        if (direction === 'supertypes' || direction === 'both') {
          result.supertypes = stripList(await lsp.sendRequest('typeHierarchy/supertypes', { item }));
        }
        if (direction === 'subtypes' || direction === 'both') {
          result.subtypes = stripList(await lsp.sendRequest('typeHierarchy/subtypes', { item }));
        }
        return result;
      });
    },

    /** Code completion at a position (capped — completion lists are huge). With `resolve`,
     * the returned (capped) items are enriched via `completionItem/resolve` — adding the
     * ABAP method signature / ABAP-Doc as markdown `documentation` (one backend call per
     * item, so resolution is bounded by `resolveLimit`, default 25). */
    completion(
      ref: ObjectRef,
      locator: Locator,
      opts: { maxItems?: number; resolve?: boolean; resolveLimit?: number } = {},
    ): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        const res = await lsp.sendRequest<{ items?: unknown[]; isIncomplete?: boolean } | unknown[]>(
          'textDocument/completion',
          { textDocument: { uri }, position },
        );
        const items = Array.isArray(res) ? res : (res?.items ?? []);
        const isIncomplete = Array.isArray(res) ? undefined : res?.isIncomplete;
        const capped = items.slice(0, opts.maxItems ?? 50) as Array<Record<string, unknown>>;

        // Default (fast) path: drop the opaque `data` resolve-blob and return as-is.
        if (!opts.resolve) {
          const slim = capped.map((it) => {
            if (it && typeof it === 'object' && 'data' in it) {
              const { data: _data, ...rest } = it;
              return rest;
            }
            return it;
          });
          return { isIncomplete, total: items.length, items: slim };
        }

        // Resolve path: enrich items that carry `data` (identifier/member completions —
        // keywords have none), then strip `data` from the output (token sink).
        const limit = opts.resolveLimit ?? 25;
        // NOTE: the guard check + increment below MUST stay synchronous (before any await),
        // so all map callbacks run their guard in one pass and the cap holds exactly.
        let resolvedCount = 0;
        const enriched = await Promise.all(
          capped.map(async (it) => {
            if (!it || typeof it !== 'object' || !('data' in it) || resolvedCount >= limit) {
              const { data: _d, ...rest } = (it ?? {}) as Record<string, unknown>;
              return rest;
            }
            resolvedCount++;
            try {
              const full = (await lsp.sendRequest<Record<string, unknown>>('completionItem/resolve', it)) ?? it;
              const { data: _data, ...rest } = full;
              return rest;
            } catch {
              const { data: _data, ...rest } = it;
              return rest;
            }
          }),
        );
        return { isIncomplete, total: items.length, resolved: resolvedCount, items: enriched };
      });
    },

    /** Format the object's source with the ABAP Pretty-Printer (`textDocument/formatting`,
     * which adt-ls registers dynamically per-URI on didOpen). Returns the formatted source
     * (edits applied) plus the raw TextEdits. */
    format(
      ref: ObjectRef,
      opts: { tabSize?: number; insertSpaces?: boolean } = {},
    ): Promise<{ formatted: string; edits: TextEdit[] }> {
      return withOpenDocument(ref, async (uri, content) => {
        const edits =
          (await lsp.sendRequest<TextEdit[]>('textDocument/formatting', {
            textDocument: { uri },
            options: { tabSize: opts.tabSize ?? 2, insertSpaces: opts.insertSpaces ?? true },
          })) ?? [];
        const list = Array.isArray(edits) ? edits : [];
        return { formatted: applyTextEdits(content, list), edits: list };
      });
    },

    /** Semantic tokens, decoded via the server legend (the same `semanticTokens/full` pass
     * that primes the hover/highlight token cache). */
    semanticTokens(ref: ObjectRef): Promise<{ legend: SemanticTokensLegend; tokens: DecodedToken[] }> {
      const legend = deps.semanticTokensLegend ?? { tokenTypes: [], tokenModifiers: [] };
      return withOpenDocument(ref, async (uri) => {
        const res = await lsp.sendRequest<{ data?: number[] }>('textDocument/semanticTokens/full', {
          textDocument: { uri },
        });
        return { legend, tokens: decodeSemanticTokens(res?.data, legend) };
      });
    },
  };
}
