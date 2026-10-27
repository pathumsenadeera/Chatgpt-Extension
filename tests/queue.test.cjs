const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const data = {}, downloads = [], sent = [], alarms = [];
  let listener, alarmListener, failDownload = false;
  const chrome = {
    storage: {local: {get: async key => ({[key]: structuredClone(data[key])}), set: async value => Object.assign(data, structuredClone(value))}},
    tabs: {query: async () => [{id: 1, url: 'https://chatgpt.com/'}], sendMessage: async (id, message) => {sent.push(message); return {ok: true, ready: true};}, onRemoved: {addListener() {}}},
    downloads: {download: async image => {if (failDownload) throw Error('disk full'); downloads.push(image);}},
    alarms: {create: async (...args) => alarms.push(args), onAlarm: {addListener(fn) {alarmListener = fn;}}},
    runtime: {onMessage: {addListener(fn) {listener = fn;}}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), {chrome, crypto: {randomUUID: () => 'batch'}});
  const message = (m, sender = {}) => new Promise(resolve => listener(m, sender, resolve));
  const start = () => message({type: 'START', prompts: ['first', 'second'], delay: 5});
  const result = (extra = {}) => message({type: 'RESULT', id: 'batch', index: data.queue.index, urls: ['data:image/png;base64,AAA'], ...extra}, {tab: {id: 1}});
  return {data, downloads, sent, alarms, message, start, result, fail: () => {failDownload = true;}, tick: async () => {alarmListener({name: 'next'}); await new Promise(resolve => setImmediate(resolve));}};
}
test('submits sequentially, downloads each result, ignores duplicates, and completes', async () => {
  const s = setup(); assert.equal((await s.start()).ok, true);
  assert.equal(s.sent.filter(m => m.type === 'GENERATE').length, 1);
  await s.result(); assert.equal(s.data.queue.index, 1); assert.equal(s.downloads.length, 1);
  await s.message({type: 'RESULT', id: 'batch', index: 0, urls: []}, {tab: {id: 1}});
  assert.equal(s.data.queue.index, 1);
  await s.tick(); assert.equal(s.sent.filter(m => m.type === 'GENERATE').length, 2);
  await s.result(); assert.equal(s.data.queue.status, 'completed'); assert.equal(s.downloads.length, 2);
});
test('pause allows the current image to finish and resume submits the next prompt', async () => {
  const s = setup(); await s.start(); await s.message({type: 'PAUSE'}); await s.result();
  assert.equal(s.data.queue.status, 'paused'); await s.tick();
  assert.equal(s.sent.filter(m => m.type === 'GENERATE').length, 1);
  await s.message({type: 'RESUME'}); assert.equal(s.data.queue.pending, true);
  assert.equal(s.sent.filter(m => m.type === 'GENERATE').length, 2);
});
test('generation errors pause without advancing; resume retries the same prompt', async () => {
  const s = setup(); await s.start(); await s.result({error: 'Usage limit'});
  assert.equal(s.data.queue.index, 0); assert.equal(s.data.queue.status, 'paused');
  await s.message({type: 'RESUME'}); assert.equal(s.sent.at(-1).prompt, 'first');
});
test('stop ignores late results and rejects results from other tabs', async () => {
  const s = setup(); await s.start();
  await s.message({type: 'RESULT', id: 'batch', index: 0, urls: []}, {tab: {id: 2}});
  assert.equal(s.data.queue.index, 0);
  await s.message({type: 'STOP'}); await s.result();
  assert.equal(s.downloads.length, 0); assert.equal(s.data.queue.status, 'stopped');
});
test('download failures retain the image for retry and pause the queue', async () => {
  const s = setup(); await s.start(); s.fail(); await s.result();
  assert.equal(s.data.queue.status, 'paused'); assert.equal(s.data.queue.images.length, 1);
  assert.match(s.data.queue.error, /disk full/);
});
