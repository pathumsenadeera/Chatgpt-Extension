const $ = id => document.getElementById(id);
let currentQueue, parsed = [];
function notify(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function updatePrompts() {
  parsed = PromptParser.parsePrompts($('prompts').value, $('format').value);
  const count = parsed.length;
  $('prompt-count').textContent = `${count} prompt${count === 1 ? '' : 's'} detected`;
  $('preview-count').textContent = count;
  $('preview-list').replaceChildren(...parsed.map(prompt => { const li = document.createElement('li'); li.textContent = prompt; return li; }));
  $('start').disabled = count === 0 || count > 100;
  $('parse-note').textContent = count > 100 ? 'Maximum 100 prompts per batch. Split this file into smaller batches.' : 'Check the preview before starting. Change the separator if the count looks wrong.';
}
function saveDraft() {
  updatePrompts();
  chrome.storage.local.set({draft: $('prompts').value, format: $('format').value});
}
$('prompts').oninput = saveDraft;
$('format').onchange = saveDraft;
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw Error('Please use a text file smaller than 5 MB.');
    $('prompts').value = await file.text();
    $('filename').textContent = file.name;
    saveDraft(); $('preview').open = true;
  } catch (e) { notify(e.message, true); }
  $('file').value = '';
};
$('delay').onchange = () => {
  $('delay').value = Math.max(5, Math.min(300, Number($('delay').value) || 10));
  chrome.storage.local.set({delay: Number($('delay').value)});
};
async function command(type, extra = {}) {
  try {
    if (type === 'START') { $('start').disabled = true; notify('Opening a new ChatGPT chat…'); }
    const result = await chrome.runtime.sendMessage({type, ...extra});
    if (!result?.ok) throw Error(result?.error || 'Extension did not respond. Reload it in chrome://extensions.');
    await render();
    if (type === 'DOWNLOAD') notify('Downloads requested. Check Chrome’s downloads for progress.');
  } catch (e) { updatePrompts(); notify(e.message, true); }
}
$('start').onclick = () => { updatePrompts(); if (parsed.length) void command('START', {prompts: parsed, delay: Number($('delay').value)}); };
$('download-draft').onclick = () => command('DOWNLOAD_DRAFT');
for (const type of ['pause', 'resume', 'stop', 'download']) $(type).onclick = () => command(type.toUpperCase());
async function render() {
  const {queue} = await chrome.storage.local.get('queue'); currentQueue = queue; updatePrompts();
  const active = queue && ['running', 'paused'].includes(queue.status);
  $('start').hidden = Boolean(active); $('resume').hidden = queue?.status !== 'paused';
  $('pause').disabled = queue?.status !== 'running'; $('stop').hidden = !active;
  $('download').disabled = !queue?.images.length;
  $('draft-backup').hidden = !queue?.draftBackups?.length;
  if (!queue) return;
  $('queue-state').textContent = queue.status;
  $('completed').textContent = `${queue.index} / ${queue.prompts.length}`;
  $('image-count').textContent = `${queue.images.length} image${queue.images.length === 1 ? '' : 's'}`;
  const percentage = Math.round(queue.index / queue.prompts.length * 100);
  $('progress-fill').style.width = `${percentage}%`;
  document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(percentage));
  $('queue-list').replaceChildren(...queue.prompts.map((prompt, index) => {
    const li = document.createElement('li');
    li.className = index < queue.index ? 'done' : index === queue.index && active ? 'current' : '';
    const number = document.createElement('span'); number.className = 'item-number'; number.textContent = index < queue.index ? '✓' : String(index + 1).padStart(2, '0');
    const text = document.createElement('span'); text.className = 'item-text'; text.textContent = prompt; text.title = prompt;
    li.append(number, text); return li;
  }));
  const messages = {
    running: queue.phase === 'opening' ? 'Opening ChatGPT. Waiting for the chat input to be ready…' : queue.pending ? `Generating image ${queue.index + 1} of ${queue.prompts.length}. Waiting for the finished image…` : 'Image collected. The next prompt will be sent shortly.',
    paused: queue.pending ? 'Pausing after the current image finishes.' : 'Queue paused. Check ChatGPT before resuming.',
    completed: 'Your collection is complete. Find your images in Downloads.',
    stopped: 'Queue stopped. Collected images are still available.'
  };
  notify(queue.error || messages[queue.status] || 'Ready.', Boolean(queue.error));
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.queue) void render(); });
chrome.storage.local.get(['draft', 'delay', 'format']).then(s => {
  $('prompts').value = s.draft || ''; $('delay').value = s.delay || 10; $('format').value = s.format || 'auto';
  return render();
}).catch(e => notify(e.message, true));
