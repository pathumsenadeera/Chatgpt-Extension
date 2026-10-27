# Image Queue for ChatGPT

A dependency-free Chrome Manifest V3 extension. Paste multiple image prompts separated by a line containing `---`. The extension sends one prompt at a time to your active ChatGPT conversation, waits for a finished image, and saves it before moving on.

## Install

1. Download or clone this repository to your computer.
2. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this folder.
3. Open or refresh `https://chatgpt.com`, sign in, and open a conversation with image generation available. Clear any existing composer draft.
4. Click the extension, enter prompts, and choose **Start queue**. Keep the ChatGPT tab open and avoid sending messages manually during the run.

Images download automatically into `Downloads/ChatGPT-Image-Queue/<batch-id>/`. Chrome controls the download directory; extensions cannot write to arbitrary folders. Downloads happen as images finish so progress is retained if a later prompt fails. The button to download finished images again replays the saved downloads.

**Pause** finishes the current prompt and prevents the next one. **Resume** continues or retries a failed prompt. **Stop** cancels queue monitoring; a request already submitted to ChatGPT may continue there. Check the conversation before retrying a timed-out prompt. Reloading the ChatGPT tab during generation interrupts monitoring; stop and start a new queue if necessary.

## Limits and privacy

This uses ChatGPT's website UI, which can change. It selects **Create image** when that English-language control is exposed directly or in a **Tools** menu, and also explicitly requests the image-generation tool in the prompt. It detects newly returned assistant images and waits for streaming to stop and the image to stabilize. Live generation and download access must be checked with your own signed-in account. Your account's usage limits, safety checks, and applicable service terms still apply; the extension pauses on missing images instead of trying to bypass restrictions.

Prompts and generated image bytes are stored locally in Chrome extension storage, without a separate server or API key. Remove the extension to clear its stored data. A new batch replaces the extension's previous batch history, but downloaded files remain. The extension requests unlimited local storage for image bytes; large batches still consume memory and disk, so start with a small batch. Image assets displayed by ChatGPT must be fetchable by the page; inaccessible assets pause the queue.

## Development

Requires Node.js 18+ for tests; the extension has no package dependencies or build step. Run `node --test tests/*.test.cjs`. Reload the extension in Chrome after edits, then refresh ChatGPT. Actual ChatGPT integration needs a signed-in Chrome session and image-generation access.
