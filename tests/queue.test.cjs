const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const data = {}, downloads = [], sent = [], alarms = [];
  let listener, alarmListener, failDownload = false;
  const chrome = {
    storage: {local: {get: async key => ({[key]: structuredClone(data[key])}), set: async value => Object.assign(data, structuredClone(value))}},
    sidePanel: {setPanelBehavior: async () => {}},
    tabs: {create: async options => {sent.push({type: 'NEW_TAB', ...options}); return {id: 1};}, sendMessage: async (id, message) => {sent.push(message); return {ok: true, ready: true, instanceId: 'document-1'};}, onRemoved: {addListener() {}}},
    downloads: {download: async image => {if (failDownload) throw Error('disk full'); downloads.push(image);}},
    alarms: {clear: async () => {}, create: async (...args) => alarms.push(args), onAlarm: {addListener(fn) {alarmListener = fn;}}},
    runtime: {onMessage: {addListener(fn) {listener = fn;}}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), {chrome, crypto: {randomUUID: () => 'batch'}});
  const message = (m, sender = {}) => new Promise(resolve => listener(m, sender, resolve));
  const tick = async () => {alarmListener({name: 'next'}); await new Promise(resolve => setImmediate(resolve));};
  const start = async () => {const response = await message({type: 'START', prompts: ['first', 'second'], delay: 5}); await tick(); return response;};
  const result = (extra = {}) => message({type: 'RESULT', id: 'batch', index: data.queue.index, urls: ['data:image/png;base64,AAA'], ...extra}, {tab: {id: 1}});
  return {data, downloads, sent, alarms, message, start, result, fail: () => {failDownload = true;}, tick};
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

test('opens one fresh chat and sends every prompt to the same tab', async () => {
  const s = setup(); await s.start();
  assert.equal(s.sent.filter(m => m.type === 'NEW_TAB').length, 1);
  assert.equal(s.sent.find(m => m.type === 'NEW_TAB').url, 'https://chatgpt.com/');
  await s.result(); await s.tick(); await s.result();
  assert.equal(s.sent.filter(m => m.type === 'NEW_TAB').length, 1);
  assert.deepEqual(s.sent.filter(m => m.type === 'GENERATE').map(m => m.prompt), ['first','second']);
});
test('does not advance on an empty image result', async () => {
  const s = setup(); await s.start(); await s.result({urls: []});
  assert.equal(s.data.queue.status, 'paused'); assert.equal(s.data.queue.index, 0);
});
test('reload during generation pauses instead of submitting another prompt', async () => {
  const s = setup(); await s.start();
  await s.message({type:'READY',instanceId:'new-document'}, {tab:{id:1}});
  assert.equal(s.data.queue.status,'paused'); assert.equal(s.data.queue.pending,false);
  assert.match(s.data.queue.error,/reloaded/);
});
test('backs up a restored first-prompt draft before allowing replacement', async () => {
  const s = setup(); await s.start();
  assert.equal(s.sent.find(m => m.type === 'GENERATE').replaceInitialDraft, true);
  const draft = {type:'SAVE_DRAFT', id:'batch', index:0, text:'My unsent draft'};
  assert.equal((await s.message(draft, {tab:{id:1}})).ok, true);
  assert.equal(s.data.queue.draftBackups[0].text,'My unsent draft');
  await s.message(draft, {tab:{id:1}});
  assert.equal(s.data.queue.draftBackups.length,1);
  await s.message({type:'DOWNLOAD_DRAFT'});
  assert.match(s.downloads[0].filename,/previous-chat-draft.txt$/);
  await s.result(); await s.tick();
  assert.equal(s.sent.filter(m => m.type === 'GENERATE')[1].replaceInitialDraft, false);
  assert.equal((await s.message({...draft,index:1}, {tab:{id:1}})).ok, false);
});
test('rejects draft backups from other tabs without changing stored state', async () => {
  const s = setup(); await s.start();
  const reply = await s.message({type:'SAVE_DRAFT',id:'batch',index:0,text:'wrong tab'}, {tab:{id:2}});
  assert.equal(reply.ok, false); assert.equal(s.data.queue.draftBackups,undefined);
});
