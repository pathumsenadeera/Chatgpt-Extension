(() => {
  let active = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const composer = () => document.querySelector('#prompt-textarea');
  const busy = () => document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]');
  const turns = () => [...document.querySelectorAll('[data-message-author-role="assistant"]')];
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
  async function generate(message, token) {
    let submitted = false;
    try {
      const input = composer();
      if (!input) throw Error('ChatGPT composer not found. Sign in and open a conversation.');
      if (busy()) throw Error('Wait for the current ChatGPT response to finish before starting.');
      if ((input.value || input.textContent || '').trim()) throw Error('Clear your existing draft in ChatGPT before starting.');
      const before = new Set(turns());
      await chooseImageTool();
      if (active !== token) return;
      // Explicit image instructions also work when ChatGPT does not expose an image tool menu.
      const prompt = `Create an image using the image generation tool. Generate the image rather than replying with instructions.\n\n${message.prompt}`;
      input.focus();
      if (input instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, prompt);
      } else {
        const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, prompt)) throw Error('Unable to enter the prompt.');
      }
      input.dispatchEvent(new Event('input', {bubbles: true}));
      let send;
      for (let n = 0; n < 30; n++) {
        if (active !== token) return;
        send = document.querySelector('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]');
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
        const fresh = turns().filter(node => !before.has(node));
        const urls = [...new Set(images(fresh))];
        const signature = JSON.stringify(urls);
        if (signature !== last || busy()) { last = signature; stableSince = Date.now(); }
        if (urls.length && !busy() && Date.now() - stableSince > 12000) {
          // Copy bytes now: ChatGPT image URLs may expire before a later bulk download.
          const data = [];
          for (const url of urls) {
            const response = await fetch(url, {credentials: 'include'});
            if (!response.ok) throw Error(`Image fetch failed (${response.status}).`);
            const blob = await response.blob();
            if (!blob.type.startsWith('image/')) throw Error('Image response was not an image.');
            data.push(await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }));
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
    if (message.type === 'CHECK') { reply({ready: Boolean(composer())}); return; }
    if (message.type === 'CANCEL') { active = null; reply({ok: true}); return; }
    if (message.type === 'GENERATE') {
      if (active) { reply({ok: false}); return; }
      const token = {}; active = token;
      reply({ok: true}); void generate(message, token);
    }
  });
})();
