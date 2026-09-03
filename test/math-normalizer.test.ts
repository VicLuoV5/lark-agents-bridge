import { describe, expect, it } from 'vitest';
import { normalizeMathForLarkMarkdown } from '../src/card/math-normalizer';
import { renderCard } from '../src/card/run-renderer';
import { initialState, reduce } from '../src/card/run-state';
import { renderText } from '../src/card/text-renderer';

describe('normalizeMathForLarkMarkdown', () => {
  it('renders Codex inline and display LaTeX as readable Unicode', () => {
    const input = String.raw`Einstein wrote \(E = mc^2\).

\[
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
\]`;

    expect(normalizeMathForLarkMarkdown(input)).toBe(
      'Einstein wrote E = mc².\n\nx = (−b ± √(b² − 4ac))⁄(2a)\n',
    );
  });

  it('supports dollar delimiters, Greek letters, operators, and scripts', () => {
    expect(normalizeMathForLarkMarkdown(String.raw`$\sum_{i=1}^{n} \alpha_i \leq \infty$`)).toBe(
      '∑ᵢ₌₁ⁿ αᵢ ≤ ∞',
    );
  });

  it('does not alter fenced or inline code', () => {
    const input = [
      String.raw`Use \(x^2\), but keep ` + '`' + String.raw`\(raw^2\)` + '`.',
      '',
      '```md',
      String.raw`\[raw_1\]`,
      '```',
    ].join('\n');
    const expected = [
      String.raw`Use x², but keep ` + '`' + String.raw`\(raw^2\)` + '`.',
      '',
      '```md',
      String.raw`\[raw_1\]`,
      '```',
    ].join('\n');

    expect(normalizeMathForLarkMarkdown(input)).toBe(expected);
  });

  it('keeps incomplete delimiters unchanged during streaming', () => {
    expect(normalizeMathForLarkMarkdown(String.raw`Working on \(x^2`)).toBe(
      String.raw`Working on \(x^2`,
    );
  });

  it('does not mistake common currency text for a formula', () => {
    expect(normalizeMathForLarkMarkdown('Costs range from $5 and $10 today.')).toBe(
      'Costs range from $5 and $10 today.',
    );
  });

  it('is applied by both card and text reply renderers', () => {
    const state = reduce(initialState, {
      type: 'text',
      delta: String.raw`Result: \(E=mc^2\)`,
    });
    const card = renderCard(state) as {
      body: { elements: Array<{ tag: string; content?: string }> };
    };

    expect(card.body.elements).toContainEqual({ tag: 'markdown', content: 'Result: E=mc²' });
    expect(renderText(state)).toBe('Result: E=mc²\n\n_✍️ 正在输出…_');
  });
});
