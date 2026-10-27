(() => {
  let active = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const instanceId = crypto.randomUUID();
  const composer = () => [...document.querySelectorAll('#prompt-textarea, textarea[placeholder], [contenteditable="true"][role="textbox"], [contenteditable="true"].ProseMirror, [contenteditable="true"][data-lexical-editor], form [contenteditable="true"], main textarea, main [contenteditable="true"]')].find(node => (node instanceof HTMLTextAreaElement || node.isContentEditable) && visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
  async function waitForComposer(token) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (active !== token) return null;
      const input = composer(); if (input) return input;
      await sleep(400);
    }
    throw Error('Chat input not found after waiting 60 seconds. Sign in to ChatGPT, open a normal chat, then Resume.');
  }
  const busy = () => [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop generating"], [data-testid*="image"][aria-busy="true"], [data-is-streaming="true"]')].some(visible);
  const turns = () => [...document.querySelectorAll('[data-message-author-role="assistant"], article[data-testid^="conversation-turn-"]')];
  const allImages = () => [...document.querySelectorAll('main img, [role="main"] img')];
  const visible = node => Boolean(node.getClientRects().length);
  async function chooseImageTool() {
    const findImage = () => [...document.querySelectorAll('button, [role="menuitem"], [role="option"]')].find(node => visible(node) && /^create image$/i.test((node.textContent || node.getAttribute('aria-label') || '').trim()));
    let image = findImage();
    if (image) { image.click(); return; }
    const tools = [...document.querySelectorAll('button')].find(node => visible(node) && /^(tools|view all tools)$/i.test((node.getAttribute('aria-label') || node.textContent || '').trim()));
    if (!tools) return;
    tools.click(); await sleep(400);
    image = findImage();
    if (image) image.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  }
  function images(nodes) {
    return nodes.flatMap(node => [...node.querySelectorAll('img')]).filter(img => img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256).map(img => img.currentSrc || img.src).filter(url => /^(https:|blob:|data:image\/)/.test(url));
  }
  function draftText(input) {
    if (input instanceof HTMLTextAreaElement) return input.value;
    const copy = input.cloneNode(true);
    // Tool chips and placeholder decorations are not text the user has drafted.
    copy.querySelectorAll('[contenteditable="false"], [aria-hidden="true"], [data-placeholder]:not([contenteditable="true"])').forEach(node => node.remove());
    copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    copy.querySelectorAll('p, div, li').forEach(node => node.append('\n'));
    return (copy.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00a0/g, ' ');
  }
  function writeText(input, text) {
    input.focus();
    if (input instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    } else {
      const selection = getSelection(); const range = document.createRange();
      range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range);
      const changed = text ? document.execCommand('insertText', false, text) : document.execCommand('delete', false);
      if (!changed && draftText(input).trim()) throw Error('Unable to update the ChatGPT editor.');
    }
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null}));
  }
  const normalized = text => text.replace(/\s+/g, ' ').trim();
  async function prepareDraft(input, message, prompt, token) {
    const draft = draftText(input);
    if (!draft.trim() || normalized(draft) === normalized(prompt)) return;
    // The batch's first tab can restore ChatGPT's shared unsent draft. Preserve
    // it before replacing it. Never erase a draft typed between later prompts.
    if (!message.replaceInitialDraft || message.index !== 0) throw Error('Text was entered in the batch chat. Save or clear that draft, then Resume.');
    const saved = await chrome.runtime.sendMessage({type: 'SAVE_DRAFT', id: message.id, index: message.index, text: draft});
    if (!saved?.ok) throw Error('Could not back up the existing chat draft. It was left unchanged.');
    if (active !== token) return;
    writeText(input, '');
    if (draftText(input).trim()) throw Error('ChatGPT did not clear the saved draft. Clear the input manually and Resume.');
  }
  async function generate(message, token) {
    let submitted = false;
    try {
      let input = await waitForComposer(token);
      if (!input || active !== token) return;
      if (busy()) throw Error('Wait for the current ChatGPT response to finish before starting.');
      const prompt = `Create an image using the image generation tool. Generate the image rather than replying with instructions.\n\n${message.prompt}`;
      await prepareDraft(input, message, prompt, token);
      if (active !== token) return;
      const beforeImages = new Set(images(turns()));
      const existingImages = new Set(allImages().map(img => img.currentSrc || img.src));
      const beforeCount = turns().length;
      await chooseImageTool();
      if (active !== token) return;
      input = await waitForComposer(token);
      if (!input || active !== token) return;
      // Tool selection can remount the editor or restore its saved value.
      await prepareDraft(input, message, prompt, token);
      if (active !== token) return;
      writeText(input, prompt);
      let send;
      for (let n = 0; n < 30; n++) {
        if (active !== token) return;
        send = [...document.querySelectorAll('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"], form button[type="submit"]')].find(visible);
        if (send && !send.disabled) break;
        await sleep(200);
      }
      if (!send || send.disabled) throw Error('Send button unavailable. Check ChatGPT and your image-generation access.');
      send.click(); submitted = true;
      let last = '', stableSince = Date.now();
      const deadline = Date.now() + 12 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(1500);
        if (active !== token) return;
        // Compare sources, not DOM identity: ChatGPT may re-render previous turns.
        const fresh = turns().slice(beforeCount);
        const inTurns = images(turns()).filter(url => !beforeImages.has(url));
        const generatedOutsideTurns = allImages().filter(img => img.closest('[data-testid*="image"], [data-testid*="conversation-turn"], [data-message-author-role="assistant"]') && !existingImages.has(img.currentSrc || img.src));
        const urls = [...new Set([...inTurns, ...images([{querySelectorAll: () => generatedOutsideTurns}])])];
        const signature = JSON.stringify(urls);
        if (signature !== last || busy()) { last = signature; stableSince = Date.now(); }
        if (urls.length && !busy() && Date.now() - stableSince > 12000) {
          // Copy bytes now: ChatGPT image URLs may expire before a later bulk download.
          const data = [];
          for (const url of urls) {
            try {
              const response = await fetch(url, {credentials: 'include'});
              if (!response.ok) throw Error(`Image fetch failed (${response.status}).`);
              const blob = await response.blob();
              if (!blob.type.startsWith('image/')) throw Error('Image response was not an image.');
              data.push(await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }));
            } catch (error) {
              // Chrome's download manager can fetch signed HTTPS assets even when
              // page fetch is blocked by the image CDN's cross-origin policy.
              if (!url.startsWith('https://')) throw error;
              data.push(url);
            }
          }
          if (active !== token) return;
          await chrome.runtime.sendMessage({type: 'RESULT', id: message.id, index: message.index, urls: data});
          return;
        }
        if (fresh.length && !urls.length && !busy() && Date.now() - stableSince > 90000) throw Error('No generated image detected. Check for usage limits, a refusal, or a changed ChatGPT interface.');
      }
      throw Error('Timed out waiting for an image. Check ChatGPT before resuming to avoid submitting the prompt twice.');
    } catch (e) {
      if (active === token) await chrome.runtime.sendMessage({type: 'RESULT', id: message.id, index: message.index, error: e.message + (submitted ? ' Resume retries this prompt.' : '')});
    } finally { if (active === token) active = null; }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'CHECK') { reply({ready: Boolean(composer()), instanceId}); return; }
    if (message.type === 'CANCEL') { active = null; reply({ok: true}); return; }
    if (message.type === 'GENERATE') {
      if (active) { reply({ok: false}); return; }
      const token = {}; active = token;
      reply({ok: true}); void generate(message, token);
    }
  });
  chrome.runtime.sendMessage({type: 'READY', instanceId}).catch(() => {});
})();
