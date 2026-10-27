let serial = Promise.resolve();
const read = async () => (await chrome.storage.local.get('queue')).queue;
const save = queue => chrome.storage.local.set({queue});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);
async function download(images) {
  for (const image of images) await chrome.downloads.download({url: image.url, filename: image.filename, conflictAction: 'uniquify', saveAs: false});
}
async function pauseWithError(queue, error) {
  queue.pending = false; queue.status = 'paused'; queue.error = error;
  await save(queue);
}
async function dispatch(message) {
  let queue = await read();
  if (message.type === 'START') {
    if (queue && ['running', 'paused'].includes(queue.status)) throw Error('Stop the existing queue first.');
    if (!Array.isArray(message.prompts) || !message.prompts.length || message.prompts.length > 100 || message.prompts.some(p => typeof p !== 'string' || !p.trim())) throw Error('Enter between 1 and 100 nonempty prompts.');
    // A fresh tab is intentional: never overwrite an existing conversation or draft.
    const tab = await chrome.tabs.create({url: 'https://chatgpt.com/', active: true});
    queue = {id: crypto.randomUUID(), tabId: tab.id, prompts: message.prompts, index: 0, images: [], status: 'running', phase: 'opening', delay: Math.max(5, Math.min(300, Number(message.delay) || 10)), error: '', pending: false, openingDeadline: Date.now() + 90000};
    await chrome.storage.local.set({delay: queue.delay}); await save(queue);
    await chrome.alarms.create('next', {when: Date.now() + 1000});
    await chrome.alarms.create('watchdog', {periodInMinutes: 1});
  } else if (message.type === 'READY') {
    if (!queue || queue.status === 'stopped' || queue.status === 'completed') return;
    if (queue.pending && queue.instanceId !== message.instanceId) {
      await pauseWithError(queue, 'ChatGPT was reloaded during generation. Check the last image before resuming; Resume retries the current prompt.');
    } else if (!queue.pending && queue.phase === 'opening') await step(queue);
  } else if (message.type === 'SAVE_DRAFT') {
    if (!queue || queue.id !== message.id || !queue.pending || queue.index !== 0 || message.index !== 0 || typeof message.text !== 'string') throw Error('Draft backup does not match the active batch.');
    queue.draftBackups ||= [];
    if (!queue.draftBackups.some(backup => backup.text === message.text)) queue.draftBackups.push({text: message.text, savedAt: Date.now()});
    await save(queue);
  } else if (message.type === 'DOWNLOAD_DRAFT') {
    if (!queue?.draftBackups?.length) throw Error('No saved draft available.');
    await chrome.downloads.download({url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(queue.draftBackups.map(backup => backup.text).join('\n\n--- saved draft ---\n\n')), filename: `ChatGPT-Image-Queue/${queue.id}/previous-chat-draft.txt`, conflictAction: 'uniquify', saveAs: false});
  } else if (message.type === 'RESULT') {
    if (!queue || queue.id !== message.id || !queue.pending || queue.index !== message.index || queue.status === 'stopped') return;
    queue.pending = false;
    if (message.error) { queue.status = 'paused'; queue.error = message.error; }
    else if (!Array.isArray(message.urls) || !message.urls.length || message.urls.some(url => typeof url !== 'string' || !/^(?:data:image\/[\w.+-]+;base64,|https:\/\/)/.test(url))) {
      queue.status = 'paused'; queue.error = 'No downloadable image received. Check the ChatGPT response before retrying.';
    } else {
      const images = message.urls.map((url, i) => {
        const mime = url.startsWith('data:') ? url.split(';')[0].slice(5) : '';
        const ext = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'}[mime] || 'png';
        return {url, filename: `ChatGPT-Image-Queue/${queue.id}/${String(queue.index + 1).padStart(3, '0')}-${i + 1}.${ext}`};
      });
      queue.images.push(...images); queue.index++; queue.phase = 'waiting';
      try { await download(images); }
      catch (e) { queue.status = 'paused'; queue.error = 'Download failed: ' + e.message + '. Use Download collected images again.'; }
      if (queue.index === queue.prompts.length && queue.status === 'running') queue.status = 'completed';
    }
    await save(queue);
    if (queue.status === 'running') await chrome.alarms.create('next', {when: Date.now() + queue.delay * 1000});
  } else if (message.type === 'DOWNLOAD') { if (queue) await download(queue.images); }
  else if (queue) {
    if (message.type === 'PAUSE' && queue.status === 'running') queue.status = 'paused';
    if (message.type === 'STOP') {
      queue.status = 'stopped'; queue.pending = false;
      await chrome.tabs.sendMessage(queue.tabId, {type: 'CANCEL'}).catch(() => {});
      await chrome.alarms.clear('next'); await chrome.alarms.clear('watchdog');
    }
    if (message.type === 'RESUME') {
      if (queue.status !== 'paused') throw Error('Queue is not paused.');
      queue.status = queue.index === queue.prompts.length ? 'completed' : 'running'; queue.error = '';
      queue.openingDeadline = Date.now() + 90000;
    }
    await save(queue);
    if (message.type === 'RESUME') await step(queue);
  }
}
async function step(queue) {
  if (queue.status !== 'running' || queue.pending || queue.index >= queue.prompts.length) return;
  let ready;
  try { ready = await chrome.tabs.sendMessage(queue.tabId, {type: 'CHECK'}); }
  catch {
    if (queue.phase === 'opening' && Date.now() < queue.openingDeadline) {
      await chrome.alarms.create('next', {when: Date.now() + 2000}); return;
    }
    await pauseWithError(queue, 'Cannot reach the ChatGPT tab. Keep the new tab open, sign in, and Resume.'); return;
  }
  queue.instanceId = ready.instanceId; queue.pending = true; queue.phase = 'generating'; queue.startedAt = Date.now(); await save(queue);
  try {
    const result = await chrome.tabs.sendMessage(queue.tabId, {type: 'GENERATE', id: queue.id, index: queue.index, prompt: queue.prompts[queue.index], replaceInitialDraft: queue.index === 0});
    if (!result?.ok) throw Error('A previous generation is still being monitored. Wait for it to finish.');
  } catch (e) { await pauseWithError(queue, e.message || 'ChatGPT tab unavailable.'); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serial = serial.catch(() => {}).then(async () => {
    if (['RESULT', 'READY', 'SAVE_DRAFT'].includes(message.type) && (sender.tab?.id == null || sender.tab.id !== (await read())?.tabId)) throw Error('Message did not come from the batch tab.');
    await dispatch(message);
  });
  serial.then(() => respond({ok: true}), e => respond({ok: false, error: e.message})); return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  serial = serial.catch(() => {}).then(async () => {
    const queue = await read(); if (!queue) return;
    if (alarm.name === 'next') await step(queue);
    if (alarm.name === 'watchdog' && queue.pending && Date.now() - queue.startedAt > 15 * 60 * 1000) {
      await chrome.tabs.sendMessage(queue.tabId, {type: 'CANCEL'}).catch(() => {});
      await pauseWithError(queue, 'Image monitoring timed out. Check ChatGPT before resuming to avoid duplicate prompts.');
    }
  });
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial = serial.catch(() => {}).then(async () => {
    const queue = await read();
    if (queue?.tabId === tabId && ['running', 'paused'].includes(queue.status)) {
      queue.status = 'stopped'; queue.pending = false; queue.error = 'ChatGPT tab closed.'; await save(queue);
    }
  });
});
