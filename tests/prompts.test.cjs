const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parsePrompts} = require('../prompts.js');
test('imports Windows text and explicit separators without splitting multiline prompts', () => {
  assert.deepEqual(parsePrompts('\ufeffFirst prompt\r\nwith details\r\n\r\nand a second paragraph\r\n---\r\nSecond image'), ['First prompt\nwith details\n\nand a second paragraph','Second image']);
});
test('numbered titles preserve multiline bodies and internal blank paragraphs', () => {
  const text = '01. CHRISTMAS BELL\nDesign a bell.\n\nKeep a white 1:1 background.\n\n02. SNOWMAN\nDesign a snowman.\n\n03. TREE\nDesign a tree.';
  assert.equal(parsePrompts(text).length, 3);
  assert.equal(parsePrompts(text)[0], 'CHRISTMAS BELL\nDesign a bell.\n\nKeep a white 1:1 background.');
});
test('supports Prompt headings, inline numbered prompts, blank lines, and explicit line mode', () => {
  assert.deepEqual(parsePrompts('Prompt 1:\nA forest\n\nPrompt 2: A village'), ['A forest','A village']);
  assert.deepEqual(parsePrompts('1) One\n2) Two'), ['One','Two']);
  assert.deepEqual(parsePrompts('One\n\nTwo'), ['One','Two']);
  assert.deepEqual(parsePrompts('One\nTwo','lines'), ['One','Two']);
  assert.deepEqual(parsePrompts('One\nTwo'), ['One\nTwo']);
});
test('empty blocks are ignored and manual separator overrides numbering', () => {
  assert.deepEqual(parsePrompts(' \n---\nOne\n---\n---\nTwo\n---'), ['One','Two']);
  assert.equal(parsePrompts('1. First detail\n2. Another detail','separator').length,1);
  assert.deepEqual(parsePrompts(''), []);
});
