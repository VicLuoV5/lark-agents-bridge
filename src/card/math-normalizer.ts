/**
 * Feishu/Lark message-card markdown does not render LaTeX. Convert the
 * delimiters Codex commonly emits into a readable Unicode approximation
 * before handing the text to the native markdown renderer.
 *
 * This intentionally stays dependency-free and conservative. Unsupported
 * commands are kept as text rather than making the whole expression vanish,
 * while fenced and inline code are never touched.
 */
export function normalizeMathForLarkMarkdown(markdown: string): string {
  return mapOutsideCode(markdown, normalizeMathSegments);
}

function mapOutsideCode(input: string, transform: (text: string) => string): string {
  let out = '';
  let plainStart = 0;
  let i = 0;

  while (i < input.length) {
    if (input[i] !== '`') {
      i++;
      continue;
    }

    let ticks = 1;
    while (input[i + ticks] === '`') ticks++;
    const marker = '`'.repeat(ticks);
    const end = input.indexOf(marker, i + ticks);
    if (end < 0) break;

    out += transform(input.slice(plainStart, i));
    out += input.slice(i, end + ticks);
    i = end + ticks;
    plainStart = i;
  }

  return out + transform(input.slice(plainStart));
}

function normalizeMathSegments(input: string): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    const opener = mathOpenerAt(input, i);
    if (!opener) {
      out += input[i];
      i++;
      continue;
    }

    const end = findClosingDelimiter(input, i + opener.open.length, opener.close);
    if (end < 0) {
      out += opener.open;
      i += opener.open.length;
      continue;
    }

    const source = input.slice(i + opener.open.length, end);
    if (opener.open === '$' && !looksLikeDollarMath(source)) {
      out += opener.open;
      i += opener.open.length;
      continue;
    }

    const rendered = latexToUnicode(source.trim());
    out += opener.display ? `\n${rendered}\n` : rendered;
    i = end + opener.close.length;
  }

  return out.replace(/\n{3,}/g, '\n\n');
}

interface MathOpener {
  open: string;
  close: string;
  display: boolean;
}

function mathOpenerAt(input: string, index: number): MathOpener | undefined {
  if (input.startsWith('\\[', index)) return { open: '\\[', close: '\\]', display: true };
  if (input.startsWith('\\(', index)) return { open: '\\(', close: '\\)', display: false };
  if (input.startsWith('$$', index) && !isEscaped(input, index)) {
    return { open: '$$', close: '$$', display: true };
  }
  if (input[index] === '$' && !isEscaped(input, index)) {
    return { open: '$', close: '$', display: false };
  }
  return undefined;
}

function findClosingDelimiter(input: string, from: number, delimiter: string): number {
  let at = input.indexOf(delimiter, from);
  while (at >= 0) {
    if (!isEscaped(input, at) || delimiter.startsWith('\\')) return at;
    at = input.indexOf(delimiter, at + delimiter.length);
  }
  return -1;
}

function isEscaped(input: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && input[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function looksLikeDollarMath(source: string): boolean {
  const value = source.trim();
  if (!value || /\n\n/.test(value)) return false;
  // Avoid treating ordinary currency ranges such as "$5 and $10" as math.
  if (/^\d[\d,.]*\s+(?:and|to|-)$/.test(value)) return false;
  return value.length <= 500;
}

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ϵ',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ',
  psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', ast: '∗', circ: '∘',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', sim: '∼',
  equiv: '≡', propto: '∝', in: '∈', notin: '∉', subset: '⊂', supset: '⊃',
  subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', oint: '∮',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒',
  Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', degree: '°', angle: '∠',
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
};

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷',
  '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇',
  '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ',
  o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

function latexToUnicode(source: string): string {
  let value = source;

  // Handle structural commands before generic command replacement.
  value = replaceBinaryCommand(value, 'frac', (a, b) => `(${latexToUnicode(a)})⁄(${latexToUnicode(b)})`);
  value = replaceUnaryCommand(value, 'sqrt', (body) => `√(${latexToUnicode(body)})`);
  for (const cmd of ['text', 'textrm', 'mathrm', 'mathbf', 'mathit', 'operatorname']) {
    value = replaceUnaryCommand(value, cmd, (body) => latexToUnicode(body));
  }

  value = value
    .replace(/\\begin\{(?:aligned|align\*?|gathered|cases|matrix|pmatrix|bmatrix)\}/g, '')
    .replace(/\\end\{(?:aligned|align\*?|gathered|cases|matrix|pmatrix|bmatrix)\}/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/\\,/g, ' ')
    .replace(/\\(?:quad|qquad)/g, '  ')
    .replace(/\\!/g, '')
    .replace(/\\\\/g, '\n')
    .replace(/&/g, '')
    .replace(/-/g, '−');

  value = value.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (_match, name: string) => SYMBOLS[name] ?? name);
  value = replaceScripts(value, '^', SUPERSCRIPT);
  value = replaceScripts(value, '_', SUBSCRIPT);

  return value
    .replace(/[{}]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function replaceUnaryCommand(
  input: string,
  command: string,
  render: (body: string) => string,
): string {
  let value = input;
  let from = 0;
  const needle = `\\${command}`;
  while (true) {
    const at = value.indexOf(needle, from);
    if (at < 0) return value;
    const brace = skipWhitespace(value, at + needle.length);
    const group = readGroup(value, brace);
    if (!group) {
      from = at + needle.length;
      continue;
    }
    value = value.slice(0, at) + render(group.body) + value.slice(group.end);
    from = at;
  }
}

function replaceBinaryCommand(
  input: string,
  command: string,
  render: (left: string, right: string) => string,
): string {
  let value = input;
  let from = 0;
  const needle = `\\${command}`;
  while (true) {
    const at = value.lastIndexOf(needle);
    if (at < from) return value;
    const first = readGroup(value, skipWhitespace(value, at + needle.length));
    const second = first && readGroup(value, skipWhitespace(value, first.end));
    if (!first || !second) {
      from = at + needle.length;
      continue;
    }
    value = value.slice(0, at) + render(first.body, second.body) + value.slice(second.end);
  }
}

function skipWhitespace(input: string, from: number): number {
  let i = from;
  while (/\s/.test(input[i] ?? '')) i++;
  return i;
}

function readGroup(input: string, start: number): { body: string; end: number } | undefined {
  if (input[start] !== '{') return undefined;
  let depth = 1;
  for (let i = start + 1; i < input.length; i++) {
    if (input[i] === '{' && !isEscaped(input, i)) depth++;
    if (input[i] === '}' && !isEscaped(input, i)) depth--;
    if (depth === 0) return { body: input.slice(start + 1, i), end: i + 1 };
  }
  return undefined;
}

function replaceScripts(input: string, marker: '^' | '_', table: Record<string, string>): string {
  const escaped = marker === '^' ? '\\^' : '_';
  return input.replace(new RegExp(`${escaped}(?:\\{([^{}]+)\\}|([A-Za-z0-9+\\-=()]))`, 'g'),
    (whole, grouped: string | undefined, single: string | undefined) => {
      const body = grouped ?? single ?? '';
      const converted = [...body].map((char) => table[char]).join('');
      if (converted.length === [...body].length) return converted;
      return marker === '^' ? `^(${body})` : `_(${body})`;
    });
}
