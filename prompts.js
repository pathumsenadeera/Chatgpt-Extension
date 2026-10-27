/* Shared by the studio and Node tests. No network or account access. */
(function (root) {
  function parsePrompts(text, mode = 'auto') {
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    const clean = blocks => blocks.map(s => s.trim()).filter(Boolean);
    const separator = /^\s*(?:---+|===+)\s*$/m;
    if (mode === 'separator' || (mode === 'auto' && separator.test(text))) return clean(text.split(separator));
    if (mode === 'lines') return clean(text.split('\n'));
    if (mode === 'paragraphs') return clean(text.split(/\n\s*\n/));
    // A heading may be “Prompt 1: …”, “01. TITLE”, “2) …”, or “### Prompt 3”.
    // Require multiple headings before treating an ordinary numbered sentence as a batch.
    const heading = /^\s*(?:#{1,6}\s*)?(?:prompt\s*#?\d+\s*(?:[:.)\-–—]\s*)?|\d{1,4}\s*(?:[.)]|[-–—:](?=\s))\s+)(.*)$/i;
    const lines = text.split('\n');
    const starts = lines.map((line, i) => heading.test(line) ? i : -1).filter(i => i >= 0);
    if (mode === 'numbered' || (mode === 'auto' && starts.length >= 2)) {
      if (!starts.length) return [text];
      return clean(starts.map((start, i) => {
        const first = lines[start].match(heading)[1].trim();
        return [first, ...lines.slice(start + 1, starts[i + 1] ?? lines.length)].join('\n');
      }));
    }
    // Multiline prose separated by blank lines is inherently ambiguous. Preview lets
    // the user choose explicit separators instead when a prompt has paragraphs.
    return clean(text.split(/\n\s*\n/));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {parsePrompts};
  else root.PromptParser = {parsePrompts};
})(globalThis);
