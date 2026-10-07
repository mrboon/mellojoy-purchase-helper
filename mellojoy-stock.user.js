// ==UserScript==
// @name         Mellojoy 購入支援スクリプト
// @version      1.9.0
// @description  ボタン最速検知／API直接追加を選択。新規掲載を1秒監視、数量1で追加後チェックアウト
// @match        https://www.mellojoyjapan.com/*
// @match        https://mellojoyjapan.com/*
// @run-at       document-start
// @sandbox      DOM
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const EXCLUDE_KEY = 'yf-product-exclusions-v1';
  const DEFAULT_EXCLUSIONS = '';
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g,'-').replace(/\s+/g,'');
  const exclusionText = () => localStorage.getItem(EXCLUDE_KEY) ?? DEFAULT_EXCLUSIONS;
  const priorityRules = () => String(localStorage.getItem('yf-product-priorities-v1') || '').split(/\r?\n/).map(normalize).filter(Boolean);
  const priorityRank = (title, rules) => {
    const text = normalize(title);
    const rank = rules.findIndex(rule => text.includes(rule));
    return rank < 0 ? rules.length : rank;
  };
  function excluded(item, product = null, variant = null) {
    const text = normalize([item.title,item.id,product?.title,product?.handle].filter(Boolean).join('\n'));
    return exclusionText().split(/\r?\n/).map(line=>line.trim()).filter(Boolean).some(rule=>{
      if (/^https?:\/\//i.test(rule)) {
        try { const path=new URL(rule).pathname.match(/\/products\/([^/]+)\/?$/i);return !!path && normalize(decodeURIComponent(path[1]))===normalize(item.id); } catch { return false; }
      }
      if (/^id:/i.test(rule)) return String(product?.id || '')===rule.slice(3).trim();
      if (/^variant:/i.test(rule)) return String(variant || '')===rule.slice(8).trim();
      return text.includes(normalize(rule));
    });
  }

  const METHOD_PREF = 'yf-cart-method-v1';
  const method = () => localStorage.getItem(METHOD_PREF) === 'api' ? 'api' : 'button';
  const isTestHost = () => ['localhost','127.0.0.1'].includes(location.hostname) && location.port === '8765';
  let apiTask = null;
  function cancelAPI() {
    if (apiTask) { apiTask.cancelled = true; apiTask.controller.abort(); apiTask = null; }
  }
  // No cart preflight, cross-browser lock or automatic retry. One invocation sends one POST.
  async function addByAPI(variant, productPath, form = null) {
    const root = productPath.match(/^(\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?)products\//i)?.[1] || '/';
    const endpoint = new URL(root + 'cart/add.js', location.origin);
    if (isTestHost()) endpoint.searchParams.set('mock_response', localStorage.getItem('yf-mock-api-response') || 'ok');
    const task = {controller:new AbortController(),cancelled:false}; apiTask = task;
    const began = performance.now();
    const timeout = setTimeout(() => task.controller.abort(), 10000);
    console.info('[Mellojoy 1.9.0] API追加開始', {variant,quantity:1});
    try {
      const response = await fetch(endpoint.href, {
        method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',
        headers:form ? {'Accept':'application/json'} : {'Content-Type':'application/json','Accept':'application/json'},
        body:form ? new FormData(form) : JSON.stringify({items:[{id:variant,quantity:1}]}),
        signal:task.controller.signal
      });
      console.info('[Mellojoy 1.9.0] API応答', {http:response.status,ms:Math.round(performance.now()-began)});
      if (!response.ok) throw new Error('カートAPI HTTP ' + response.status);
      // Shopify may label a JSON body text/javascript. Parse data; never evaluate it.
      let data;
      try { data = await response.json(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('カートAPIの応答をJSONとして読み取れません');
      }
      const items = Array.isArray(data?.items) ? data.items : [data];
      if (!items.some(item => String(item?.variant_id ?? item?.id) === variant && Number.isInteger(item.quantity) && item.quantity >= 1)) {
        throw new Error('カートAPIの追加成功を確認できません');
      }
      if (task.cancelled || localStorage.getItem('yf-fast-checkout-enabled-v1') === 'off') return false;
      console.info('[Mellojoy 1.9.0] API追加成功→チェックアウト', {ms:Math.round(performance.now()-began)});
      location.assign(new URL(root + 'checkout', location.origin).href);
      return true;
    } catch (error) {
      if (task.cancelled) return false;
      if (error.name === 'AbortError') throw new Error('カートAPIが10秒以内に応答しませんでした。追加済みの可能性があるためカートを確認してください');
      throw error;
    } finally {
      clearTimeout(timeout);
      if (apiTask === task) apiTask = null;
    }
  }
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelAPI(); }, true);
  window.addEventListener('pagehide', cancelAPI);
  function report(message, error = false) {
    console[error ? 'error' : 'info']('[Mellojoy 1.9.0] ' + message);
    let badge = document.getElementById('mellojoy-stock-startup');
    if (!badge) {
      badge = document.createElement('div'); badge.id = 'mellojoy-stock-startup';
      (document.body || document.documentElement).append(badge);
    }
    badge.style.cssText = 'position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;display:block!important;max-width:420px!important;padding:12px!important;border-radius:8px!important;background:' + (error ? '#9f1239' : '#133d35') + '!important;color:white!important;font:14px/1.6 system-ui,sans-serif!important;white-space:pre-wrap!important;box-shadow:0 4px 18px #0004!important';
    badge.textContent = message;
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('購入支援スクリプト：起動状況を表示', () => {
      const message = '購入支援スクリプトは実行されています。\nURL：' + location.href;
      if (showDiagnostics) report(message); else console.info('[Mellojoy]', message);
    });
  }
  function installFastCheckout(autoKey = null) {
    const PREF = 'yf-fast-checkout-enabled-v1';
    const PENDING = 'yf-fast-checkout-pending-v1';
    const WINDOW_MS = 60000;
    let observer = null, frame = null, expiry = null, pending = null;
    let autoObserver = null, autoFrame = null, autoDone = false;
    const enabled = () => localStorage.getItem(PREF) !== 'off';
    const persist = () => sessionStorage.setItem(PENDING, JSON.stringify(pending));
    function stop() {
      observer?.disconnect(); observer = null;
      if (frame !== null) cancelAnimationFrame(frame); frame = null;
      clearTimeout(expiry); expiry = null;
    }
    function cancel() {
      stop(); pending = null; sessionStorage.removeItem(PENDING);
    }
    function stopAuto() {
      autoObserver?.disconnect(); autoObserver = null;
      if (autoFrame !== null) cancelAnimationFrame(autoFrame); autoFrame = null;
    }
    function claimAuto() {
      autoDone = true; stopAuto();
    }
    function setEnabled(value) {
      localStorage.setItem(PREF, value ? 'on' : 'off');
      if (!value) { cancelAPI(); cancel(); stopAuto(); } else startAuto();
    }
    function actionIs(form, endpoint) {
      if (!form || String(form.method).toLowerCase() !== 'post') return false;
      try {
        const action = new URL(form.getAttribute('action'), location.href);
        return action.origin === location.origin && new RegExp('^/(?:[a-z]{2}(?:-[a-z]{2})?/)?' + endpoint + '/?$', 'i').test(action.pathname);
      } catch { return false; }
    }
    const cartForms = () => [...document.querySelectorAll('form[action]')].filter(form => actionIs(form, 'cart'));
    function quantityIn(form, variant) {
      let total = 0;
      for (const input of form.querySelectorAll('input[name="updates[]"],input[name="updates"],input[type="number"]')) {
        let id = input.getAttribute('data-quantity-variant-id') || input.getAttribute('data-variant-id');
        if (!id) {
          const row = input.closest('tr,[data-cart-item],.cart-item,.cart-items__table-row,[data-variant-id]');
          id = row?.getAttribute('data-variant-id');
          if (!id && row) {
            for (const a of row.querySelectorAll('a[href]')) {
              try {
                const url = new URL(a.getAttribute('href'), location.href);
                if (url.origin === location.origin && /\/products\/[^/]+\/?$/.test(url.pathname)) {
                  id = url.searchParams.get('variant'); if (id) break;
                }
              } catch {}
            }
          }
        }
        const value = Number(input.value);
        if (String(id) === variant && Number.isInteger(value) && value > 0) total += value;
      }
      return total;
    }
    function ready(button) {
      if (!button.isConnected || button.disabled || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true') return false;
      if (!button.getClientRects().length) return false;
      const style = getComputedStyle(button);
      return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && Number(style.opacity) > 0;
    }
    function validCheckout(button) {
      return button.type === 'submit' && button.name === 'checkout' && actionIs(button.form, 'cart') &&
        !button.hasAttribute('formaction') && !button.hasAttribute('formmethod') &&
        !button.closest('.shopify-payment-button,shopify-accelerated-checkout,.additional-checkout-buttons') && ready(button);
    }
    function openCartIfNeeded() {
      if (pending.drawerOpened) return;
      const updated = cartForms().filter(form => quantityIn(form, pending.variant) >= pending.before + pending.quantity);
      if (!updated.length) return; // Open only after this addition has actually appeared.
      for (const trigger of document.querySelectorAll('button[aria-controls],button[data-testid="cart-drawer-trigger"],a#cart-icon-bubble')) {
        if (!ready(trigger)) continue;
        const target = trigger.getAttribute('aria-controls');
        let drawer = target && /cart/i.test(target) ? document.getElementById(target) : null;
        if (!drawer && trigger.id === 'cart-icon-bubble') {
          try {
            const url = new URL(trigger.getAttribute('href'), location.href);
            if (url.origin !== location.origin || !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/?$/i.test(url.pathname)) continue;
          } catch { continue; }
          drawer = document.querySelector('cart-drawer');
        }
        if (!drawer || !updated.some(form => drawer.contains(form))) continue;
        if (trigger.getAttribute('aria-expanded') === 'true' || drawer.classList.contains('active') || drawer.querySelector('dialog[open]')) return;
        // Persist before clicking: a rerender or reload must not toggle the pane twice.
        pending.drawerOpened = true; persist();
        console.info('[Mellojoy 1.9.0] カートの右ペインを1回開く');
        try { trigger.click(); } catch (error) { console.error('[Mellojoy 1.9.0] カートを手動で開いてください。', error); }
        return;
      }
    }
    function attempt() {
      if (!pending || pending.phase !== 'armed' || !enabled()) return;
      if (Date.now() - pending.at >= WINDOW_MS) { cancel(); return; }
      for (const button of document.querySelectorAll('button[name="checkout"],input[name="checkout"]')) {
        if (!validCheckout(button)) continue;
        // A pre-existing cart must not trigger checkout before the new addition appears.
        if (quantityIn(button.form, pending.variant) < pending.before + pending.quantity) continue;
        pending.phase = 'done'; persist(); stop();
        console.info('[Mellojoy] チェックアウトを1回クリック');
        try { button.click(); } catch (error) { console.error('[Mellojoy] チェックアウト失敗。手動で操作してください。', error); }
        return;
      }
      openCartIfNeeded();
    }
    function frameCheck() {
      frame = null; attempt();
      if (pending?.phase === 'armed' && enabled()) frame = requestAnimationFrame(frameCheck);
    }
    function watch() {
      stop();
      if (!pending || pending.phase !== 'armed' || !enabled() || Date.now() - pending.at >= WINDOW_MS) { cancel(); return; }
      observer = new MutationObserver(attempt);
      observer.observe(document, {subtree:true,childList:true,attributes:true,characterData:true});
      expiry = setTimeout(cancel, Math.max(0, WINDOW_MS - (Date.now() - pending.at)));
      // The observer handles DOM updates immediately. Frames also catch CSS animations
      // and quantity value property changes without a DOM attribute mutation.
      attempt();
      if (pending?.phase === 'armed') frame = requestAnimationFrame(frameCheck);
    }
    function arm(form) {
      if (!enabled() || !actionIs(form, 'cart/add(?:\\.js)?')) return;
      const variant = String(form.elements.namedItem('id')?.value || '');
      const quantity = Number(form.elements.namedItem('quantity')?.value || 1);
      if (!/^\d+$/.test(variant) || !Number.isInteger(quantity) || quantity <= 0) return;
      claimAuto(); // A manual add also consumes this page's automatic add attempt.
      // A native click and its submit event are one add operation.
      if (pending?.phase === 'armed' && pending.variant === variant && Date.now() - pending.at < 250) return;
      const before = Math.max(0, ...cartForms().map(cart => quantityIn(cart, variant)));
      stop(); pending = {phase:'armed',variant,quantity,before,at:Date.now()}; persist(); watch();
    }
    function autoAttempt() {
      if (!autoKey || autoDone || !enabled() || pending?.phase === 'armed') return;
      for (const button of document.querySelectorAll('button[name="add"],input[name="add"][type="submit"],button[id^="ProductSubmitButton"]')) {
        const form = button.form;
        if (!button.isConnected || button.disabled || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true' || button.closest('[hidden],[inert],[aria-hidden="true"]') || button.type !== 'submit' || !actionIs(form, 'cart/add(?:\\.js)?')) continue;
        if (button.hasAttribute('formaction') || button.hasAttribute('formmethod') || button.closest('.shopify-payment-button,shopify-accelerated-checkout,.additional-checkout-buttons')) continue;
        if (button.closest('product-recommendations,related-products,quick-add-modal,quick-add-dialog,quick-add-component,.quick-add,.product-recommendations,[data-product-recommendations]')) continue;
        const id = form.elements.namedItem('id');
        const variant = String(id?.value || '');
        if (!id || id.disabled || id.matches?.(':disabled') || !/^\d+$/.test(variant)) continue;
        const selected = new URL(location.href).searchParams.get('variant');
        if (selected && /^\d+$/.test(selected) && selected !== variant) continue;
        if (excluded({id:decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || ''),title:document.querySelector('h1')?.textContent}, null, variant)) { claimAuto(); return; }
        const quantityInput = form.elements.namedItem('quantity');
        if ((quantityInput ? Number(quantityInput.value) : 1) !== 1 || (form.checkValidity && !form.checkValidity())) continue;
        if (method() === 'api') {
          claimAuto();
          const path = location.pathname.includes('/products/') ? location.pathname : '/products/mock-new';
          void addByAPI(variant, path, form).catch(error => console.error('[Mellojoy 1.9.0] ' + error.message));
          return;
        }
        claimAuto(); arm(form); // Arm checkout before the click can cause a fast DOM update.
        console.info('[Mellojoy] 選択中の種類を数量1でカートへ1回追加');
        try { button.click(); } catch (error) { cancel(); console.error('[Mellojoy] カート追加失敗。手動で操作してください。', error); }
        return;
      }
    }
    function autoFrameCheck() {
      autoFrame = null; autoAttempt();
      if (autoKey && !autoDone && enabled()) autoFrame = requestAnimationFrame(autoFrameCheck);
    }
    function startAuto() {
      if (!autoKey || autoDone || !enabled()) return;
      if (!autoObserver) {
        autoObserver = new MutationObserver(autoAttempt);
        autoObserver.observe(document, {subtree:true,childList:true,attributes:true,characterData:true});
      }
      autoAttempt();
      if (!autoDone && autoFrame === null) autoFrame = requestAnimationFrame(autoFrameCheck);
    }
    document.addEventListener('click', event => {
      if (!event.isTrusted) return;
      const button = event.target?.closest?.('button,input[type="submit"]');
      if (!button || !ready(button) || button.hasAttribute('formaction') || button.hasAttribute('formmethod')) return;
      if (button.closest('.shopify-payment-button,shopify-accelerated-checkout,.additional-checkout-buttons')) return;
      if (validCheckout(button)) { claimAuto(); cancel(); return; } // Manual checkout cancels automation.
      if (button.type === 'submit' || button.name === 'add' || button.id.startsWith('ProductSubmitButton')) arm(button.form);
    }, true);
    document.addEventListener('submit', event => {
      if (!event.isTrusted) return;
      const button = event.submitter;
      if (button && (button.hasAttribute('formaction') || button.hasAttribute('formmethod') || button.closest('.shopify-payment-button,shopify-accelerated-checkout,.additional-checkout-buttons'))) return;
      if (button && validCheckout(button)) { claimAuto(); cancel(); return; }
      arm(event.target);
    }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { claimAuto(); cancel(); } }, true);
    window.addEventListener('storage', event => {
      if (event.key !== PREF) return;
      if (!enabled()) { cancelAPI(); cancel(); stopAuto(); } else startAuto();
      const box = document.getElementById('mellojoy-stock-panel')?.shadowRoot?.querySelector('#auto');
      if (box) box.checked = enabled();
    });
    window.addEventListener('pagehide', () => { stop(); stopAuto(); });
    try { pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); } catch {}
    if (pending?.phase === 'armed') { claimAuto(); watch(); }
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('自動カート追加・チェックアウト：ON/OFF切り替え', () => {
      setEnabled(!enabled());
      const box = document.getElementById('mellojoy-stock-panel')?.shadowRoot?.querySelector('#auto');
      if (box) box.checked = enabled();
      console.info('[Mellojoy 1.9.0] 自動カート追加・チェックアウト：' + (enabled() ? 'ON' : 'OFF'));
    });
    if (autoKey && typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('商品ページ：自動カート追加を再待機', () => {
      cancel(); stopAuto(); sessionStorage.removeItem(autoKey); autoDone = false; setEnabled(true);
      console.info('[Mellojoy] 自動カート追加を再待機');
    });
    startAuto();
    return {enabled,setEnabled,cancel};
  }

  let showDiagnostics = false;
  let earlyFast = null;
  if (['www.mellojoyjapan.com','mellojoyjapan.com'].includes(location.hostname)) {
    const earlyProduct = location.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:collections\/[^/]+\/)?products\/([^/]+)\/?$/i);
    if (earlyProduct) earlyFast = installFastCheckout('yf-auto-add-v1:' + earlyProduct[1]);
  }
  function boot() {
    try {
  // Product handles and variant IDs are read from the current page.
  const productPath = location.pathname.match(/^(\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?)(?:collections\/[^/]+\/)?products\/([^/]+)\/?$/i);
  const collectionPath = location.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?collections\/[^/]+\/?$/i);
  const demoHost = location.protocol === 'file:' || location.hostname === 'mellojoy-stock-test.boxxxon.chatgpt.site' ||
    (['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '8765');
  const mock = demoHost && document.querySelector('meta[name="mellojoy-stock-mock"]')?.content === 'v2';
  const real = ['www.mellojoyjapan.com', 'mellojoyjapan.com'].includes(location.hostname);
  const listing = (real && !!collectionPath) || (mock && document.querySelector('meta[name="mellojoy-list-mock"]')?.content === 'v1');
  const INTERVAL = 1000;
  const cartPage = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/?$/i.test(location.pathname);
  if ((!real && !mock) || (real && !productPath && !listing && !cartPage)) return;
  const autoKey = (real && productPath) || (mock && !listing && !cartPage)
    ? 'yf-auto-add-v1:' + (productPath ? productPath[2] : location.pathname) : null;
  const fast = earlyFast || installFastCheckout(autoKey);
  if (!listing) return; // Product/cart pages have no checker panel or startup badge.
  showDiagnostics = true;
  report('購入支援スクリプト 起動中…');
  if (document.getElementById('mellojoy-stock-panel')) return;

  const KEY = 'yf-stock-v4:' + location.pathname;
  const VIEW_KEY = KEY + ':popup';
  const PICK_PREF = 'yf-auto-select-new-v1';
  let selectionOffset = 0;
  let popupPing = 0, viewTimer = null;
  let state = null, timer = null, controller = null, observer = null;
  let releaseLock = null, generation = 0, errors = 0, checks = 0;
  const title = document.title;
  const root = document.createElement('div');
  root.id = 'mellojoy-stock-panel';
  root.style.cssText = 'position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483646!important;display:block!important;width:min(350px,calc(100vw - 32px))!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;';
  document.body.append(root);
  const ui = root.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>
    :host{position:fixed;z-index:2147483646;right:16px;bottom:16px;width:min(350px,calc(100vw - 32px));font:14px/1.6 system-ui,sans-serif;color:#f8fafc}
    section{background:#132137;border:2px solid #416284;border-radius:14px;padding:16px;box-shadow:0 8px 30px #0004}
    h2{font-size:17px;margin:0 0 6px}p{margin:6px 0}.status{font-size:16px;font-weight:700;white-space:pre-wrap}
    button{font:inherit;padding:8px 12px;border:0;border-radius:8px;cursor:pointer;background:#42d8c6;color:#0c2030;font-weight:700;margin:4px 4px 4px 0}
    [hidden]{display:none}a{color:#7ee5d8}button.stop{background:#dbe5f0}button:disabled{opacity:.45;cursor:default}label{display:block;margin:8px 0}
    input{accent-color:#42d8c6}.small{font-size:12px;color:#c5d4e8}section.found{border-color:#fde047;background:#2e3013}
    section.error{border-color:#fb7185}.log{max-height:76px;overflow:auto;font-size:12px;color:#d3e2f4;white-space:pre-wrap}
  </style><section><h2>${listing ? '購入支援スクリプト' : '購入支援スクリプト'} ${mock ? '／テスト' : ''}</h2>
    <p class="status" role="status" aria-live="polite">停止中</p>
    <!-- 表示更新・別窓同期で使うため、非表示でもこの要素は残してください。 -->
    <p id="target" class="small" hidden></p>
    <label id="picklabel"><input id="pick" type="checkbox" checked> 新しく掲載された在庫あり商品を自動選択</label>
    <label id="autolabel"><input id="auto" type="checkbox" checked> 数量1を自動追加→チェックアウト</label>
    <details><summary>優先商品リスト</summary><textarea id="priority" rows="3" style="width:100%;box-sizing:border-box" placeholder="商品名の一部を1行ずつ。上ほど優先"></textarea><button id="apply-priority" type="button">優先設定を適用</button><p class="small">在庫がなければ他の商品を選択。除外条件を優先。空欄なら最速選択。</p></details><details><summary>除外商品リスト</summary><textarea id="exclude" rows="3" style="width:100%;box-sizing:border-box" placeholder="1行に1条件：商品名・コード・URL"></textarea><button id="apply-exclude" type="button">除外設定を適用</button><p class="small">部分一致・1行に1条件。空欄で除外なし。</p></details><label>追加方式 <select id="method"><option value="button">従来方式（ボタン最速検知）</option><option value="api">API方式（一覧から直接追加）</option></select></label>
    <button id="now">監視開始</button><button class="stop" id="stop">監視停止</button><button class="stop" id="popup">別窓を開く</button>
    <p class="small">1秒間隔で新規掲載を確認。従来方式は商品ページのボタンを最速検知。API方式は商品ページを開かず追加します。OFFなら一覧を1回更新して停止します。</p><p id="listnote" class="small">フィルターなしの一覧で監視してください。<br><a id="listlink">フィルターなしの一覧を開く</a></p><div class="log"></div><button hidden id="external"></button><button hidden id="inline"></button>
  </section>`;
  const $ = s => ui.querySelector(s);
  $('#auto').checked = fast.enabled(); $('#auto').onchange = () => fast.setEnabled($('#auto').checked);
  $('#priority').value = localStorage.getItem('yf-product-priorities-v1') || '';
  $('#apply-priority').onclick = () => { localStorage.setItem('yf-product-priorities-v1',$('#priority').value); log('優先設定を適用しました。'); };
  $('#exclude').value = exclusionText();
  $('#apply-exclude').onclick = () => { localStorage.setItem(EXCLUDE_KEY,$('#exclude').value); log('除外設定を適用しました。'); };
  $('#method').value = method();
  $('#method').onchange = () => localStorage.setItem(METHOD_PREF, $('#method').value);
  $('#pick').checked = localStorage.getItem(PICK_PREF) !== 'off';
  $('#pick').onchange = () => localStorage.setItem(PICK_PREF, $('#pick').checked ? 'on' : 'off');
  $('#listlink').href = cleanListURL().href;
  const log = message => {
    const lines = ($('.log').textContent + '\n' + new Date().toLocaleTimeString('ja-JP', {timeZone:'Asia/Tokyo'}) + ' ' + message).trim().split('\n');
    $('.log').textContent = lines.slice(-5).join('\n');
    $('.log').scrollTop = $('.log').scrollHeight;
  };
  function status(message, kind = '') { $('.status').textContent = message; $('section').className = kind; }
  function save() { sessionStorage.setItem(KEY, JSON.stringify(state)); }
  function cleanup() {
    generation++;
    clearTimeout(timer); observer?.disconnect(); observer = null;
    controller?.abort(); controller = null;
    releaseLock?.(); releaseLock = null;
  }
  function finish(message, kind = '') {
    cleanup();
    if (state) { state.phase = 'done'; state.message = message; state.kind = kind; save(); }
    status(message, kind); log(message); controls(false);
  }
  function controls(busy) {
    $('#now').disabled = busy; $('#auto').disabled = false; $('#pick').disabled = busy; $('#method').disabled = busy;
  }
  function targetLabel() {
    $('#target').textContent = '対象：商品一覧' + (state?.baseline ? '\n開始時の商品数：' + state.baseline.length : '');
  }
  function cleanListURL() {
    const url = new URL(location.href); url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('filter.') || key === 'page') url.searchParams.delete(key);
    return url;
  }
  function listPageURL() { const url = new URL(location.href); url.hash = ''; return url.href; }
  function productLink(href, base) {
    try {
      const url = new URL(href, base);
      const path = url.pathname.match(/^(\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?)(?:collections\/[^/]+\/)?products\/([^/]+)\/?$/i);
      if (url.origin !== location.origin || !path) return null;
      return {id:decodeURIComponent(path[2]), path:path[1] + 'products/' + path[2]};
    } catch { return null; }
  }
  function listSnapshot(doc, base) {
    const scope = doc.querySelector('#ResultsList') || doc.querySelector('#product-grid') ||
      doc.querySelector('[data-product-grid]') || doc.querySelector('.product-grid') || doc.querySelector('main');
    if (!scope) throw Object.assign(new Error('商品一覧のHTML構造を確認できません。'), {fatal:true});
    const items = new Map();
    for (const anchor of scope.querySelectorAll('a[href]')) {
      const item = productLink(anchor.getAttribute('href'), base);
      if (!item) continue;
      item.title = anchor.textContent?.trim() || anchor.querySelector('img')?.alt || item.id;
      const card = anchor.closest?.('product-card,.product-card,.card-wrapper,.product-grid__item,.grid__item,[data-product-card],.card');
      item.soldOut = !!card && [...card.querySelectorAll('[class*="badge"],[data-badge]')].some(badge => {
        if (badge.closest('[hidden],[aria-hidden="true"]')) return false;
        const inlineStyle = badge.closest('[style]')?.getAttribute('style') || '';
        if (/display\s*:\s*none/i.test(inlineStyle)) return false;
        return /^(売り切れ|売切れ|売切|在庫切れ|soldout|outofstock)$/i.test((badge.textContent || '').normalize('NFKC').replace(/\s+/g, ''));
      });
      if (items.get(item.id)?.soldOut) item.soldOut = true;
      if (!items.has(item.id)) items.set(item.id, item);
      else if (item.soldOut) items.get(item.id).soldOut = true;
    }
    return [...items.values()];
  }
  async function collectionData(signal) {
    if (mock) {
      const fixture = JSON.parse(document.documentElement.dataset.mockCollection || '{}');
      if (!Array.isArray(fixture.items)) throw Object.assign(new Error('模擬一覧データを確認できません。'), {fatal:true});
      return fixture.items.map(item => {
        const link = productLink(item.path, location.href);
        if (!link) throw Object.assign(new Error('模擬商品リンクが不正です。'), {fatal:true});
        return {...link, title:String(item.title || link.id), soldOut:item.soldOut === true, mockAvailable:item.available, mockVariants:item.variants, mockProductId:item.productId};
      });
    }
    const url = new URL(state.listURL);
    url.searchParams.set('_stock_check', String(Date.now()));
    const response = await fetch(url, {credentials:'same-origin',cache:'no-store',signal});
    if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), {http:response.status});
    if (response.url) {
      const finalURL = new URL(response.url);
      if (finalURL.origin !== location.origin || finalURL.pathname.replace(/\/$/, '') !== location.pathname.replace(/\/$/, '')) {
        throw Object.assign(new Error('商品一覧以外へ転送されました。'), {fatal:true});
      }
    }
    const html = await response.text();
    return listSnapshot(new DOMParser().parseFromString(html, 'text/html'), state.listURL);
  }
  async function purchasable(item, signal) {
    let product;
    if (mock) product = {id:item.mockProductId, title:item.title, handle:item.id, available:item.mockAvailable, variants:item.mockVariants};
    else {
      const url = new URL(item.path + '.js', location.origin);
      url.searchParams.set('_stock_check', String(Date.now()));
      const response = await fetch(url, {credentials:'same-origin',cache:'no-store',signal});
      if (response.status === 404) return null; // Product data can lag behind publication.
      if (!response.ok) throw Object.assign(new Error('在庫情報 HTTP ' + response.status), {http:response.status});
      if (response.url) {
        const finalURL = new URL(response.url);
        if (finalURL.origin !== url.origin || finalURL.pathname !== url.pathname) throw Object.assign(new Error('在庫情報の転送先が一致しません。'), {fatal:true});
      }
      try { product = await response.json(); }
      catch { throw Object.assign(new Error('在庫情報がJSONではありません。'), {fatal:true}); }
    }
    if (!product || product.handle !== item.id || !Array.isArray(product.variants) || typeof product.available !== 'boolean') {
      throw Object.assign(new Error('在庫情報の構造を確認できません。'), {fatal:true});
    }
    if (!product.available || product.requires_selling_plan === true) return null;
    if (excluded(item, product)) return null;
    const variant = product.variants.find(value => value.available === true && !excluded(item, product, String(value.id)) &&
      /^\d+$/.test(String(value.id)) && (typeof value.id !== 'number' || Number.isSafeInteger(value.id)) &&
      !(Number(value.quantity_rule?.min || 1) > 1));
    return variant ? {item, variant:String(variant.id), productTitle:product.title || item.title || item.id} : null;
  }
  async function listChanged(items, signal, run) {
    const known = new Set(state.baseline);
    const added = items.filter(item => !known.has(item.id));
    if (!added.length) return false;
    state.noticed = true;
    document.title = '【更新されました!】' + title;
    if (state.autoPick) {
      status('更新されました!', 'found');
      const candidates = added.filter(item => !item.soldOut && !excluded(item));
      if (!candidates.length) return false;
      let choice;
      const rules = priorityRules();
      if (rules.length) {
        // Confirm all candidates with at most three concurrent requests. A fast
        // lower-priority response must not beat a slower preferred product.
        const results = [], errors = [];
        let next = 0, blocked = null;
        const worker = async () => {
          while (next < candidates.length && !signal.aborted && !blocked) {
            const index = next++;
            try {
              const result = await purchasable(candidates[index], signal);
              if (result) results.push({...result, index, rank:priorityRank(result.productTitle, rules)});
            } catch (error) {
              errors.push(error);
              if ([401,403,429,430].includes(error.http)) blocked = error;
            }
          }
        };
        await Promise.all(Array.from({length:Math.min(3,candidates.length)}, worker));
        if (blocked) throw blocked;
        if (signal.aborted) return true;
        // Unknown stock must not silently cause a lower-priority purchase.
        if (errors.length) throw errors[0];
        results.sort((a,b) => a.rank-b.rank || a.index-b.index);
        choice = results[0];
        if (!choice) return false;
      } else {
      // Only new products; at most three small availability requests per check.
      const batch = Array.from({length:Math.min(3,candidates.length)}, (_, index) => candidates[(selectionOffset + index) % candidates.length]);
      selectionOffset = (selectionOffset + batch.length) % candidates.length;
      let blocked = null;
      const attempts = batch.map(async item => {
        try {
          const result = await purchasable(item, signal);
          if (!result) throw {unavailable:true};
          return result;
        } catch (error) {
          if ([401,403,429,430].includes(error.http)) blocked = error;
          throw error;
        }
      });
      try { choice = await Promise.any(attempts); }
      catch (aggregate) {
        if (blocked) throw blocked;
        const error = aggregate.errors.find(value => !value.unavailable);
        if (error) throw error;
        return false;
      }
        if (blocked) throw blocked;
      }
      if (generation !== run || state.phase !== 'watch' || signal.aborted) return true;
      const url = new URL(choice.item.path, location.origin); url.searchParams.set('variant', choice.variant);
      if (mock) url.searchParams.set('stock_test_auto', '1');
      state.selectedURL = url.href;
      finish('更新されました!', 'found'); // Persist and abort remaining requests before navigating once.
      if (method() === 'api' && fast.enabled()) {
        const apiGeneration = generation;
        controls(true); log('APIで数量1を追加中…');
        try {
          const ok = await addByAPI(choice.variant, choice.item.path);
          if (ok && generation === apiGeneration) log('API追加成功。チェックアウトへ移動します。');
        } catch (error) {
          if (generation === apiGeneration) finish(error.message + '。自動再送・方式切替はしません。カートを手動で確認してください。', 'error');
        } finally { if (generation === apiGeneration) controls(false); }
      } else location.assign(url.href);
      return true;
    }
    state.reloaded = true;
    // Save done before reloading: the next page load never repeats the update.
    finish('更新されました!', 'found');
    location.reload();
    return true;
  }
  async function check() {
    const run = generation;
    if (!state || state.phase !== 'watch') return;
    if (listPageURL() !== state.listURL) { finish('監視対象のページまたは種類が変わったため停止しました。', 'error'); return; }
    const started = Date.now();
    const request = new AbortController(); controller = request;
    const abortTimer = setTimeout(() => request.abort(), 5000);
    let delay = INTERVAL;
    try {
      const product = await collectionData(request.signal);
      if (generation !== run || state.phase !== 'watch') return;
      if (listPageURL() !== state.listURL) { finish('一覧の表示条件が変わったため停止しました。', 'error'); return; }
      checks++;
      if (await listChanged(product, request.signal, run)) return;
      if (generation !== run || state.phase !== 'watch') return;
      errors = 0;
      if (state.noticed) { status('更新されました!', 'found'); log('新規掲載商品の購入可能な種類を待機 ／ 確認 ' + checks + '回'); }
      else { status('監視中：新しい商品の掲載を待っています。'); log('掲載変更なし ／ 確認 ' + checks + '回'); }
    } catch (error) {
      if (generation !== run) return;
      if ([401,403,404,429,430].includes(error.http) || error.fatal) {
        finish('掲載確認' + 'を停止しました（' + error.message + '）。\nページを手動で確認してください。', 'error'); return;
      }
      errors++; delay = Math.min(8000, INTERVAL * 2 ** errors);
      if (errors >= 3) { finish('通信エラーが3回続いたため停止しました。', 'error'); return; }
      status('通信エラー。間隔を空けて再確認します。', 'error'); log(error.message);
    } finally {
      clearTimeout(abortTimer);
      if (controller === request) controller = null;
    }
    if (generation === run && state.phase === 'watch') {
      // Start-to-start cadence, never overlapping requests.
      timer = setTimeout(check, Math.max(0, delay - (Date.now() - started)));
    }
  }
  function resume() {
    controls(true);
    check();
  }
  function withTabLock(callback) {
    // Web Locks are released automatically on reload; prevent two watching tabs.
    if (mock && location.protocol === 'file:') { callback(); return; }
    if (!navigator.locks) { finish('このブラウザでは監視タブの重複を防げません。最新版のChrome/Edgeを使用してください。', 'error'); return; }
    const run = generation;
    navigator.locks.request('yf-mellojoy-list:' + location.pathname, {ifAvailable:true}, async lock => {
      if (generation !== run) return;
      if (!lock) { finish('別のタブで監視中です。そのタブを停止してください。', 'error'); return; }
      await new Promise(resolve => { releaseLock = resolve; callback(); });
    }).catch(() => finish('監視の開始に失敗しました。', 'error'));
  }
  function arm() {
    cleanup(); fast.setEnabled($('#auto').checked);
    const current = new URL(location.href);
    if ([...current.searchParams.keys()].some(key => key.startsWith('filter.')) || (current.searchParams.has('page') && current.searchParams.get('page') !== '1')) {
      status('新商品がフィルターで隠れる可能性があります。\n「フィルターなしの一覧を開く」から開き直して監視開始を押してください。', 'error'); controls(false); return;
    }
    try {
      const items = listSnapshot(document, location.href);
      state = {phase:'watch', listURL:listPageURL(), baseline:items.map(item => item.id), reloaded:false, autoPick:$('#pick').checked};
    } catch (error) { status(error.message, 'error'); controls(false); return; }
    targetLabel(); errors = 0; checks = 0; selectionOffset = 0; save(); log('新規掲載の監視を開始'); controls(true); withTabLock(resume);
  }

  function inlineView() {
    root.style.setProperty('display', 'block', 'important');
    sessionStorage.setItem(VIEW_KEY, 'inline');
    clearTimeout(viewTimer); viewTimer = null;
  }
  function externalView() {
    root.style.setProperty('display', 'none', 'important');
    sessionStorage.setItem(VIEW_KEY, 'popup'); popupPing = Date.now();
    if (viewTimer === null) viewTimer = setTimeout(recoverView, 1000);
  }
  function recoverView() {
    viewTimer = null;
    // Restore controls if the popup closes, crashes, or loses its parent connection.
    if (Date.now() - popupPing > 2000) inlineView();
    else viewTimer = setTimeout(recoverView, 1000);
  }
  $('#external').onclick = externalView;
  $('#inline').onclick = inlineView;
  if (sessionStorage.getItem(VIEW_KEY) === 'popup') externalView();

  function openPopup() {
    const popup = window.open('about:blank', 'yf-mellojoy-stock-controls-' + [...location.pathname].reduce((n,c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0), 'popup=yes,width=410,height=460,resizable=yes,scrollbars=yes');
    if (!popup) { log('別窓がブロックされました。ブラウザのポップアップ許可を確認してください。'); return; }
    try {
      popup.document.open();
      popup.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>購入支援スクリプト・操作パネル</title><style>
      *{box-sizing:border-box}[hidden]{display:none}body{margin:0;padding:22px;background:#132137;color:#f8fafc;font:16px/1.7 system-ui,sans-serif}h1{font-size:21px;margin:0 0 12px}.status{white-space:pre-wrap;font-weight:700;border:2px solid #416284;border-radius:10px;padding:14px;min-height:86px}.found{border-color:#fde047;background:#303116}.error{border-color:#fb7185}button{font:inherit;padding:10px 14px;border:0;border-radius:8px;background:#42d8c6;color:#10283b;font-weight:700;cursor:pointer;margin:8px 6px 0 0}button:disabled{opacity:.45;cursor:default}button.secondary{background:#dae5f3}label{display:block;margin:14px 0}input{accent-color:#42d8c6}p{font-size:14px;color:#c5d4e8}.log{font-size:12px;white-space:pre-wrap;color:#c5d4e8}
      </style></head><body><h1>${listing ? '購入支援スクリプト' : '購入支援スクリプト'}</h1><div class="status" role="status" aria-live="polite">元のページと接続中…</div><p id="target" hidden></p><label id="picklabel"><input id="pick" type="checkbox" checked> 新しく掲載された在庫あり商品を自動選択</label><label id="autolabel"><input id="auto" type="checkbox" checked> 数量1を自動追加→チェックアウト</label><details><summary>優先商品リスト</summary><textarea id="priority" rows="3" style="width:100%;box-sizing:border-box" placeholder="商品名の一部を1行ずつ。上ほど優先"></textarea><button id="apply-priority" type="button">優先設定を適用</button><p class="small">在庫がなければ他の商品を選択。除外条件を優先。空欄なら最速選択。</p></details><details><summary>除外商品リスト</summary><textarea id="exclude" rows="3" style="width:100%;box-sizing:border-box" placeholder="1行に1条件：商品名・コード・URL"></textarea><button id="apply-exclude" type="button">除外設定を適用</button><p class="small">部分一致・1行に1条件。空欄で除外なし。</p></details><label>追加方式 <select id="method"><option value="button">従来方式（ボタン最速検知）</option><option value="api">API方式（一覧から直接追加）</option></select></label><button id="start">監視開始</button><button id="stop" class="secondary">監視停止</button><button id="show" class="secondary">ページ内表示</button><p>時間制限なし・音なし。<br>元のページを閉じずに使用してください。</p><div class="log"></div></body></html>`);
      popup.document.close();
      // The popup reads the current document each time, so it reconnects after reload.
      // Event callbacks belong to the popup and never call a stale checker closure.
      const p$ = selector => popup.document.querySelector(selector);
      const source = () => {
        try {
          if (!popup.opener || popup.opener.closed) return null;
          return popup.opener.document.getElementById('mellojoy-stock-panel')?.shadowRoot || null;
        } catch { return null; }
      };
      const sync = () => {
        const current = source();
        if (!current) {
          try {
            const opener = popup.opener;
            if (opener?.document.readyState !== 'loading' && /\/(?:products\/[^/]+|cart|checkout)\/?$/.test(opener?.location.pathname || '')) { popup.close(); return; }
          } catch {}
          p$('.status').textContent = '元のページと接続できません。\n読み込み完了を待つか、対象ページを確認してください。';
          p$('.status').className = 'status error'; p$('#start').disabled = true; p$('#stop').disabled = true; return;
        }
        current.querySelector('#external').click();
        p$('#target').textContent = current.querySelector('#target').textContent;
        p$('.status').textContent = current.querySelector('.status').textContent;
        p$('.status').className = 'status ' + current.querySelector('section').className;
        p$('.log').textContent = current.querySelector('.log').textContent;
        p$('#autolabel').hidden = current.querySelector('#autolabel').hidden;
        p$('#auto').checked = current.querySelector('#auto').checked;
        p$('#auto').disabled = current.querySelector('#auto').disabled;
        p$('#method').value = current.querySelector('#method').value;
        p$('#method').disabled = current.querySelector('#method').disabled;
        p$('#pick').checked = current.querySelector('#pick').checked;
        p$('#pick').disabled = current.querySelector('#pick').disabled;
        p$('#start').disabled = current.querySelector('#now').disabled;
        p$('#stop').disabled = false;
      };
      p$('#start').onclick = () => {
        const current = source(); if (!current) return;
        if (!current.querySelector('#pick').disabled) {
          current.querySelector('#pick').checked = p$('#pick').checked;
          current.querySelector('#pick').onchange?.();
        }
        current.querySelector('#auto').checked = p$('#auto').checked;
        current.querySelector('#auto').onchange?.();
        current.querySelector('#now').click(); sync();
      };
      p$('#stop').onclick = () => { source()?.querySelector('#stop').click(); sync(); };
      p$('#auto').onchange = () => {
        const current = source(); if (current && !current.querySelector('#auto').disabled) { current.querySelector('#auto').checked = p$('#auto').checked; current.querySelector('#auto').onchange?.(); }
      };
      p$('#priority').value = source()?.querySelector('#priority').value || '';
      p$('#apply-priority').onclick = () => { const current=source(); if(current){current.querySelector('#priority').value=p$('#priority').value;current.querySelector('#apply-priority').click();sync();} };
      p$('#exclude').value = source()?.querySelector('#exclude').value || '';
      p$('#apply-exclude').onclick = () => { const current=source(); if(current){current.querySelector('#exclude').value=p$('#exclude').value;current.querySelector('#apply-exclude').click();sync();} };
      p$('#method').onchange = () => {
        const current = source(); if (current && !current.querySelector('#method').disabled) { current.querySelector('#method').value = p$('#method').value; current.querySelector('#method').onchange?.(); }
      };
      p$('#pick').onchange = () => {
        const current = source(); if (current && !current.querySelector('#pick').disabled) { current.querySelector('#pick').checked = p$('#pick').checked; current.querySelector('#pick').onchange?.(); }
      };
      const restore = () => { source()?.querySelector('#inline').click(); };
      p$('#show').onclick = () => { restore(); try { popup.opener?.focus(); } catch {} popup.close(); };
      const interval = popup.setInterval(sync, 300);
      popup.addEventListener('pagehide', () => { popup.clearInterval(interval); restore(); }, {once:true});
      sync(); popup.focus();
    } catch {
      inlineView();
      log('別窓を初期化できませんでした。ページ内パネルで操作してください。');
    }
  }

  $('#now').onclick = arm;
  $('#popup').onclick = openPopup;
  $('#stop').onclick = () => { const wasAdding = !!apiTask; cancelAPI(); finish(wasAdding ? '停止しました。送信済みの追加は取り消せません。カートを確認してください。' : '停止しました。'); };
  window.addEventListener('pagehide', () => { cleanup(); clearTimeout(viewTimer); });
  try { state = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { state = null; }
  targetLabel();
  if (state?.phase === 'done') {
    status(state.message || '停止中', state.kind || '');
    if (state.kind === 'found') document.title = '【更新されました!】' + title;
  } else if (state) {
    finish('ページを開き直しました。監視開始を押してください。');
  }


      report('購入支援スクリプト 起動済み');
    } catch (error) {
      if (showDiagnostics) report('購入支援スクリプト起動エラー：\n' + (error?.message || String(error)), true);
      console.error('[Mellojoy]', error);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();
