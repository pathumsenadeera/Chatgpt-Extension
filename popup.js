const $ = id => document.getElementById(id);
const parsePrompts = value => value.split(/^\s*---\s*$/m).map(p => p.trim()).filter(Boolean);
let currentQueue;
function countPrompts() {
  const count = parsePrompts($('prompts').value).length;
  $('prompt-count').textContent = `${count} prompt${count === 1 ? '' : 's'}`;
  $('start').disabled = count === 0 || count > 100;
}
function selectTab(tab) {
  for (const name of ['compose', 'queue']) {
    const selected = name === tab;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
    $(`${name}-panel`).hidden = !selected;
  }
}
for (const tab of ['compose', 'queue']) {
  $(`${tab}-tab`).onclick = () => selectTab(tab);
  $(`${tab}-tab`).onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'compose' : event.key === 'End' ? 'queue' : tab === 'compose' ? 'queue' : 'compose';
      selectTab(next); $(`${next}-tab`).focus();
    }
  };
}
function notify(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
chrome.storage.local.get(['draft', 'delay']).then(s => {
  $('prompts').value = s.draft || ''; $('delay').value = s.delay || 10; countPrompts();
});
$('prompts').addEventListener('input', () => {
  countPrompts(); chrome.storage.local.set({draft: $('prompts').value});
});
$('delay').addEventListener('change', () => {
  $('delay').value = Math.max(5, Math.min(300, Number($('delay').value) || 10));
  chrome.storage.local.set({delay: Number($('delay').value)});
});
$('example').onclick = () => {
  const example = 'A tiny glass greenhouse floating above a sea of clouds, warm morning light, dreamy editorial photography';
  $('prompts').value += ($('prompts').value.trim() ? '\n---\n' : '') + example;
  $('prompts').dispatchEvent(new Event('input')); $('prompts').focus();
};
async function command(type, extra = {}) {
  try {
    const result = await chrome.runtime.sendMessage({type, ...extra});
    if (!result?.ok) throw new Error(result?.error || 'Extension did not respond.');
    if (type === 'START') selectTab('queue');
    await render();
    if (type === 'DOWNLOAD') notify('Downloads requested. Check Chrome’s downloads for progress.');
  } catch (error) { notify(error.message, true); }
}
$('start').onclick = () => command('START', {prompts: parsePrompts($('prompts').value), delay: Number($('delay').value)});
for (const type of ['pause', 'resume', 'stop', 'download']) $(type).onclick = () => command(type.toUpperCase());
async function render() {
  const {queue} = await chrome.storage.local.get('queue');
  currentQueue = queue;
  countPrompts();
  const active = queue && ['running', 'paused'].includes(queue.status);
  $('start').hidden = Boolean(active); $('run-controls').hidden = !active;
  $('pause').hidden = queue?.status !== 'running'; $('resume').hidden = queue?.status !== 'paused';
  $('download').disabled = !queue?.images.length;
  if (!queue) return;
  $('queue-count').textContent = queue.prompts.length;
  $('queue-state').textContent = queue.status;
  $('completed').replaceChildren(document.createTextNode(String(queue.index)));
  const total = document.createElement('span'); total.textContent = `/ ${queue.prompts.length}`; $('completed').append(total);
  $('image-count').textContent = queue.images.length;
  const percentage = Math.round(queue.index / queue.prompts.length * 100);
  $('progress-fill').style.width = `${percentage}%`;
  document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(percentage));
  $('queue-list').replaceChildren(...queue.prompts.map((prompt, index) => {
    const li = document.createElement('li');
    const done = index < queue.index; const current = index === queue.index && active;
    li.className = done ? 'done' : current ? 'current' : '';
    const number = document.createElement('span'); number.className = 'item-number'; number.textContent = done ? '✓' : String(index + 1).padStart(2, '0');
    const text = document.createElement('span'); text.className = 'item-text'; text.textContent = prompt; text.title = prompt;
    li.append(number, text); return li;
  }));
  const messages = {
    running: queue.pending ? `Creating image ${queue.index + 1} of ${queue.prompts.length}. Let the ideas flow.` : 'Taking a short breather. Your next prompt is up soon.',
    paused: queue.pending ? 'Pausing after the current image finishes.' : 'Queue paused. Resume whenever you’re ready.',
    completed: 'Your collection is complete. Find your images in Downloads.',
    stopped: 'Queue stopped. Your collected images are still available.'
  };
  notify(queue.error || messages[queue.status] || 'Ready for your next idea.', Boolean(queue.error));
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.queue) void render(); });
render().then(() => { if (currentQueue && ['running', 'paused'].includes(currentQueue.status)) selectTab('queue'); });
