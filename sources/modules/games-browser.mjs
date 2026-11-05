// Sandboxed browser assistance for AnkerGames and VikingFile. Verification is
// completed by the person in the window. Downloads are captured and cancelled.
import { publicUrl, supportedDownloadUrl } from './games-core.mjs';
const fail = (message, code = 'NEEDS_CHECK') => Object.assign(new Error(`Games: ${message}`), { code });
const HOSTS = ['ankergames.net', 'astralgames.net', 'vikingfile.com', 'vik1ngfile.site', 'fitgirl-repacks.site', 'fuckingfast.co', 'dl.fuckingfast.co', 'dlproxy.uk'];
export function createGamesBrowserBridge({ BrowserWindow, wait = ms => new Promise(r => setTimeout(r, ms)), attempts = 180 }) {
  let queue = Promise.resolve();
  const allowed = value => { const u = publicUrl(value); if (!u) return false; const h = new URL(u).hostname; return HOSTS.some(d => h === d || h.endsWith('.' + d)); };
  async function run({ provider, action, url, q = '' }) {
    if (!['ankergames', 'astralgames', 'gamebounty', 'gogrevived', 'fitgirl', 'm4ckd0ge'].includes(provider) || !['read', 'search', 'resolve', 'mirror'].includes(action) || !allowed(url)) throw fail('Invalid browser request', 'BAD_REQUEST');
    const start = new URL(url);
    const validPath = action === 'mirror' ? ['vikingfile.com', 'vik1ngfile.site'].includes(start.hostname) && /^\/f\/[\w-]+$/.test(start.pathname) || start.hostname === 'fuckingfast.co' && /^\/[A-Za-z0-9]{8,32}$/.test(start.pathname)
      : provider === 'astralgames' ? action === 'read' && start.hostname === 'astralgames.net' && start.pathname === '/search'
        : provider === 'fitgirl' ? action === 'read' && start.hostname === 'fitgirl-repacks.site' && /^\/(?:[\w-]+\/|page\/\d+\/)?$/.test(start.pathname)
          : provider === 'ankergames' && start.hostname === 'ankergames.net' && /^\/(?:game\/[\w-]+\/?|games-list\/?|games\/online-fix\/?)$/.test(start.pathname);
    if (!validPath) throw fail('Invalid browser path', 'BAD_REQUEST');
    const win = new BrowserWindow({ show: false, width: 1000, height: 760, title: 'Game source verification', webPreferences: { partition: 'persist:game-sources', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const wc = win.webContents, ses = wc.session;
    let captured, resolving = false;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, target) => {
      // Capture a server redirect from the signed Anker download endpoint to a file host,
      // without navigating to an external page or starting a file transfer in this helper window.
      if (resolving && supportedDownloadUrl(target) && new URL(target).hostname !== 'ankergames.net') {
        captured = target;
        event.preventDefault();
        return;
      }
      if (allowed(target)) return;
      event.preventDefault();
    };
    wc.on('will-navigate', guard); wc.on('will-redirect', guard);
    const capture = (event, item, owner) => {
      if (owner !== wc) return;
      const chain = item.getURLChain(); captured = [...chain].reverse().find(supportedDownloadUrl) || supportedDownloadUrl(item.getURL());
      event.preventDefault();
    };
    ses.on('will-download', capture);
    async function inspect() { return wc.executeJavaScript(`({ title: document.title, text: document.body?.innerText || '', html: document.documentElement?.outerHTML || '', link: document.querySelector('#download-link[href], a[href*="/download-file/"]')?.href })`); }
    async function pageReady() {
      for (let i = 0; i < attempts; i++) {
        if (win.isDestroyed()) throw fail('Verification window closed');
        const p = await inspect().catch(() => null);
        if (p && !/just a moment|security verification|verify you are human/i.test(p.title + p.text) && p.html) return p;
        if (i === 3) { win.show(); win.focus(); }
        await wait(500);
      }
      throw fail('Complete the source verification in the desktop window, then retry');
    }
    async function load(target) {
      return win.loadURL(target).catch(async e => {
        if (e.code === 'ERR_ABORTED') return;
        if (e.code === 'ERR_FAILED') {
          await wait(200);
          return win.loadURL(target).catch(e2 => { if (e2.code !== 'ERR_ABORTED') throw e2; });
        }
        throw e;
      });
    }
    try {
      await load(url);
      let p = await pageReady();
      if (action === 'read') {
        if (provider === 'astralgames') for (let i = 0; i < 60; i++) {
          if (/href="\/game\//.test(p.html) || /No games found|0 games found/i.test(p.text)) break;
          await wait(250); p = await inspect();
        }
        return { body: p.html, url: wc.getURL(), status: 200 };
      }
      if (action === 'search') {
        // Use the site's existing Livewire search component; no private API.
        const searched = await wc.executeJavaScript(`(async()=>{try{const input=document.querySelector('input[placeholder^="Search games by title"]');let el=input;while(el&&!el.hasAttribute('wire:id'))el=el.parentElement;if(!el||!window.Livewire)return {error:'Search unavailable'};await window.Livewire.find(el.getAttribute('wire:id')).$set('search',${JSON.stringify(String(q).slice(0, 200))});return {ok:true};}catch(e){return {error:String(e)};}})()`);
        if (!searched?.ok) throw fail(searched?.error || 'Search unavailable');
        p = await inspect(); return { body: p.html, url: wc.getURL(), status: 200 };
      }
      if (action === 'resolve') {
        const id = p.html.match(/generateDownloadUrl\((\d+)\)/)?.[1];
        if (!id) throw fail('No direct download advertised', 'NO_DOWNLOAD');
        const result = await wc.executeJavaScript(`(async()=>{const r=await fetch('/generate-download-url/${id}',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-TOKEN':document.querySelector('meta[name="csrf-token"]')?.content||''},body:'{}'});return r.json();})()`);
        if (!result.success || !result.download_url || !allowed(result.download_url) || !new URL(result.download_url).pathname.startsWith('/download/')) throw fail(result.error || 'Download quota or verification prevents this download', 'NO_DOWNLOAD');
        resolving = true;
        await load(result.download_url);
      }
      let downloadClicks = 0;
      for (let i = 0; i < attempts; i++) {
        if (captured) return { url: captured, browserReady: true };
        if (win.isDestroyed()) throw fail('Verification window closed');
        p = await inspect().catch(() => null);
        if (action === 'mirror' && start.hostname === 'fuckingfast.co' && downloadClicks < 2 && i % 2 === 0) {
          const clicked = await wc.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('a')].find(e=>e.textContent.trim()==='DOWNLOAD');if(!button)return false;button.click();return true;})()`).catch(() => false);
          if (clicked) downloadClicks++;
        }
        if (action === 'mirror' && p?.link && allowed(p.link) && new URL(p.link).pathname.startsWith('/d/')) return { url: p.link };
        if (action === 'resolve' && !captured && downloadClicks < 3 && (i % 2 === 0 || downloadClicks === 0)) {
          const clicked = await wc.executeJavaScript(`(() => {
            try {
              const el = document.querySelector('[x-data*="downloadPage"]');
              if (el && window.Alpine) {
                const data = Alpine.$data(el);
                const token = window.agTurnstile?.token?.() || data?.token;
                if (token || data?.hasToken || (!data?.isTurnstileActive && data?.countdown === 0)) {
                  data.handleDownloadClick();
                  return true;
                }
              }
              const link = document.querySelector('#download-link[href], a[href*="/download-file/"]');
              if (link && window.agTurnstile?.token?.()) { link.click(); return true; }
              return false;
            } catch (e) { return false; }
          })()`).catch(() => false);
          if (clicked) downloadClicks++;
        }
        if (i === 6 && !captured) {
          const needsHuman = await wc.executeJavaScript(`(() => {
            try {
              const el = document.querySelector('[x-data*="downloadPage"]');
              const data = el && window.Alpine ? Alpine.$data(el) : null;
              if (data?.awaitingChallenge || data?.needsChallenge) return true;
              const t = (document.title || '') + ' ' + (document.body?.innerText || '');
              return /verify|captcha|turnstile|security verification|just a moment/i.test(t);
            } catch { return false; }
          })()`).catch(() => false);
          if (needsHuman) { win.show(); win.focus(); }
        }
        await wait(500);
      }
      throw fail('Complete the download check in the desktop window, then retry');
    } finally { ses.removeListener('will-download', capture); if (!win.isDestroyed()) win.destroy(); }
  }
  return request => { const job = queue.catch(() => { }).then(() => wait(100)).then(() => run(request)); queue = job; return job; };
}
