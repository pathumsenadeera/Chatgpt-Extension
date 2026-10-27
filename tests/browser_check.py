"""Offline browser integration checks. Requires Python playwright and Chromium.
No requests are sent to ChatGPT; a local fixture exercises the editor adapter.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 480, 'height': 1000}, device_scale_factor=1)
    page.route('https://studio.test/**', lambda r: r.fulfill(path=str(ROOT / r.request.url.split('/')[-1])))
    page.add_init_script('''
      window.testData = {}; window.commands = [];
      window.chrome = {storage: {local: {
        get: async keys => window.testData,
        set: async values => Object.assign(window.testData, values)
      }, onChanged: {addListener: fn => window.changed = fn}}, runtime: {
        sendMessage: async message => {window.commands.push(message);return {ok:true};}
      }};
    ''')
    page.goto('https://studio.test/popup.html')
    page.wait_for_function("document.querySelector('#start').disabled")
    text = '01. CHRISTMAS BELL\r\nDesign a golden bell.\r\n\r\nUse a white square background.\r\n\r\n02. SNOWMAN\r\nA joyful snowman.\r\n\r\n03. TREE\r\nA watercolor tree.'
    page.locator('#file').set_input_files({'name': 'holiday-prompts.txt', 'mimeType': 'text/plain', 'buffer': text.encode()})
    page.wait_for_function("document.querySelector('#prompt-count').textContent === '3 prompts detected'")
    assert page.locator('#preview-list li').count() == 3
    assert 'white square background' in page.locator('#preview-list li').first.inner_text()
    assert page.locator('#filename').inner_text() == 'holiday-prompts.txt'
    page.locator('#start').click()
    page.wait_for_function("window.commands.length === 1")
    assert len(page.evaluate('window.commands[0].prompts')) == 3
    page.locator('#format').select_option('separator')
    assert page.locator('#prompt-count').inner_text() == '1 prompt detected'
    page.locator('#format').select_option('auto')
    page.evaluate('''window.testData.queue = {prompts: window.commands[0].prompts, index:1, images:[{}],status:'running',pending:true,phase:'generating',error:''};window.changed({queue:{}},'local');''')
    page.wait_for_function("document.querySelector('#completed').textContent === '1 / 3'")
    assert page.locator('#pause').is_enabled()
    assert page.locator('#start').is_hidden()
    page.locator('#preview').evaluate('e => e.open = false')
    page.screenshot(path='/workspace/image-queue-v2.png', full_page=True)
    print('PASS: TXT import, numbered multiline count, separator override, preview, Start payload, queue progress, side-panel layout.')
    page.close()

    # Exercise the actual content.js in a browser with a delayed, non-ID editor.
    page = browser.new_page()
    page.route('https://chatgpt.com/**', lambda r: r.fulfill(body='<html><body><main></main></body></html>', content_type='text/html'))
    page.goto('https://chatgpt.com/')
    page.clock.install()
    page.evaluate('''window.results=[];window.submitted=[];window.chrome={runtime:{onMessage:{addListener:fn=>window.receive=fn},sendMessage:async m=>{window.results.push(m);return {ok:true}}}};''')
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.evaluate('''window.receive({type:'GENERATE',id:'fixture',index:0,prompt:'A mountain garden'}, {}, ()=>{});''')
    page.clock.run_for(800)
    assert page.evaluate('window.submitted.length') == 0
    page.evaluate('''
      const main=document.querySelector('main');
      main.innerHTML='<form><div contenteditable="true" role="textbox"></div><button type="submit" aria-label="Send message">Send</button></form>';
      main.querySelector('form').onsubmit=e=>{
        e.preventDefault();window.submitted.push(main.querySelector('[contenteditable]').innerText);
        main.querySelector('[contenteditable]').textContent='';
        const turn=document.createElement('article');turn.dataset.testid='conversation-turn-'+window.submitted.length;
        turn.innerHTML='<div data-message-author-role="assistant"><img width="512" height="512"></div><button data-testid="stop-button">Stop</button>';
        turn.querySelector('img').src='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="green"/></svg>');
        main.append(turn);
      };
      void 0;
    ''')
    page.clock.run_for(2000)
    page.wait_for_function('window.submitted.length === 1')
    assert 'A mountain garden' in page.evaluate('window.submitted[0]')
    page.wait_for_function('document.querySelector("img").naturalWidth === 512')
    page.clock.run_for(20000)
    assert page.evaluate("window.results.filter(m=>m.type==='RESULT').length") == 0
    page.evaluate("document.querySelector('[data-testid=stop-button]').remove()")
    page.clock.run_for(18000)
    page.wait_for_function("window.results.some(m=>m.type==='RESULT')")
    first = page.evaluate("window.results.find(m=>m.type==='RESULT')")
    assert not first.get('error'), first
    assert len(first['urls']) == 1
    # Wait for the first async monitor's finally block before another GENERATE.
    page.wait_for_timeout(50)
    page.evaluate('''window.receive({type:'GENERATE',id:'fixture',index:1,prompt:'A seaside village'}, {}, ()=>{});''')
    page.clock.run_for(1000)
    assert page.evaluate('window.submitted.length') == 2
    page.wait_for_function('document.querySelectorAll("img")[1].naturalWidth === 512')
    # Change the new source to distinguish this image from the previous one.
    page.evaluate('''document.querySelectorAll('img')[1].src='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="blue"/></svg>');document.querySelector('[data-testid=stop-button]').remove();''')
    page.wait_for_function('document.querySelectorAll("img")[1].complete')
    page.clock.run_for(18000)
    page.wait_for_function("window.results.filter(m=>m.type==='RESULT').length === 2")
    second = page.evaluate("window.results.filter(m=>m.type==='RESULT')[1]")
    assert not second.get('error'), second
    assert len(second['urls']) == 1
    assert first['urls'][0] != second['urls'][0]
    print('PASS: delayed composer without #prompt-textarea, actual text insertion/send, waits during streaming, finished image capture, next prompt in same chat, no previous-image duplication.')
    # Draft-regression checks exercise real textarea/contenteditable editing.
    for name, markup, draft, index, replace, backup_ok in [
        ('restored textarea', '<div id="prompt-textarea">Ask ChatGPT<textarea placeholder="Message"></textarea></div>', 'An unfinished idea', 0, True, True),
        ('restored rich editor', '<div contenteditable="true" role="textbox"><p></p></div>', 'A saved multiline idea\nwith details', 0, True, True),
        ('decorations only', '<div contenteditable="true" role="textbox"><span contenteditable="false">Create image</span><span aria-hidden="true">Ask ChatGPT</span><p><br></p></div>', '', 0, True, True),
        ('backup failure', '<textarea placeholder="Message"></textarea>', 'Do not lose this draft', 0, True, False),
        ('draft during later prompt', '<textarea placeholder="Message"></textarea>', 'User typed while paused', 1, False, True),
        ('retry same extension draft', '<textarea placeholder="Message"></textarea>', 'Create an image using the image generation tool. Generate the image rather than replying with instructions.\n\nA forest', 1, False, True),
    ]:
        page = browser.new_page()
        page.route('https://chatgpt.com/**', lambda r: r.fulfill(body='<html><body><main></main></body></html>', content_type='text/html'))
        page.goto('https://chatgpt.com/')
        page.evaluate('''({markup,draft,backupOK}) => {
          document.querySelector('main').innerHTML='<form>'+markup+'<button type="submit">Send</button></form>';
          const input=document.querySelector('textarea,[contenteditable="true"]');
          if (draft) {if (input.tagName === 'TEXTAREA') input.value=draft;else input.textContent=draft;}
          window.results=[];window.sent=[];
          window.chrome={runtime:{onMessage:{addListener:fn=>window.receive=fn},sendMessage:async m=>{window.results.push(m);return {ok:m.type==='SAVE_DRAFT'?backupOK:true}}}};
          document.querySelector('form').onsubmit=e=>{e.preventDefault();window.sent.push(input.value ?? input.innerText);};
        }''', {'markup':markup,'draft':draft,'backupOK':backup_ok})
        page.add_script_tag(path=str(ROOT / 'content.js'))
        response = page.evaluate('''() => new Promise(resolve=>window.receive({type:'CHECK'}, {}, resolve))''')
        assert response['ready'] and response['instanceId'], name
        page.evaluate('''({index,replace})=>window.receive({type:'GENERATE',id:'draft-test',index,prompt:'A forest',replaceInitialDraft:replace}, {}, ()=>{})''', {'index':index,'replace':replace})
        success = backup_ok and (replace or not draft or name == 'retry same extension draft')
        if success:
            page.wait_for_function('window.sent.length === 1')
            assert 'A forest' in page.evaluate('window.sent[0]'), name
            if draft and index == 0:
                assert page.evaluate("window.results.find(m=>m.type==='SAVE_DRAFT').text").strip() == draft, name
        else:
            page.wait_for_function("window.results.some(m=>m.type==='RESULT' && m.error)")
            assert page.evaluate('window.sent.length') == 0, name
            assert page.locator('textarea').input_value() == draft, name
        print('PASS: '+name)
        page.close()
    browser.close()
