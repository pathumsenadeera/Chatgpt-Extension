let serial = Promise.resolve();
const read = async () => (await chrome.storage.local.get('queue')).queue;
const save = queue => chrome.storage.local.set({queue});
async function download(images) {
  for (const image of images) await chrome.downloads.download({url: image.url, filename: image.filename, conflictAction: 'uniquify', saveAs: false});
}
async function dispatch(message) {
  let queue = await read();
  if (message.type === 'START') {
    if (queue && ['running', 'paused'].includes(queue.status)) throw Error('Stop the existing queue first.');
    if (!Array.isArray(message.prompts) || !message.prompts.length || message.prompts.length > 100) throw Error('Enter between 1 and 100 prompts.');
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.url?.startsWith('https://chatgpt.com/')) throw Error('Open a ChatGPT conversation first.');
    const ready = await chrome.tabs.sendMessage(tab.id, {type: 'CHECK'});
    if (!ready?.ready) throw Error('Sign in and open a ChatGPT conversation with a visible composer.');
    queue = {id: crypto.randomUUID(), tabId: tab.id, prompts: message.prompts, index: 0, images: [], status: 'running', delay: Math.max(5, Math.min(300, message.delay || 10)), error: '', pending: false};
    await chrome.storage.local.set({delay: queue.delay});
    await save(queue);
    await step(queue);
  } else if (message.type === 'RESULT') {
    if (!queue || queue.id !== message.id || !queue.pending || queue.index !== message.index || queue.status === 'stopped') return;
    queue.pending = false;
    if (message.error) { queue.status = 'paused'; queue.error = message.error; }
    else {
      const images = message.urls.map((url, i) => ({url, filename: `ChatGPT-Image-Queue/${queue.id}/${String(queue.index + 1).padStart(3, '0')}-${i + 1}.png`}));
      queue.images.push(...images);
      queue.index++;
      try { await download(images); } catch (e) { queue.status = 'paused'; queue.error = 'Download failed: ' + e.message + '. Use Download finished images again.'; }
      if (queue.index === queue.prompts.length && queue.status === 'running') queue.status = 'completed';
    }
    await save(queue);
    if (queue.status === 'running') await chrome.alarms.create('next', {when: Date.now() + queue.delay * 1000});
  } else if (message.type === 'DOWNLOAD') { if (queue) await download(queue.images); }
  else if (queue) {
    if (message.type === 'PAUSE') queue.status = 'paused';
    if (message.type === 'STOP') {
      queue.status = 'stopped'; queue.pending = false;
      await chrome.tabs.sendMessage(queue.tabId, {type: 'CANCEL'}).catch(() => {});
    }
    if (message.type === 'RESUME') {
      if (queue.status !== 'paused') throw Error('Queue is not paused.');
      queue.status = queue.index === queue.prompts.length ? 'completed' : 'running'; queue.error = '';
    }
    await save(queue);
    if (message.type === 'RESUME') await step(queue);
  }
}
async function step(queue) {
  if (queue.status !== 'running' || queue.pending || queue.index >= queue.prompts.length) return;
  queue.pending = true; await save(queue);
  try {
    const result = await chrome.tabs.sendMessage(queue.tabId, {type: 'GENERATE', id: queue.id, index: queue.index, prompt: queue.prompts[queue.index]});
    if (!result?.ok) throw Error('Generation monitor already active.');
  }
  catch { queue.pending = false; queue.status = 'paused'; queue.error = 'ChatGPT tab unavailable. Reopen the conversation and start a new queue.'; await save(queue); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'RESULT' && sender.tab?.id == null) return;
  serial = serial.catch(() => {}).then(async () => {
    if (message.type === 'RESULT' && sender.tab.id !== (await read())?.tabId) return;
    await dispatch(message);
  });
  serial.then(() => respond({ok: true}), e => respond({ok: false, error: e.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'next') serial = serial.catch(() => {}).then(async () => { const q = await read(); if (q) await step(q); });
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial = serial.catch(() => {}).then(async () => { const q = await read(); if (q?.tabId === tabId && ['running', 'paused'].includes(q.status)) { q.status = 'stopped'; q.pending = false; q.error = 'ChatGPT tab closed.'; await save(q); } });
});
