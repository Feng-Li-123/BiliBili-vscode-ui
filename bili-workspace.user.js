// ==UserScript==
// @name         Bili Workspace · 工作界面
// @namespace    local.bili-workspace
// @version      0.7.0
// @description  B站工作界面；动态、直播、收藏夹、稍后再看、主站与视频采用 VS Code 风格，保留原生内容和操作，默认关闭。
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/*
// @match        https://link.bilibili.com/p/center/*
// @match        https://live.bilibili.com/*
// @match        https://space.bilibili.com/*/favlist*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_getTab
// @grant        GM_saveTab
// @homepageURL  https://github.com/Feng-Li-123/B-vscode-
// @supportURL   https://github.com/Feng-Li-123/B-vscode-/issues
// @updateURL    https://raw.githubusercontent.com/Feng-Li-123/B-vscode-/main/bili-workspace.user.js
// @downloadURL  https://raw.githubusercontent.com/Feng-Li-123/B-vscode-/main/bili-workspace.user.js
// @license      MIT
// ==/UserScript==

/* Written independently; reference projects are documented in README.md.
 * Native feed, player and comment nodes are never moved, cloned or replaced.
 * No requests, account actions, page API hooks or extension-setting changes.
 */
(function biliWorkspace() {
  'use strict';

  const KEY_ENABLED = 'bili-workspace.enabled';
  const KEY_WIDTH = 'bili-workspace.player-width';
  const KEY_LAYOUT = 'bili-workspace.layout';
  const KEY_TAB_SESSIONS = 'bili-workspace.tab-sessions';
  const KEY_CODE = 'bili-workspace.code-draft';
  const CODE_LIMIT = 256 * 1024;
  const KEY_FAVORITES = 'bili-workspace.favorites-url';
  const KEY_ROUTES = 'bili-workspace.routes';
  const KEY_TRANSFERS = 'bili-workspace.transfers';
  const STATE_KEY = '__bwcWorkspace';
  const WORKSPACE_VERSION = 2;
  const TRANSFER_PARAM = '__bwc_nav';
  const PREFIX = 'bwc';
  const CLASS = 'bwc-active';
  const kind = pageKind();
  if (!kind) return;
  const playback = kind === 'video' || kind === 'live';

  const enabled = GM_getValue(KEY_ENABLED, false) === true;
  GM_registerMenuCommand(
    enabled ? '关闭工作界面（刷新当前页）' : '开启工作界面（刷新当前页）',
    () => {
      GM_setValue(KEY_ENABLED, !enabled);
      location.reload();
    },
  );
  // This branch intentionally precedes every document read, observer and timer.
  if (!enabled) return;

  let width = GM_getValue(KEY_WIDTH, 640) === 440 ? 440 : 640;
  let layout = GM_getValue(KEY_LAYOUT, 'split') === 'stacked' ? 'stacked' : 'split';
  let view = 'preview';
  let previewScroll = 0;
  let currentPage = workspacePage(location.href);
  let workspaceFiles = [];
  let favoritesUrl = readFavoritesUrl();
  let renderedFiles = '';
  let stopped = false;
  let mounted = false;
  let frame = 0;
  let measuredWidth = 0;
  let targetPlayer = null;
  let screenObserver = null;
  let pageObserver = null;
  let titleObserver = null;
  let resizeObserver = null;
  let bodyObserver = null;
  let observerTimer = 0;
  let route = null;
  let pendingNavigation = false;
  let writingHistory = false;
  let feedRestore = null;
  let restoreTimer = 0;
  let resumeTimer = 0;
  let resumeMessage = '';
  let resumeOnArrival = false;
  let restoreTried = false;
  let editor = null;
  const tabStorageAvailable = typeof GM_getTab === 'function' && typeof GM_saveTab === 'function';
  let tabState = {};
  let tabStateReady = !tabStorageAvailable;
  let tabReadTimer = 0;
  let queuedNavigation = null;
  const tabNodes = new Map();
  let sourceTab = null;
  const roots = new Map();
  const originalIcons = new Map();
  const originalTitle = document.title;
  const disposers = [];
  const concealedNodes = new Map();
  const title = 'workspace — Visual Studio Code';

  const style = document.createElement('style');
  style.id = `${PREFIX}-style`;
  style.textContent = css();
  (document.head || document.documentElement).append(style);
  document.documentElement.classList.add(CLASS, `bwc-${kind}`);
  document.documentElement.classList.add(`bwc-layout-${layout}`);
  document.documentElement.style.setProperty('--bwc-player-width', `${width}px`);

  GM_registerMenuCommand('播放区域：640 px', () => setWidth(640));
  GM_registerMenuCommand('播放区域：440 px', () => setWidth(440));
  if (playback) {
    GM_registerMenuCommand('布局：左右（窄窗自动上下）', () => setLayout('split'));
    GM_registerMenuCommand('布局：上下（回退）', () => setLayout('stacked'));
  }

  initWorkspaceRoute();
  if (tabStorageAvailable) refreshTabState(() => {
    rememberRoute();
    if (mounted && !stopped && !pendingNavigation) syncWorkspaceFiles();
    flushQueuedNavigation();
  });
  else resumeMessage = 'Update loader for tab synchronization';
  if (document.body) mount();
  else {
    bodyObserver = new MutationObserver(() => {
      if (!document.body) return;
      bodyObserver.disconnect();
      bodyObserver = null;
      mount();
    });
    bodyObserver.observe(document.documentElement, { childList: true });
  }
  // Mount as soon as body exists; the native app can finish loading afterward.
  // No dependency-loading veil or native-content replacement is used.

  function pageKind() {
    if (location.hostname === 't.bilibili.com' && location.pathname === '/') {
      return 'dynamic';
    }
    if (location.hostname === 'www.bilibili.com'
      && /^\/video\/(?:BV[0-9a-z]+|av\d+)\/?$/i.test(location.pathname)) {
      return 'video';
    }
    if (location.hostname === 'www.bilibili.com' && location.pathname === '/') {
      return 'home';
    }
    if (location.hostname === 'www.bilibili.com'
      && /^\/watchlater(?:\/list)?\/?$/.test(location.pathname)) {
      return 'watchlater';
    }
    if (location.hostname === 'space.bilibili.com'
      && /^\/\d+\/favlist\/?$/.test(location.pathname)) {
      return 'favorites';
    }
    if (location.hostname === 'live.bilibili.com' && /^\/\d+\/?$/.test(location.pathname)) {
      return 'live';
    }
    if (location.hostname === 'link.bilibili.com'
      && /^\/p\/center\/index\/?$/.test(location.pathname)
      && /^#\/user-center\/follow(?:\/\d+)?\/?$/.test(location.hash || '')) {
      return 'following';
    }
    return null;
  }

  function workspacePage(href) {
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
      if (url.hostname === 't.bilibili.com' && url.pathname === '/') {
        return { id: 'dynamic', kind: 'dynamic', url: 'https://t.bilibili.com/?tab=all', label: '≡ activity.log' };
      }
      if (url.hostname === 'www.bilibili.com' && url.pathname === '/') {
        return { id: 'home', kind: 'home', url: 'https://www.bilibili.com/', label: '⌂ home.log' };
      }
      if (url.hostname === 'www.bilibili.com'
        && /^\/watchlater(?:\/list)?\/?$/.test(url.pathname)) {
        return {
          id: 'watchlater', kind: 'watchlater',
          url: 'https://www.bilibili.com/watchlater/list', label: '◷ watchlater.log',
        };
      }
      if (url.hostname === 'space.bilibili.com'
        && /^\/\d+\/favlist\/?$/.test(url.pathname)) {
        const owner = url.pathname.split('/')[1];
        const clean = new URL(`https://space.bilibili.com/${owner}/favlist`);
        const folder = url.searchParams.get('fid');
        const type = url.searchParams.get('ftype');
        if (folder && /^\d+$/.test(folder)) clean.searchParams.set('fid', folder);
        if (['create', 'collect'].includes(type)) clean.searchParams.set('ftype', type);
        return {
          id: `favorites/${owner}`, kind: 'favorites', url: clean.href,
          label: '☆ favorites.log',
        };
      }
      // Old/native queue links can open the list player. Use the existing
      // ordinary-video view for a single item, preserving its part/progress.
      if (url.hostname === 'www.bilibili.com'
        && /^\/list\/(?:watchlater|ml\d+)\/?$/.test(url.pathname)
        && /^BV[0-9a-z]+$/i.test(url.searchParams.get('bvid') || '')) {
        const video = new URL(`https://www.bilibili.com/video/${url.searchParams.get('bvid')}/`);
        for (const key of ['p', 't', 'start_progress']) {
          const value = url.searchParams.get(key);
          if (value && /^\d+(?:\.\d+)?$/.test(value)) video.searchParams.set(key, value);
        }
        return workspacePage(video.href);
      }
      if (url.hostname === 'live.bilibili.com' && /^\/\d+\/?$/.test(url.pathname)) {
        const room = url.pathname.replace(/\//g, '');
        return {
          id: `live/${room}`, kind: 'live', url: `https://live.bilibili.com/${room}`,
          label: `◉ stream-${room}.log`,
        };
      }
      if (url.hostname === 'link.bilibili.com'
        && /^\/p\/center\/index\/?$/.test(url.pathname)
        && /^#\/user-center\/follow(?:\/\d+)?\/?$/.test(url.hash)) {
        return { id: 'following', kind: 'following', url: url.href, label: '◉ live.log' };
      }
      if (url.hostname !== 'www.bilibili.com'
        || !/^\/video\/(?:BV[0-9a-z]+|av\d+)\/?$/i.test(url.pathname)) return null;
      const path = url.pathname.replace(/\/?$/, '/');
      const clean = new URL(`https://www.bilibili.com${path}`);
      for (const key of ['p', 't', 'start_progress']) {
        const value = url.searchParams.get(key);
        if (value && /^\d+(?:\.\d+)?$/.test(value)) clean.searchParams.set(key, value);
      }
      const part = clean.searchParams.get('p');
      return {
        id: `${path}${part ? `?p=${part}` : ''}`, kind: 'video',
        url: clean.href, label: `▷ ${path.split('/')[2]}`,
      };
    } catch (_) {
      return null;
    }
  }

  function readFavoritesUrl() {
    const value = GM_getValue(KEY_FAVORITES, '');
    const page = typeof value === 'string' ? workspacePage(value) : null;
    return page?.kind === 'favorites' ? page.url : '';
  }

  function syncLibraryNavigation() {
    // Obtain the user's own library from native header links, never cookies,
    // account APIs, or a hard-coded user id. Other people's space links do not
    // replace this entry.
    const native = [...document.querySelectorAll(
      '#biliMainHeader a[href], .bili-header a[href], .custom-navbar a[href], .international-header a[href]',
    )].map(anchor => workspacePage(anchor.href)).find(page => page?.kind === 'favorites');
    if (native && native.url !== favoritesUrl) {
      favoritesUrl = native.url;
      GM_setValue(KEY_FAVORITES, favoritesUrl);
    }
    for (const entry of document.querySelectorAll('#bwc-shell [data-bwc-kind="favorites"]')) {
      const href = favoritesUrl || '#';
      if (entry.getAttribute('href') !== href) entry.setAttribute('href', href);
      entry.setAttribute('aria-disabled', String(!favoritesUrl));
      entry.title = favoritesUrl ? '收藏夹' : '等待 B 站加载收藏夹入口';
    }
  }

  function libraryEntries() {
    return [
      ['dynamic', '▤', '≡  activity.log', '动态', 'https://t.bilibili.com/?tab=all'],
      ['following', '◉', '◉  live.log', '正在直播 · 我的关注',
        'https://link.bilibili.com/p/center/index#/user-center/follow/1'],
      ['favorites', '☆', '☆  favorites.log', '收藏夹', favoritesUrl || '#'],
      ['watchlater', '◷', '◷  watchlater.log', '稍后再看', 'https://www.bilibili.com/watchlater/list'],
      ['home', '⌂', '⌂  home.log', '主站', 'https://www.bilibili.com/'],
    ];
  }

  function tabSessions() {
    const saved = GM_getValue(KEY_TAB_SESSIONS, []);
    return Array.isArray(saved) ? saved.filter(session => session
      && /^[a-z0-9-]{12,80}$/i.test(session.workspace)
      && Array.isArray(session.files) && Date.now() - session.time < 86400000).slice(-32) : [];
  }

  function refreshTabState(done) {
    if (!tabStorageAvailable) { done(true); return; }
    tabStateReady = false;
    let settled = false;
    const finish = (success, value) => {
      if (settled || stopped) return;
      settled = true;
      clearTimeout(tabReadTimer);
      if (success) tabState = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      tabStateReady = true;
      done(success);
    };
    tabReadTimer = window.setTimeout(() => finish(false), 1800);
    try { GM_getTab(value => finish(true, value)); }
    catch (_) { finish(false); }
  }

  function persistTabState(done) {
    if (!tabStorageAvailable || !tabStateReady) { done?.(); return; }
    const record = tabState[STATE_KEY];
    if (!record || record.workspace !== route?.workspace) {
      tabState[STATE_KEY] = { workspace: route?.workspace, files: workspaceFiles };
    }
    try { GM_saveTab(tabState, done); }
    catch (_) { done?.(); }
  }

  function updateTabRecord(fields) {
    if (!tabStorageAvailable || !tabStateReady || !route) return;
    const previous = tabState[STATE_KEY];
    tabState[STATE_KEY] = {
      ...(previous?.workspace === route.workspace ? previous : {}),
      workspace: route.workspace, ...fields,
    };
    persistTabState();
  }

  function readWorkspaceFiles() {
    if (!route) return workspaceFiles;
    const record = tabStorageAvailable && tabStateReady ? tabState[STATE_KEY] : null;
    const saved = record?.workspace === route.workspace && Array.isArray(record.files)
      ? record.files : tabSessions().find(session => session.workspace === route.workspace)?.files || [];
    if (!Array.isArray(saved)) return [];
    const unique = new Map();
    for (const item of saved.slice(-24)) {
      if (!item || typeof item.url !== 'string') continue;
      const page = workspacePage(item.url);
      if (!page) continue;
      if (['video', 'live'].includes(page.kind) && typeof item.label === 'string') {
        page.label = item.label.trim().slice(0, 110) || page.label;
      }
      unique.set(page.id, page);
    }
    return [...unique.values()].slice(-12);
  }

  function writeWorkspaceFiles() {
    if (!route) return;
    const sessions = tabSessions().filter(session => session.workspace !== route.workspace);
    GM_setValue(KEY_TAB_SESSIONS, [...sessions, {
      workspace: route.workspace, files: workspaceFiles, time: Date.now(),
    }].slice(-32));
    updateTabRecord({ files: workspaceFiles });
  }

  function rememberPage(page, label) {
    if (!page) return;
    // Cached documents and independent Chrome tabs must not overwrite each
    // other's open files. The navigation chain already supplies a workspace id.
    workspaceFiles = readWorkspaceFiles();
    const previous = JSON.stringify(workspaceFiles);
    const index = workspaceFiles.findIndex(item => item.id === page.id);
    if (['video', 'live'].includes(page.kind)) {
      page = { ...page, label: label?.trim().slice(0, 110)
        || (index >= 0 ? workspaceFiles[index].label : page.label) };
    }
    if (index >= 0) workspaceFiles[index] = page;
    else workspaceFiles.push(page);
    while (workspaceFiles.length > 12) {
      const remove = workspaceFiles.findIndex(item => item.id !== currentPage?.id);
      workspaceFiles.splice(remove < 0 ? 0 : remove, 1);
    }
    if (JSON.stringify(workspaceFiles) !== previous) writeWorkspaceFiles();
  }

  function syncWorkspaceFiles() {
    // An outgoing document can still receive mutations before navigation
    // commits. It must not re-open the active tab the user just closed.
    if (pendingNavigation || !tabStateReady) return;
    workspaceFiles = readWorkspaceFiles();
    currentPage = workspacePage(location.href);
    const heading = kind === 'video' ? document.querySelector('h1.video-title, h1')
      : kind === 'live' ? document.querySelector(
        '#head-info-vm .room-title, #head-info-vm .room-owner-username') : null;
    const label = heading?.textContent?.replace(/^\s*\/\/\s*/, '').trim();
    rememberPage(currentPage, label ? `${kind === 'live' ? '◉' : '▷'} ${label}` : undefined);
    renderWorkspaceFiles();
  }

  function renderWorkspaceFiles() {
    const tabs = document.getElementById('bwc-file-tabs');
    if (!tabs) return;
    const signature = JSON.stringify([workspaceFiles, currentPage?.id, view]);
    if (signature === renderedFiles) return;
    renderedFiles = signature;
    const wanted = new Set(workspaceFiles.map(page => page.id));
    for (const [id, nodes] of tabNodes) {
      if (!wanted.has(id)) {
        nodes.group.remove();
        tabNodes.delete(id);
      }
    }
    for (const page of workspaceFiles) {
      let nodes = tabNodes.get(page.id);
      if (!nodes) {
        const group = element('span', 'bwc-workspace-file');
        const tab = link(page.label, page.url, 'bwc-tab');
        tab.dataset.bwcPage = page.id;
        tab.setAttribute('role', 'tab');
        tab.addEventListener('click', event => {
          if (!plainClick(event)) return;
          event.preventDefault();
          const latest = workspaceFiles.find(item => item.id === page.id);
          if (latest?.id === currentPage?.id) setView('preview');
          else if (latest) navigateWorkspace(latest);
        });
        const close = element('button', 'bwc-tab-close', '×');
        close.type = 'button';
        close.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          closeWorkspaceFile(page.id);
        });
        group.append(tab, close);
        nodes = { group, tab, close };
        tabNodes.set(page.id, nodes);
      }
      const { group, tab, close } = nodes;
      if (tab.textContent !== page.label) tab.textContent = page.label;
      if (tab.href !== page.url) tab.href = page.url;
      tab.title = page.label;
      tab.setAttribute('aria-selected', String(view === 'preview' && page.id === currentPage?.id));
      tab.classList.toggle('bwc-tab-active', view === 'preview' && page.id === currentPage?.id);
      close.title = `关闭标签 ${page.label}`;
      close.setAttribute('aria-label', close.title);
      close.disabled = workspaceFiles.length === 1;
      // Keep existing elements in place: a late title must not replace a
      // close button between pointerdown and click.
      const index = workspaceFiles.indexOf(page);
      if (tabs.children[index] !== group) tabs.insertBefore(group, tabs.children[index] || null);
    }
    if (!sourceTab) {
      sourceTab = element('button', 'bwc-tab', 'JS source.js');
      sourceTab.type = 'button';
      sourceTab.dataset.bwcView = 'code';
      sourceTab.setAttribute('role', 'tab');
      sourceTab.addEventListener('click', () => setView('code'));
      tabs.append(sourceTab);
    }
    sourceTab.setAttribute('aria-selected', String(view === 'code'));
    sourceTab.classList.toggle('bwc-tab-active', view === 'code');
    tabs.querySelector('.bwc-tab-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function closeWorkspaceFile(id) {
    if (pendingNavigation || stopped) return;
    workspaceFiles = readWorkspaceFiles();
    if (workspaceFiles.length <= 1 || !workspaceFiles.some(page => page.id === id)) return;
    const index = workspaceFiles.findIndex(page => page.id === id);
    workspaceFiles = workspaceFiles.filter(page => page.id !== id);
    writeWorkspaceFiles();
    renderWorkspaceFiles();
    if (id === currentPage?.id) {
      navigateWorkspace(workspaceFiles[Math.min(index, workspaceFiles.length - 1)]);
    }
  }

  function validRoute(value) {
    return value && /^[a-z0-9-]{12,80}$/i.test(value.workspace)
      && Number.isInteger(value.step) && value.step >= 0 && value.step < 1000000
      ? { workspace: value.workspace, step: value.step } : null;
  }

  function routeBooks() {
    const saved = GM_getValue(KEY_ROUTES, []);
    return Array.isArray(saved) ? saved.filter(book => book
      && validRoute({ workspace: book.workspace, step: 0 })
      && Array.isArray(book.entries) && Date.now() - book.time < 86400000).slice(-8) : [];
  }

  function currentBook() {
    const record = tabStorageAvailable && tabStateReady ? tabState[STATE_KEY] : null;
    if (record?.workspace === route?.workspace && Array.isArray(record.book?.entries)) return record.book;
    return route && routeBooks().find(book => book.workspace === route.workspace);
  }

  function storeBook(book) {
    const books = routeBooks().filter(item => item.workspace !== book.workspace);
    book.time = Date.now();
    book.entries = book.entries.slice(-128);
    GM_setValue(KEY_ROUTES, [...books, book].slice(-8));
    if (book.workspace === route?.workspace) updateTabRecord({ book });
  }

  function stampRoute() {
    // Merge our field; preserve Vue/router state and avoid replacing primitives.
    const previous = history.state;
    if (previous !== null && (typeof previous !== 'object' || Array.isArray(previous))) return false;
    writingHistory = true;
    try {
      history.replaceState({ ...previous, [STATE_KEY]: {
        ...route, version: WORKSPACE_VERSION, tabStorage: tabStorageAvailable,
      } }, '');
      return true;
    } finally {
      writingHistory = false;
    }
  }

  function rememberRoute() {
    if (!route || !currentPage) return;
    const book = currentBook() || { workspace: route.workspace, entries: [] };
    const existing = book.entries.find(entry => entry.step === route.step);
    const point = { ...existing, step: route.step, page: currentPage.id, url: currentPage.url };
    book.entries = [...book.entries.filter(entry => entry.step !== route.step), point]
      .sort((a, b) => a.step - b.step);
    storeBook(book);
  }

  function initWorkspaceRoute() {
    try {
      const url = new URL(location.href);
      const token = url.searchParams.get(TRANSFER_PARAM);
      const saved = GM_getValue(KEY_TRANSFERS, []);
      const transfers = Array.isArray(saved) ? saved.filter(item =>
        item && Date.now() - item.time < 120000 && validRoute(item.route)).slice(-32) : [];
      const transfer = transfers.find(item => item.token === token && item.page === currentPage?.id);
      const marked = validRoute(history.state?.[STATE_KEY]);
      const compatible = history.state?.[STATE_KEY]?.version === WORKSPACE_VERSION
        && (history.state?.[STATE_KEY]?.tabStorage === true) === tabStorageAvailable;
      const oldFeed = !compatible && marked
        ? routeBooks().find(book => book.workspace === marked.workspace)?.feed : null;
      // Fork an upgraded document from pre-0.7 history. Otherwise a top-tab
      // click can restore a BFCache document still running the old tab logic.
      route = (compatible ? marked : null)
        || (transfer?.route.version === WORKSPACE_VERSION
          && (transfer.route.tabStorage === true) === tabStorageAvailable ? validRoute(transfer.route) : null);
      resumeOnArrival = transfer?.resume === true;
      if (!route) route = { workspace: crypto.randomUUID(), step: 0 };
      if (token) {
        url.searchParams.delete(TRANSFER_PARAM);
        // Tokens transport only our history marker between Bilibili origins.
        // They are consumed once and removed from the displayed URL immediately.
        writingHistory = true;
        try { history.replaceState(history.state, '', url.href); }
        finally { writingHistory = false; }
        GM_setValue(KEY_TRANSFERS, transfers.filter(item => item.token !== token));
      }
      stampRoute();
      rememberRoute();
      if (validCheckpoint(oldFeed)) {
        const book = currentBook();
        if (book) {
          book.feed = oldFeed;
          storeBook(book);
        }
      }
    } catch (error) {
      route = null;
      console.warn('[Bili Workspace] 位置记录暂不可用。', error);
    }
  }

  function trackHistoryEntry(event) {
    if (writingHistory || stopped || pendingNavigation || !route || pageKind() !== kind) return;
    const marked = validRoute(history.state?.[STATE_KEY]);
    if (event.navigationType === 'traverse') {
      // An unmarked native history entry is outside our tracked chain.
      if (!marked) {
        route = { workspace: crypto.randomUUID(), step: 0 };
      } else route = marked;
    } else if (event.navigationType === 'push') {
      const book = currentBook();
      if (book) {
        book.entries = book.entries.filter(entry => entry.step <= route.step);
        storeBook(book);
      }
      route = { ...route, step: route.step + 1 };
    } else if (marked?.workspace === route.workspace && marked.step === route.step) return;
    currentPage = workspacePage(location.href);
    stampRoute();
    rememberRoute();
  }

  function navigateWorkspace(page) {
    if (!page || stopped || pendingNavigation) return;
    saveFeedPosition();
    saveCodeDraft();
    if (page.id === currentPage?.id) {
      setView('preview');
      return;
    }
    pendingNavigation = true;
    // Wait for the per-Chrome-tab state to reach the extension background
    // before activating a document whose synchronous GM values may be stale.
    persistTabState(() => commitWorkspaceNavigation(page));
  }

  function flushQueuedNavigation() {
    if (!tabStateReady || pendingNavigation || !queuedNavigation || stopped) return;
    const { page, label } = queuedNavigation;
    queuedNavigation = null;
    rememberPage(page, label);
    navigateWorkspace(page);
  }

  function commitWorkspaceNavigation(page) {
    if (stopped) return;
    if (!route) {
      location.assign(page.url);
      return;
    }
    const book = currentBook();
    const previous = book?.entries.filter(entry => entry.page === page.id
      && Number.isInteger(entry.step) && entry.step !== route.step)
      .sort((a, b) => Math.abs(a.step - route.step) - Math.abs(b.step - route.step))[0];
    if (previous && window.navigation && validRoute(history.state?.[STATE_KEY])) {
      const distance = previous.step - route.step;
      if (Math.abs(distance) < history.length) {
        history.go(distance);
        return;
      }
    }
    if (book) {
      // A new navigation discards the forward branch, as the browser does.
      book.entries = book.entries.filter(entry => entry.step <= route.step);
      storeBook(book);
    }
    const token = crypto.randomUUID();
    const saved = GM_getValue(KEY_TRANSFERS, []);
    const transfers = Array.isArray(saved) ? saved.filter(item =>
      item && Date.now() - item.time < 120000).slice(-31) : [];
    GM_setValue(KEY_TRANSFERS, [...transfers, {
      token, time: Date.now(), page: page.id,
      route: {
        workspace: route.workspace, step: route.step + 1,
        version: WORKSPACE_VERSION, tabStorage: tabStorageAvailable,
      },
      resume: page.kind === 'dynamic' && Boolean(book?.feed),
    }]);
    const destination = new URL(page.url);
    destination.searchParams.set(TRANSFER_PARAM, token);
    location.assign(destination.href);
  }

  function saveFeedPosition() {
    if (kind !== 'dynamic' || !route || feedRestore || view !== 'preview') return;
    const items = [...document.querySelectorAll('.bili-dyn-list__item[data-did]')];
    if (!items.length) return;
    const index = items.findIndex(item => item.getBoundingClientRect().bottom > 110);
    const anchors = items.slice(Math.max(0, index), Math.max(0, index) + 5).map(item => ({
      id: item.getAttribute('data-did'), offset: Math.round(item.getBoundingClientRect().top),
    }));
    const checkpoint = {
      time: Date.now(), y: window.scrollY, anchors,
      filter: document.querySelector('.bili-dyn-list-tabs__item.active')?.textContent.trim() || '全部',
    };
    const book = currentBook();
    if (!book) return;
    book.feed = checkpoint;
    const point = book.entries.find(entry => entry.step === route.step);
    if (point) point.feed = checkpoint;
    storeBook(book);
  }

  function validCheckpoint(value) {
    if (!value || !Array.isArray(value.anchors) || Date.now() - value.time > 86400000) return null;
    const anchors = value.anchors.slice(0, 5).filter(anchor => anchor
      && /^\d{1,30}$/.test(anchor.id) && Number.isFinite(anchor.offset)
      && Math.abs(anchor.offset) < 1000000);
    return anchors.length ? { ...value, anchors } : null;
  }

  function beginFeedRestore(cached = false) {
    if (kind !== 'dynamic' || feedRestore || stopped || (restoreTried && !cached)) return;
    const traversal = performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
    if (!cached && !resumeOnArrival && !traversal) return;
    const book = currentBook();
    const checkpoint = validCheckpoint(
      book?.entries.find(entry => entry.step === route?.step)?.feed || book?.feed,
    );
    if (!checkpoint) return;
    restoreTried = true;
    resumeOnArrival = false;
    feedRestore = {
      checkpoint, started: performance.now(), count: 0, changed: performance.now(),
      aligned: 0, filterApplied: false,
    };
    resumeMessage = 'Resuming activity…';
    advanceFeedRestore();
  }

  function cancelFeedRestore() {
    clearTimeout(restoreTimer);
    restoreTimer = 0;
    feedRestore = null;
    if (resumeMessage) {
      resumeMessage = '';
      scheduleScan();
    }
  }

  function advanceFeedRestore() {
    clearTimeout(restoreTimer);
    restoreTimer = 0;
    const state = feedRestore;
    if (!state || stopped) return;
    const now = performance.now();
    const tabs = [...document.querySelectorAll('.bili-dyn-list-tabs__item')];
    const wanted = tabs.find(tab => tab.textContent.trim() === state.checkpoint.filter);
    if (!state.filterApplied && wanted) {
      state.filterApplied = true;
      if (!wanted.classList.contains('active')) {
        wanted.click();
        restoreTimer = setTimeout(advanceFeedRestore, 250);
        return;
      }
    }
    const items = [...document.querySelectorAll('.bili-dyn-list__item[data-did]')];
    const match = state.checkpoint.anchors.map(anchor => ({
      anchor, node: items.find(item => item.getAttribute('data-did') === anchor.id),
    })).find(item => item.node);
    if (match) {
      const y = Math.max(0, window.scrollY + match.node.getBoundingClientRect().top - match.anchor.offset);
      window.scrollTo({ top: y, behavior: 'instant' });
      if (!state.aligned) state.aligned = now;
      // Allow a short period for image/layout settling; user input cancels it.
      if (now - state.aligned >= 800) {
        cancelFeedRestore();
        return;
      }
    } else {
      if (items.length !== state.count) {
        state.count = items.length;
        state.changed = now;
      }
      if (now - state.started > 45000 || (items.length && now - state.changed > 8000)) {
        cancelFeedRestore();
        resumeMessage = 'Activity position unavailable';
        scheduleScan();
        return;
      }
      // Reuse the site's normal infinite-loading scroll handler, without
      // requesting APIs, copying cards, or replacing the native application.
      if (items.length) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    }
    restoreTimer = setTimeout(advanceFeedRestore, 200);
    scheduleScan();
  }

  function plainClick(event) {
    return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
  }

  function openInWorkspace(event) {
    if (!plainClick(event) || event.defaultPrevented) return;
    if (kind === 'following') {
      const name = event.target?.closest?.('.favourite-card a.anchor-name, .favourite-card a.title');
      const detail = name?.closest('.favourite-card')?.querySelector('.live-detail');
      if (detail) {
        event.preventDefault();
        event.stopImmediatePropagation();
        detail.click();
        return;
      }
    }
    const target = event.target?.closest?.('a[href]');
    if (!target || event.target.closest(
      'button, input, textarea, .bili-watch-later, [contenteditable="true"]')) return;
    const page = workspacePage(target.href);
    if (!page) return;
    // Current-page shell links keep their existing preview-view handler.
    if (target.closest('#bwc-shell') && page.id === currentPage?.id) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const card = target.closest('.bili-dyn-card-video, .bili-video-card');
    const name = card?.querySelector('.bili-dyn-card-video__title, h3')?.textContent
      || card?.querySelector('.bili-video-card__title')?.textContent
      || target.getAttribute('title') || target.textContent;
    const label = !target.closest('#bwc-shell') && page.kind === 'video' && name?.trim()
      ? `▷ ${name.trim()}` : undefined;
    if (!tabStateReady) {
      queuedNavigation = { page, label };
      return;
    }
    rememberPage(page, label);
    navigateWorkspace(page);
  }

  function mount() {
    if (mounted || stopped) return;
    mounted = true;
    try {
      buildShell();
      disguiseTab();
      listen(document, 'click', openInWorkspace, true);
      scan();
      pageObserver = new MutationObserver(records => {
        const relevant = records.some(record => {
          const target = record.target.nodeType === 1
            ? record.target : record.target.parentElement;
          if (target?.closest?.('#bwc-shell, .bpx-player-container, #live-player, .chat-history-panel')) return false;
          return [...record.addedNodes].some(node => node.nodeType === 1)
            || [...record.removedNodes].some(node =>
              node === targetPlayer || node.nodeType === 1);
        });
        if (relevant) scheduleScan();
      });
      pageObserver.observe(document.body, { childList: true, subtree: true });
      // A late attachShadow on an existing host does not produce a document
      // mutation. Re-scan only comment hosts, at a low rate, to catch this case.
      observerTimer = window.setInterval(() => {
        if (!document.hidden) {
          if (pageKind() !== kind) {
            stop();
            return;
          }
          scanComments();
          bindPlayer();
          syncWorkspaceFiles();
        }
      }, 1800);
      listen(window, 'popstate', checkRoute);
      listen(window, 'hashchange', checkRoute);
      listen(document, 'fullscreenchange', updateScreen);
      listen(window, 'pagehide', event => {
        pendingNavigation = true;
        clearTimeout(resumeTimer);
        // Tampermonkey may already have disconnected its ports in pagehide.
        // Save in the earlier navigation event, never write GM storage here.
        document.getElementById('bwc-file-tabs').style.visibility = 'hidden';
        cancelFeedRestore();
        // Keep the shell on the outgoing document, including cached pages.
        // A discarded document releases its own observers/listeners naturally.
      });
      listen(window, 'pageshow', event => {
        if (stopped) return;
        const resume = () => {
          if (stopped) return;
          pendingNavigation = false;
          if (GM_getValue(KEY_ENABLED, false) !== true) {
            stop();
            return;
          }
          if (event.persisted) {
            route = validRoute(history.state?.[STATE_KEY]) || route;
            rememberRoute();
            setView('preview');
            beginFeedRestore(true);
          } else beginFeedRestore();
          document.getElementById('bwc-file-tabs').style.visibility = '';
          flushQueuedNavigation();
        };
        // Let the extension reconnect and deliver storage changes before a
        // cached document reads or writes shared state again.
        if (event.persisted) resumeTimer = window.setTimeout(() => refreshTabState(success => {
          if (!success) { location.reload(); return; }
          resume();
        }), 150);
        else resume();
      });
      if (window.navigation) {
        listen(window.navigation, 'navigate', event => {
          if (event.destination.sameDocument || event.downloadRequest != null || pendingNavigation) return;
          saveFeedPosition();
          saveCodeDraft();
          pendingNavigation = true;
        });
        listen(window.navigation, 'navigateerror', () => {
          pendingNavigation = false;
          document.getElementById('bwc-file-tabs').style.visibility = '';
          scheduleScan();
        });
        listen(window.navigation, 'currententrychange', trackHistoryEntry);
      }
      for (const name of ['wheel', 'touchstart', 'pointerdown']) {
        listen(window, name, () => cancelFeedRestore(), { passive: true });
      }
      listen(window, 'keydown', event => {
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
          cancelFeedRestore();
        }
      });
      beginFeedRestore();
    } catch (error) {
      console.error('[Bili Workspace] 外观加载失败，已还原页面。', error);
      stop();
    }
  }

  function listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    disposers.push(() => target.removeEventListener(event, handler, options));
  }

  function checkRoute() {
    if (pageKind() !== kind) stop();
    else scheduleScan();
  }

  function scheduleScan() {
    if (frame || stopped) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (pageKind() !== kind) {
        stop();
        return;
      }
      scan();
    });
  }

  function scan() {
    if (stopped || pendingNavigation) return;
    bindPlayer();
    scanComments();
    syncContentVisibility();
    syncLibraryNavigation();
    syncWorkspaceFiles();
    const count = document.querySelectorAll('.bili-dyn-list__item').length;
    const counter = document.getElementById('bwc-status-count');
    const text = view === 'code' ? (editor?.editing ? 'Plain Text · Editing' : 'Code Preview')
      : resumeMessage || (
      kind === 'dynamic' ? `${count} records`
      : kind === 'home' ? `${[...document.querySelectorAll(
        '.recommended-container_floor-aside .bili-video-card, .recommended-container_floor-aside .bili-live-card',
      )].filter(card => !card.closest('.recommended-swipe') && card.querySelector(
        '.bili-video-card__info--tit, .bili-live-card__info--tit')).length} recommendations`
      : kind === 'following' ? `${document.querySelectorAll('.favourite-card').length} follows`
      : kind === 'favorites' ? `${document.querySelectorAll('.fav-list-main .bili-video-card').length} saved items`
      : kind === 'watchlater' ? `${document.querySelectorAll('.watchlater-list-container .video-card').length} queued items`
      : kind === 'live' ? 'Stream' : 'Preview');
    if (counter && counter.textContent !== text) counter.textContent = text;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function link(label, href, className) {
    const node = element('a', className, label);
    node.href = href;
    return node;
  }

  function buildShell() {
    const shell = element('div');
    shell.id = 'bwc-shell';
    const bar = element('header', 'bwc-titlebar');
    bar.append(element('span', 'bwc-brand', '⌘'));
    const menu = element('span', 'bwc-menutext', 'File   Edit   View   Go');
    menu.setAttribute('aria-hidden', 'true');
    bar.append(menu, element('span', 'bwc-windowtitle', 'workspace'));
    const close = element('button', 'bwc-close', '关闭伪装');
    close.type = 'button';
    close.title = '关闭工作界面并刷新，恢复当前的 B 站页面和插件';
    close.addEventListener('click', () => {
      GM_setValue(KEY_ENABLED, false);
      stop();
      location.reload();
    });
    bar.append(close);

    const activity = element('nav', 'bwc-activity');
    activity.setAttribute('aria-label', '工作区导航');
    for (const [pageKind, symbol, , name, href] of libraryEntries()) {
      const entry = link(symbol, href, 'bwc-activity-link');
      entry.title = name;
      entry.setAttribute('aria-label', `打开${name}`);
      entry.dataset.bwcView = 'preview';
      entry.dataset.bwcKind = pageKind;
      entry.classList.toggle('bwc-selected', kind === pageKind);
      if (pageKind === 'favorites') entry.addEventListener('click', event => {
        if (!favoritesUrl) event.preventDefault();
      });
      if (kind === pageKind) entry.addEventListener('click', event => {
        if (!plainClick(event)) return;
        event.preventDefault();
        setView('preview');
      });
      activity.append(entry);
    }
    const preview = element('button', 'bwc-activity-link', '▷');
    preview.type = 'button';
    preview.title = playback ? '返回播放器' : '从列表中选择视频';
    preview.setAttribute('aria-label', preview.title);
    preview.disabled = !playback;
    preview.classList.toggle('bwc-selected', playback);
    preview.dataset.bwcView = 'preview';
    preview.dataset.bwcKind = playback ? kind : 'video';
    preview.addEventListener('click', () => setView('preview'));
    activity.append(preview);
    const comments = element('button', 'bwc-activity-link', '☷');
    comments.type = 'button';
    comments.title = kind === 'live' ? 'Stream output' : '评论';
    comments.setAttribute('aria-label', kind === 'live' ? '跳到直播弹幕' : '跳到评论');
    comments.disabled = !playback && kind !== 'dynamic';
    comments.addEventListener('click', () => {
      setView('preview');
      if (kind === 'live') {
        const panel = document.getElementById('chat-history-list');
        if (panel) {
          panel.tabIndex = -1;
          panel.focus({ preventScroll: true });
        }
      } else if (kind === 'video') {
        const panel = document.getElementById('commentapp');
        if (panel) {
          panel.tabIndex = -1;
          panel.focus({ preventScroll: true });
        }
      } else {
        const opened = document.querySelector(
          '.bili-dyn-item__panel bili-comments, .bili-dyn-item__panel .bb-comment',
        );
        if (opened) opened.scrollIntoView({ block: 'start', behavior: 'smooth' });
        else document.querySelector('.bili-dyn-action.comment')
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
    activity.append(comments);
    const sourceIcon = element('button', 'bwc-activity-link bwc-source-shortcut', '‹›');
    sourceIcon.type = 'button';
    sourceIcon.title = '在工作区内显示代码';
    sourceIcon.setAttribute('aria-label', '显示代码');
    sourceIcon.dataset.bwcView = 'code';
    sourceIcon.addEventListener('click', () => setView('code'));
    activity.append(sourceIcon);

    const explorer = element('aside', 'bwc-explorer');
    explorer.append(element('div', 'bwc-explorer-title', 'EXPLORER'));
    explorer.append(element('div', 'bwc-folder', '⌄  WORKSPACE'));
    for (const [pageKind, , label, , href] of libraryEntries()) {
      const entry = link(label, href, `bwc-file${kind === pageKind ? ' bwc-current' : ''}`);
      entry.dataset.bwcView = 'preview';
      entry.dataset.bwcKind = pageKind;
      if (pageKind === 'favorites') entry.addEventListener('click', event => {
        if (!favoritesUrl) event.preventDefault();
      });
      if (kind === pageKind) entry.addEventListener('click', event => {
        if (!plainClick(event)) return;
        event.preventDefault();
        setView('preview');
      });
      explorer.append(entry);
    }
    const current = element('button',
      `bwc-file${playback ? ' bwc-current' : ''}`, kind === 'live' ? '◉  stream.log' : '▷  preview');
    current.type = 'button';
    current.disabled = !playback;
    current.dataset.bwcView = 'preview';
    current.dataset.bwcKind = playback ? kind : 'video';
    current.setAttribute('aria-label', '显示播放视图');
    current.addEventListener('click', () => setView('preview'));
    explorer.append(current);
    const source = element('button', 'bwc-file', 'JS  source.js');
    source.type = 'button';
    source.title = '在工作区内显示代码';
    source.setAttribute('aria-label', '显示代码 source.js');
    source.dataset.bwcView = 'code';
    source.addEventListener('click', () => setView('code'));
    explorer.append(source);
    const note = element('div', 'bwc-explorer-note', 'workspace / local');
    explorer.append(note);

    const tabs = element('div', 'bwc-tabs');
    const fileTabs = element('div', 'bwc-file-tabs');
    fileTabs.id = 'bwc-file-tabs';
    fileTabs.setAttribute('role', 'tablist');
    fileTabs.setAttribute('aria-label', '工作区文件');
    tabs.append(fileTabs);
    const tools = element('div', 'bwc-view-tools');
    if (playback) {
      const layoutSelect = element('select', 'bwc-layout');
      layoutSelect.id = 'bwc-layout';
      layoutSelect.setAttribute('aria-label', '播放页布局');
      layoutSelect.title = '左右布局在窄窗口自动使用上下排列；可随时选择上下布局回退';
      for (const [value, label] of [['split', '左右布局'], ['stacked', '上下布局']]) {
        const option = element('option', '', label);
        option.value = value;
        option.selected = value === layout;
        layoutSelect.append(option);
      }
      layoutSelect.addEventListener('change', () => setLayout(layoutSelect.value));
      tools.append(layoutSelect);
      const select = element('select', 'bwc-size');
      select.id = 'bwc-size';
      select.setAttribute('aria-label', '播放区域宽度');
      for (const value of [640, 440]) {
        const option = element('option', '', `${value} px`);
        option.value = String(value);
        option.selected = value === width;
        select.append(option);
      }
      select.addEventListener('change', () => setWidth(Number(select.value)));
      tools.append(select);
    }
    tabs.append(tools);
    const crumbs = element('div', 'bwc-breadcrumb',
      `workspace  ›  ${previewFileName()}`);
    crumbs.id = 'bwc-breadcrumb';
    const codeView = element('section', 'bwc-code-view');
    codeView.id = 'bwc-code-view';
    codeView.hidden = true;
    codeView.tabIndex = 0;
    codeView.setAttribute('aria-label', '代码视图');
    const status = element('footer', 'bwc-status');
    status.append(element('span', '', '⑂  main'));
    status.append(element('span', '', '✓'));
    const counter = element('span', 'bwc-status-right', '');
    counter.id = 'bwc-status-count';
    status.append(counter, element('span', '', 'UTF-8'), element('span', '', 'workspace'));
    shell.append(bar, activity, explorer, tabs, crumbs, codeView, status);
    document.body.append(shell);
    syncWorkspaceFiles();
  }

  function previewFileName() {
    return {
      dynamic: 'activity.log', home: 'home.log', following: 'live.log',
      favorites: 'favorites.log', watchlater: 'watchlater.log',
      video: 'preview', live: 'stream.log',
    }[kind];
  }

  function setLayout(value) {
    layout = value === 'stacked' ? 'stacked' : 'split';
    GM_setValue(KEY_LAYOUT, layout);
    if (stopped) return;
    document.documentElement.classList.toggle('bwc-layout-split', layout === 'split');
    document.documentElement.classList.toggle('bwc-layout-stacked', layout === 'stacked');
    const select = document.getElementById('bwc-layout');
    if (select) select.value = layout;
    measurePlayer();
  }

  function setView(value) {
    if (stopped) return;
    const next = value === 'code' ? 'code' : 'preview';
    const previous = view;
    if (previous === 'preview' && next === 'code') {
      saveFeedPosition();
      previewScroll = window.scrollY;
    }
    view = next;
    const codeView = document.getElementById('bwc-code-view');
    if (view === 'code' && !codeView.firstChild) renderCode(codeView);
    else if (view === 'code' && editor && !editor.dirty) {
      const saved = readCodeDraft();
      if (saved && (saved.text !== editor.saved?.text || saved.name !== editor.saved?.name)) {
        editor.saved = saved;
        editor.text = saved.text;
        editor.name = saved.name;
        editor.custom.disabled = false;
        editor.message.textContent = 'Saved locally';
        updateCodeView();
      }
    }
    codeView.hidden = view !== 'code';
    document.documentElement.classList.toggle('bwc-code-open', view === 'code');
    for (const control of document.querySelectorAll('#bwc-shell [data-bwc-view], #bwc-shell [data-bwc-page]')) {
      const selected = control.dataset.bwcPage
        ? view === 'preview' && control.dataset.bwcPage === currentPage?.id
        : control.dataset.bwcView === view
          && (view === 'code' || control.dataset.bwcKind === kind) && !control.disabled;
      if (control.getAttribute('role') === 'tab') {
        control.classList.toggle('bwc-tab-active', selected);
        control.setAttribute('aria-selected', String(selected));
      } else if (control.classList.contains('bwc-file')) {
        control.classList.toggle('bwc-current', selected);
      } else {
        control.classList.toggle('bwc-selected', selected);
      }
    }
    const currentFile = view === 'code' ? (editor?.name || 'source.js')
      : previewFileName();
    document.getElementById('bwc-breadcrumb').textContent = `workspace  ›  ${currentFile}`;
    const tools = document.querySelector('.bwc-view-tools');
    if (tools) tools.hidden = view === 'code';
    syncContentVisibility();
    scan();
    if (view === 'code') {
      (editor?.editing ? editor.input : codeView).focus({ preventScroll: true });
    }
    else if (previous === 'code') {
      window.scrollTo({ top: previewScroll, behavior: 'instant' });
    }
  }

  function syncContentVisibility() {
    if (view === 'code') {
      for (const app of document.querySelectorAll('#app, #live-center-app, #mirror-vdcon, .live-room-app')) {
        if (!concealedNodes.has(app)) {
          concealedNodes.set(app, {
            inert: app.getAttribute('inert'), 'aria-hidden': app.getAttribute('aria-hidden'),
          });
          app.setAttribute('inert', '');
          app.setAttribute('aria-hidden', 'true');
        }
      }
    } else {
      for (const [node, attrs] of concealedNodes) {
        for (const [name, value] of Object.entries(attrs)) {
          if (value === null) node.removeAttribute(name);
          else node.setAttribute(name, value);
        }
      }
      concealedNodes.clear();
    }
  }

  function builtInCode() {
    return '// source.js — Bili Workspace\n'
      + '// Workspace layout and appearance controller.\n\n'
      + `(${biliWorkspace.toString()})();`;
  }

  function codeFileName(value) {
    return String(value || 'notes.txt').split(/[\\/]/).pop()
      .replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 100) || 'notes.txt';
  }

  function readCodeDraft() {
    const cached = GM_getValue(KEY_CODE, null);
    const current = tabStorageAvailable && tabStateReady ? tabState[KEY_CODE] : null;
    const saved = current && (current.time || 0) >= (cached?.time || 0) ? current : cached;
    return saved && typeof saved.text === 'string' && saved.text.length <= CODE_LIMIT
      ? { name: codeFileName(saved.name), text: saved.text, time: saved.time || 0 } : null;
  }

  function saveCodeDraft() {
    if (!editor?.dirty) return;
    clearTimeout(editor.timer);
    try {
      const draft = { name: editor.name, text: editor.text, time: Date.now() };
      GM_setValue(KEY_CODE, draft);
      if (tabStorageAvailable && tabStateReady) {
        tabState[KEY_CODE] = draft;
        persistTabState();
      }
      editor.saved = draft;
      editor.dirty = false;
      editor.custom.disabled = false;
      editor.message.textContent = 'Saved locally';
    } catch (_) {
      editor.message.textContent = 'Save failed · use Export';
    }
  }

  function renderCode(container) {
    const saved = readCodeDraft();
    const toolbar = element('div', 'bwc-code-toolbar');
    const file = element('input');
    file.type = 'file';
    file.hidden = true;
    file.accept = '.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.c,.h,.cpp,.hpp,.cs,.java,.go,.rs,.sh,.ps1,.json,.yaml,.yml,.html,.xml,.css,.scss,.md,.txt,.log';
    file.setAttribute('aria-label', '选择本地代码文件');
    const open = element('button', '', 'Open File');
    const edit = element('button', '', 'Edit');
    const exportFile = element('button', '', 'Export');
    const builtin = element('button', '', 'Built-in');
    const custom = element('button', '', 'My Code');
    for (const button of [open, edit, exportFile, builtin, custom]) button.type = 'button';
    open.title = '选择 UTF-8 文本或代码文件（最大 256 KB）；只读取文本';
    edit.title = '切换编辑／语法预览；编辑时自动保存本地草稿';
    exportFile.title = '将当前完整文本导出为文件，不覆盖原文件';
    builtin.title = '查看内置脚本源码，保留自己的代码草稿';
    custom.title = '回到已保存的自定义代码';
    custom.disabled = !saved;
    const filename = element('span', 'bwc-code-filename');
    const message = element('span', 'bwc-code-message', saved ? 'Saved locally' : 'Built-in source');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    toolbar.append(open, edit, exportFile, builtin, custom, filename, message, file);
    const body = element('div', 'bwc-code-body');
    const pre = element('pre', 'bwc-code');
    const input = element('textarea', 'bwc-code-input');
    input.setAttribute('aria-label', '代码编辑器');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.wrap = 'off';
    input.maxLength = CODE_LIMIT;
    input.hidden = true;
    body.append(pre, input);
    container.append(toolbar, body);
    editor = {
      text: saved?.text ?? builtInCode(), name: saved?.name || 'source.js',
      saved, editing: false, dirty: false, timer: 0,
      input, pre, edit, custom, filename, message,
    };
    const update = () => {
      if (input.value.length > CODE_LIMIT) {
        message.textContent = 'Limit: 256K characters · use a smaller file';
        return;
      }
      editor.text = input.value;
      editor.dirty = true;
      clearTimeout(editor.timer);
      message.textContent = 'Saving…';
      editor.timer = window.setTimeout(saveCodeDraft, 400);
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveCodeDraft();
      } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey
        && !event.altKey && input.value.length + 2 <= CODE_LIMIT) {
        event.preventDefault();
        input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
        update();
      }
    });
    open.addEventListener('click', () => file.click());
    let selection = 0;
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      const request = ++selection;
      if (!chosen) return;
      try {
        if (chosen.size > CODE_LIMIT) throw new Error('File too large · maximum 256 KB');
        const text = await chosen.text();
        if (request !== selection || stopped) return;
        if (text.includes('\u0000')) throw new Error('Choose a text file');
        editor.text = text.replace(/^\uFEFF/, '');
        editor.name = codeFileName(chosen.name);
        editor.dirty = true;
        saveCodeDraft();
        updateCodeView();
      } catch (error) {
        message.textContent = error.message || 'Unable to read file';
      } finally {
        file.value = '';
      }
    });
    edit.addEventListener('click', () => {
      editor.editing = !editor.editing;
      saveCodeDraft();
      updateCodeView();
      if (editor.editing) input.focus({ preventScroll: true });
      scan();
    });
    builtin.addEventListener('click', () => {
      ++selection;
      saveCodeDraft();
      editor.text = builtInCode();
      editor.name = 'source.js';
      editor.editing = false;
      message.textContent = 'Built-in source';
      updateCodeView();
      scan();
    });
    custom.addEventListener('click', () => {
      ++selection;
      saveCodeDraft();
      const draft = editor.saved;
      if (!draft) return;
      editor.text = draft.text;
      editor.name = draft.name;
      message.textContent = 'Saved locally';
      updateCodeView();
    });
    exportFile.addEventListener('click', () => {
      saveCodeDraft();
      const url = URL.createObjectURL(new Blob([editor.text], { type: 'text/plain;charset=utf-8' }));
      const download = element('a');
      download.href = url;
      download.download = codeFileName(editor.name);
      container.append(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    updateCodeView();
  }

  function updateCodeView() {
    if (!editor) return;
    editor.input.hidden = !editor.editing;
    editor.pre.hidden = editor.editing;
    editor.edit.textContent = editor.editing ? 'Preview' : 'Edit';
    editor.filename.textContent = editor.name;
    editor.filename.title = editor.name;
    editor.input.value = editor.text;
    if (!editor.editing) {
      editor.pre.replaceChildren();
      highlightCode(editor.pre, editor.text);
    }
    if (view === 'code') {
      document.getElementById('bwc-breadcrumb').textContent = `workspace  ›  ${editor.name}`;
    }
  }

  function highlightCode(pre, code) {
    const keywords = new Set([
      'const', 'let', 'function', 'return', 'if', 'else', 'for', 'of', 'in',
      'new', 'try', 'catch', 'throw', 'true', 'false', 'null', 'undefined',
    ]);
    let blockComment = false;
    let template = false;
    for (const [index, line] of code.split('\n').entries()) {
      const row = element('div', 'bwc-code-row');
      const number = element('span', 'bwc-line-number', String(index + 1));
      number.setAttribute('aria-hidden', 'true');
      const content = element('code', 'bwc-code-line');
      const tokens = line.match(/\/\*|\*\/|\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\s+|./g) || [' '];
      for (const token of tokens) {
        let color = '';
        if (blockComment || token === '/*' || token.startsWith('//')) color = 'comment';
        else if (template || /^["'`]/.test(token)) color = 'string';
        else if (keywords.has(token)) color = 'keyword';
        else if (/^\d/.test(token)) color = 'number';
        else if (/^[A-Z_$][\w$]*$/.test(token)) color = 'type';
        content.append(element('span', color ? `bwc-token-${color}` : '', token));
        if (token === '/*' && !template) blockComment = true;
        if (token === '*/') blockComment = false;
        if (token === '`' && !blockComment) template = !template;
      }
      row.append(number, content);
      pre.append(row);
    }
  }

  function setWidth(value) {
    width = value === 440 ? 440 : 640;
    GM_setValue(KEY_WIDTH, width);
    if (stopped) return;
    document.documentElement.style.setProperty('--bwc-player-width', `${width}px`);
    const select = document.getElementById('bwc-size');
    if (select) select.value = String(width);
  }

  function bindPlayer() {
    if (!playback) return;
    const wrap = kind === 'live' ? document.querySelector('#player-ctnr .player-section')
      : document.getElementById('playerWrap');
    const player = kind === 'live' ? wrap?.querySelector('#live-player-ctnr')
      : wrap?.querySelector('.bpx-player-container');
    if (wrap !== targetPlayer) {
      resizeObserver?.disconnect();
      screenObserver?.disconnect();
      targetPlayer = wrap || null;
      if (wrap) {
        resizeObserver = new ResizeObserver(() => measurePlayer());
        resizeObserver.observe(wrap);
        measurePlayer();
      }
    }
    if (player && player !== bindPlayer.container) {
      screenObserver?.disconnect();
      bindPlayer.container = player;
      screenObserver = new MutationObserver(updateScreen);
      screenObserver.observe(player, {
        attributes: true, attributeFilter: ['data-screen', 'class'],
      });
      if (kind === 'live') {
        screenObserver.observe(document.documentElement, {
          attributes: true, attributeFilter: ['class'],
        });
        screenObserver.observe(document.body, {
          attributes: true, attributeFilter: ['class'],
        });
      }
      updateScreen();
    }
  }

  function measurePlayer() {
    if (!targetPlayer || document.documentElement.classList.contains('bwc-expanded')) return;
    const actual = Math.round(targetPlayer.getBoundingClientRect().width * 100) / 100;
    document.documentElement.classList.toggle('bwc-small-player', actual < 560);
    if (actual > 0 && actual !== measuredWidth) {
      measuredWidth = actual;
      document.documentElement.style.setProperty('--bwc-video-height', `${actual * 9 / 16}px`);
    }
  }

  function updateScreen() {
    const container = bindPlayer.container;
    const expanded = Boolean(document.fullscreenElement)
      || ['web', 'full'].includes(container?.getAttribute('data-screen'))
      || Boolean(document.querySelector('#bilibili-player.mode-webscreen'))
      || (kind === 'live' && (document.documentElement.classList.contains('player-full-win')
        || document.body.classList.contains('player-full-win')));
    if (document.documentElement.classList.contains('bwc-expanded') !== expanded) {
      document.documentElement.classList.toggle('bwc-expanded', expanded);
    }
    if (!expanded) measurePlayer();
  }

  function scanComments(scope = document) {
    if (stopped) return;
    // Query only comment components; do not scan the player subtree or inspect
    // component internals, account data, tokens or private framework state.
    const hosts = scope.querySelectorAll(
      'bili-comments, bili-comment-thread-renderer, bili-comment-renderer, '
      + 'bili-comment-reply-renderer, bili-comment-replies-renderer, '
      + 'bili-comment-rich-text, bili-rich-text, bili-comment-user-info, '
      + 'bili-comment-action-buttons-renderer, bili-comment-header-renderer, '
      + 'bili-comment-textarea, bili-comment-box',
    );
    for (const host of hosts) {
      const root = host.shadowRoot;
      if (!root) continue;
      if (!roots.has(root)) {
        const shadowStyle = document.createElement('style');
        shadowStyle.dataset.bwc = 'comments';
        shadowStyle.textContent = shadowCss();
        root.append(shadowStyle);
        const observer = new MutationObserver(records => {
          if (stopped) return;
          if (!shadowStyle.isConnected) root.append(shadowStyle);
          if (records.some(record => [...record.addedNodes].some(node =>
            node.nodeType === 1 && node !== shadowStyle))) {
            scanComments(root);
          }
        });
        observer.observe(root, { childList: true, subtree: true });
        roots.set(root, { style: shadowStyle, observer });
      }
      scanComments(root);
    }
    for (const [root, entry] of roots) {
      if (!root.host.isConnected) {
        entry.observer.disconnect();
        roots.delete(root);
      }
    }
  }

  function disguiseTab() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
      + '<rect width="32" height="32" rx="5" fill="#181818"/>'
      + '<path d="m24 5-12 9-6-4-3 3 6 5-6 5 3 3 6-5 12 7 5-2V7Z" '
      + 'fill="#3c9ee8"/><path d="M24 10v13l-9-5z" fill="#181818"/></svg>';
    const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    function apply() {
      if (stopped) return;
      if (document.title !== title) document.title = title;
      for (const icon of document.querySelectorAll('link[rel~="icon"]')) {
        if (!originalIcons.has(icon)) {
          originalIcons.set(icon, {
            href: icon.getAttribute('href'), type: icon.getAttribute('type'),
          });
        }
        if (icon.getAttribute('href') !== href) {
          icon.setAttribute('href', href);
          icon.setAttribute('type', 'image/svg+xml');
        }
      }
      if (!document.querySelector('link[rel~="icon"]')) {
        const icon = document.createElement('link');
        icon.id = 'bwc-icon';
        icon.rel = 'icon';
        icon.href = href;
        document.head.append(icon);
      }
    }
    apply();
    titleObserver = new MutationObserver(apply);
    titleObserver.observe(document.head, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['href', 'rel'],
    });
  }

  function stop() {
    if (stopped) return;
    saveCodeDraft();
    if (editor) clearTimeout(editor.timer);
    stopped = true;
    cancelAnimationFrame(frame);
    clearInterval(observerTimer);
    clearTimeout(restoreTimer);
    clearTimeout(resumeTimer);
    clearTimeout(tabReadTimer);
    bodyObserver?.disconnect();
    pageObserver?.disconnect();
    titleObserver?.disconnect();
    resizeObserver?.disconnect();
    screenObserver?.disconnect();
    for (const entry of roots.values()) {
      entry.observer.disconnect();
      entry.style.remove();
    }
    roots.clear();
    for (const dispose of disposers) dispose();
    view = 'preview';
    syncContentVisibility();
    document.getElementById('bwc-shell')?.remove();
    document.getElementById('bwc-icon')?.remove();
    style.remove();
    document.documentElement.classList.remove(
      CLASS, 'bwc-video', 'bwc-dynamic', 'bwc-home', 'bwc-following', 'bwc-live',
      'bwc-favorites', 'bwc-watchlater',
      'bwc-expanded', 'bwc-small-player',
      'bwc-code-open', 'bwc-layout-split', 'bwc-layout-stacked',
    );
    for (const name of ['--bwc-player-width', '--bwc-video-height']) {
      document.documentElement.style.removeProperty(name);
    }
    for (const [icon, attrs] of originalIcons) {
      if (!icon.isConnected) continue;
      for (const [name, value] of Object.entries(attrs)) {
        if (value === null) icon.removeAttribute(name);
        else icon.setAttribute(name, value);
      }
    }
    if (document.title === title) document.title = originalTitle;
  }

  function shadowCss() {
    return `
      :host {
        color-scheme: dark;
        --bg1: #1f1f1f; --bg2: #252526; --bg3: #2d2d30;
        --bg1_float: #252526; --bg2_float: #2d2d30;
        --text1: #d4d4d4; --text2: #b2b2b8; --text3: #85858e;
        --text4: #73737d; --line_regular: #363639; --line_light: #303034;
        --graph_bg_regular: #2d2d30; --graph_bg_thin: #252526;
        --brand_blue: #75beff; --brand_pink: #75beff;
        --bili-comment-font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
        color: #d4d4d4 !important;
        font-family: "Segoe UI", "Microsoft YaHei", sans-serif !important;
      }
      #content, #message, #contents, #body, .reply-content, .root-reply {
        color: #d4d4d4 !important;
      }
      #user-name, .user-name { color: #9cdcfe !important; }
      a { color: #75beff; }
      textarea, [contenteditable="true"] {
        background: #252526 !important; color: #d4d4d4 !important;
        border-color: #454549 !important; caret-color: #d4d4d4;
      }
    `;
  }

  function css() {
    return `
html.bwc-active {
  --bwc-bg: #1f1f1f; --bwc-panel: #181818; --bwc-border: #303034;
  --bwc-text: #d4d4d4; --bwc-muted: #85858e; --bwc-blue: #75beff;
  --bwc-rail: 48px; --bwc-tree: 176px;
  --bwc-side: calc(var(--bwc-rail) + var(--bwc-tree));
  --bwc-video-height: 360px;
  --bg1: #1f1f1f; --bg2: #252526; --bg3: #2d2d30;
  --bg1_float: #252526; --bg2_float: #2d2d30;
  --text1: #d4d4d4; --text2: #aaaab2; --text3: #85858e; --text4: #73737d;
  --line_regular: #363639; --line_light: #303034;
  --graph_bg_regular: #2d2d30; --graph_bg_thin: #252526;
  --brand_blue: #75beff; --brand_pink: #75beff;
  color-scheme: dark; background: var(--bwc-bg) !important;
  scroll-padding-top: 106px;
}
html.bwc-active body {
  min-width: 0 !important; margin: 0 !important;
  padding: 100px 0 40px var(--bwc-side) !important;
  background: var(--bwc-bg) !important; color: var(--bwc-text) !important;
  --custom-navbar-height: 0px; --navbar-height: 0px;
}
html.bwc-active #app {
  min-width: 0 !important; width: 100% !important; padding: 0 !important;
  margin: 0 !important; background: var(--bwc-bg) !important;
}
html.bwc-active :is(
  #biliMainHeader, #bili-header-container, .bili-header, .z-top-container,
  .custom-navbar, .custom-navbar-placeholder, .bili-dyn-sidebar,
  .fixed-sidenav-storage, .international-header, .mini-header,
  .gui-settings-widgets, .gui-settings-icon-panel, .bili-dyn-item__ornament,
  .bili-dyn-ornament, .video-note-sidebar-panel, .video-note-sidebar-chapter-portal
) { display: none !important; }
#bwc-shell, #bwc-shell * { box-sizing: border-box; }
#bwc-shell {
  font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #cccccc; --shell-top: 36px;
}
#bwc-shell button, #bwc-shell select, #bwc-shell a {
  font: inherit; color: inherit; text-decoration: none;
}
#bwc-shell button { cursor: pointer; }
#bwc-shell button:focus-visible, #bwc-shell a:focus-visible,
#bwc-shell select:focus-visible { outline: 1px solid #75beff; outline-offset: -2px; }
.bwc-titlebar {
  position: fixed; inset: 0 0 auto; height: 36px; z-index: 100010;
  background: #181818; border-bottom: 1px solid #303034;
  display: flex; align-items: center; gap: 18px; padding: 0 12px;
}
.bwc-brand { color: #3c9ee8; font-size: 23px; line-height: 1; }
.bwc-menutext { font-size: 12px; white-space: pre; color: #b8b8be; }
.bwc-windowtitle {
  margin: 0 auto; color: #aaaab2; border: 1px solid #303034;
  background: #222222; width: min(36vw, 420px); text-align: center;
  border-radius: 5px; font-size: 12px; line-height: 23px;
}
#bwc-shell .bwc-close {
  background: transparent; border: 1px solid #454549; border-radius: 4px;
  font-size: 12px; padding: 2px 9px; white-space: nowrap;
}
#bwc-shell .bwc-close:hover { background: #323238; }
.bwc-activity {
  position: fixed; top: 36px; bottom: 24px; left: 0; width: var(--bwc-rail);
  background: #181818; border-right: 1px solid #303034; z-index: 100002;
  display: flex; flex-direction: column; align-items: stretch;
}
#bwc-shell .bwc-activity-link {
  display: grid; place-items: center; width: 100%; height: 52px;
  background: transparent; border: 0; border-left: 2px solid transparent;
  font-size: 26px; color: #86868d;
}
#bwc-shell .bwc-activity-link.bwc-selected {
  color: #e5e5e5; border-left-color: #75beff;
}
#bwc-shell .bwc-activity-link:disabled { opacity: .35; cursor: default; }
#bwc-shell .bwc-source-shortcut { display: none; }
.bwc-explorer {
  position: fixed; left: var(--bwc-rail); top: 36px; bottom: 24px;
  width: var(--bwc-tree); background: #181818; border-right: 1px solid #303034;
  z-index: 100001; padding-top: 12px;
}
.bwc-explorer-title { padding: 0 18px 18px; font-size: 11px; letter-spacing: 1px; }
.bwc-folder { font-size: 11px; font-weight: 600; padding: 7px 14px; }
#bwc-shell .bwc-file {
  display: block; width: 100%; text-align: left; padding: 5px 16px 5px 28px;
  font-size: 12px; background: transparent; border: 0;
}
#bwc-shell .bwc-file:disabled { opacity: .45; cursor: default; }
#bwc-shell [aria-disabled="true"] { opacity: .4; cursor: wait; }
#bwc-shell .bwc-file:is(a,button):not(:disabled):hover { background: #2a2d2e; color: #f0f0f0; }
#bwc-shell .bwc-current { background: #37373d; color: #f0f0f0; }
.bwc-explorer-note { position: absolute; bottom: 20px; left: 18px; color: #68686e; font-size: 11px; }
.bwc-tabs {
  position: fixed; top: 36px; left: var(--bwc-side); right: 0; height: 36px;
  display: flex; justify-content: space-between; align-items: center;
  background: #181818; border-bottom: 1px solid #303034; z-index: 100000;
}
.bwc-tab {
  background: #181818; height: 36px; padding: 8px 16px; white-space: nowrap;
  border: 0; border-top: 1px solid transparent; border-right: 1px solid #303034;
  font-size: 12px;
}
#bwc-shell .bwc-tab-active { background: #1f1f1f; border-top-color: #007acc; color: #fff; }
.bwc-file-tabs, .bwc-view-tools { display: flex; align-items: center; min-width: 0; }
.bwc-file-tabs { flex: 1; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
.bwc-workspace-file { display: flex; align-items: center; flex: 0 0 auto; height: 36px; }
#bwc-shell .bwc-workspace-file > .bwc-tab {
  display: block; max-width: 230px; overflow: hidden; text-overflow: ellipsis;
  padding-right: 8px; border-right: 0; line-height: 19px;
}
#bwc-shell .bwc-tab-close {
  flex: 0 0 23px; width: 23px; height: 36px; padding: 0;
  background: #181818; border: 0; border-right: 1px solid #303034; color: #85858e;
}
#bwc-shell .bwc-tab-close:hover { background: #35353b; color: #fff; }
#bwc-shell .bwc-tab-close:disabled { opacity: .2; cursor: default; }
.bwc-view-tools { flex-shrink: 0; gap: 8px; margin-right: 16px; }
#bwc-shell .bwc-view-tools[hidden] { display: none; }
#bwc-shell :is(.bwc-size,.bwc-layout) {
  border: 1px solid #454549; border-radius: 3px;
  padding: 1px 7px; background: #252526; font-size: 11px;
}
.bwc-code-view {
  position: fixed; top: 100px; bottom: 24px; left: var(--bwc-side); right: 0;
  z-index: 90000; overflow: hidden; background: #1f1f1f; outline: none;
  display: flex; flex-direction: column;
  scrollbar-color: #55555d #1f1f1f;
}
#bwc-shell .bwc-code-view[hidden] { display: none; }
.bwc-code-toolbar {
  flex: 0 0 auto; min-height: 37px; display: flex; align-items: center;
  gap: 7px; padding: 5px 12px; border-bottom: 1px solid #303034;
  background: #202023; flex-wrap: wrap;
}
#bwc-shell .bwc-code-toolbar button {
  background: #2d2d30; border: 1px solid #454549; border-radius: 3px;
  padding: 2px 9px; font-size: 12px;
}
#bwc-shell .bwc-code-toolbar button:hover { background: #37373d; }
#bwc-shell .bwc-code-toolbar button:disabled { opacity: .4; cursor: default; }
.bwc-code-filename {
  color: #9cdcfe; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bwc-code-message { color: #85858e; font-size: 11px; margin-left: auto; }
.bwc-code-body { position: relative; flex: 1; min-height: 0; overflow: auto; }
#bwc-shell .bwc-code-input {
  display: block; width: 100%; height: 100%; resize: none;
  background: #1f1f1f; color: #d4d4d4; border: 0; outline: none; box-shadow: none;
  padding: 14px 24px; margin: 0; box-sizing: border-box; tab-size: 2;
  font: 13px/23px Consolas, "Cascadia Code", "Microsoft YaHei", monospace;
  white-space: pre; overflow: auto;
}
#bwc-shell :is(.bwc-code-input,.bwc-code-toolbar input,.bwc-code)[hidden] { display: none; }
.bwc-code {
  margin: 0; padding: 14px 24px 40px 0; width: max-content; min-width: 100%;
  font: 13px/23px Consolas, "Cascadia Code", "Microsoft YaHei", monospace;
  tab-size: 2; color: #d4d4d4; white-space: pre;
}
.bwc-code-row { display: flex; min-height: 23px; }
.bwc-code-row:hover { background: #242428; }
.bwc-line-number {
  width: 64px; flex: 0 0 64px; padding-right: 20px; color: #6e7681;
  text-align: right; user-select: none;
}
.bwc-code-line { font: inherit; white-space: pre; padding-right: 24px; }
.bwc-token-keyword { color: #c586c0; }
.bwc-token-string { color: #ce9178; }
.bwc-token-comment { color: #6a9955; }
.bwc-token-number { color: #b5cea8; }
.bwc-token-type { color: #9cdcfe; }
html.bwc-active.bwc-code-open :is(#app, #live-center-app, #mirror-vdcon, .live-room-app) {
  opacity: 0 !important; pointer-events: none !important;
}
html.bwc-active.bwc-code-open, html.bwc-active.bwc-code-open body { overflow: hidden !important; }
.bwc-breadcrumb {
  position: fixed; top: 72px; left: var(--bwc-side); right: 0;
  height: 27px; padding: 4px 20px; background: #1f1f1f;
  font-size: 11px; color: #9999a2; z-index: 99999;
  border-bottom: 1px solid #29292d;
}
.bwc-status {
  position: fixed; inset: auto 0 0; height: 24px; z-index: 100010;
  background: #007acc; color: #fff; display: flex; align-items: center;
  padding: 0 12px; gap: 20px; font-size: 11px;
}
.bwc-status-right { margin-left: auto; }
/* Keep the original homepage cards and recommendation/lazy-load handlers. */
html.bwc-home :is(
  .browser-tip, .adblock-tips, .fixed-channel-shim, .bili-header__channel,
  .recommended-swipe, .floor-single-card, .feed-roll-btn, .palette-button-wrap
) { display: none !important; }
html.bwc-home .bili-feed4-layout {
  width: min(900px, calc(100% - 40px)) !important; min-width: 0 !important;
  margin: 0 auto !important; padding: 16px 0 0 !important;
}
html.bwc-home .bili-feed4-layout::before {
  content: "// home.log · 主站推荐"; display: block; padding: 0 0 14px;
  color: #6a9955; font: 13px/24px Consolas, "Microsoft YaHei", monospace;
  border-bottom: 1px solid #303034;
}
html.bwc-home :is(.bili-feed4, .feed2, .recommended-container_floor-aside) {
  width: 100% !important; min-width: 0 !important; margin: 0 !important;
  padding: 0 !important; background: transparent !important;
}
html.bwc-home .recommended-container_floor-aside {
  counter-reset: bwc-home-record;
}
html.bwc-home .recommended-container_floor-aside > .container {
  display: block !important; width: 100% !important; padding: 0 !important;
  margin: 0 !important;
}
html.bwc-home .recommended-container_floor-aside > .container > :is(
  .feed-card, .bili-feed-card, .bili-video-card, .bili-live-card
) {
  display: block !important; margin: 0 !important; padding: 16px 0 16px 36px !important;
  width: auto !important; min-width: 0 !important; height: auto !important;
  border-bottom: 1px solid #303034; position: relative; counter-increment: bwc-home-record;
}
html.bwc-home .recommended-container_floor-aside > .container > :is(
  .feed-card, .bili-feed-card, .bili-video-card, .bili-live-card
)::before {
  content: counter(bwc-home-record, decimal-leading-zero);
  position: absolute; left: 0; top: 24px; color: #61616b; font: 12px/20px Consolas, monospace;
}
/* Blocked-ad replacements can be absolutely positioned and otherwise spill
   across following rows. Hide only slots with neither content nor a skeleton. */
html.bwc-home .recommended-container_floor-aside > .container > :is(
  .feed-card, .bili-feed-card, .bili-video-card, .bili-live-card
):not(:has(
  .bili-video-card__wrap, .bili-video-card__skeleton,
  .bili-live-card__wrap, .bili-live-card__skeleton
)) { display: none !important; }
html.bwc-home .recommended-container_floor-aside :is(.bili-video-card, .bili-live-card) {
  background: transparent !important;
}
html.bwc-home .recommended-container_floor-aside :is(
  .bili-video-card__skeleton:not(.hide), .bili-live-card__skeleton:not(.hide)
) { display: flex; width: 100% !important; height: 86px !important; }
html.bwc-home .recommended-container_floor-aside :is(
  .bili-video-card__skeleton--cover, .bili-live-card__skeleton--cover
) { flex: 0 0 144px; width: 144px !important; height: 86px !important; padding: 0 !important; }
html.bwc-home .recommended-container_floor-aside :is(
  .bili-video-card__skeleton--info, .bili-live-card__skeleton--info
) { flex: 1; min-width: 0; padding: 4px 0 0 16px !important; }
html.bwc-home .recommended-container_floor-aside :is(.bili-video-card__wrap, .bili-live-card__wrap) {
  display: flex !important; width: 100%; min-width: 0; background: transparent !important;
}
html.bwc-home .recommended-container_floor-aside :is(.bili-video-card__image--link, .bili-live-card__image--link) {
  flex: 0 0 144px; width: 144px !important; height: 86px !important;
  border: 1px solid #363639; border-radius: 4px !important;
}
html.bwc-home .recommended-container_floor-aside :is(
  .bili-video-card__image, .bili-video-card__image--wrap, .bili-live-card__image
) {
  height: 86px !important; padding: 0 !important;
}
html.bwc-home .recommended-container_floor-aside :is(.bili-video-card__info--right, .bili-live-card__info) {
  flex: 1; min-width: 0; padding: 4px 0 0 16px !important; background: transparent !important;
}
html.bwc-home .recommended-container_floor-aside :is(.bili-video-card__info--tit, .bili-live-card__info--tit) {
  color: #ce9178 !important; font: 14px/24px "Segoe UI", "Microsoft YaHei", sans-serif !important;
  height: auto !important; margin: 0 0 8px !important; -webkit-line-clamp: 2;
}
html.bwc-home .recommended-container_floor-aside :is(.bili-video-card__info--tit, .bili-live-card__info--tit) a {
  color: #ce9178 !important;
}
html.bwc-home .recommended-container_floor-aside :is(
  .bili-video-card__info--owner, .bili-live-card__info--author, .bili-live-card__info--uname
) {
  color: #85858e !important; font: 12px/20px "Segoe UI", "Microsoft YaHei", sans-serif;
}
/* Native saved libraries: retain folder switching, filters and pagination. */
html:is(.bwc-favorites, .bwc-watchlater) {
  --vui-bg: #1f1f1f; --vui-bg-soft: #252526;
  --vui-text: #d4d4d4; --vui-text-soft: #85858e;
  --vui-line: #363639;
}
html.bwc-favorites :is(.space-theme-bg, .space-header, .space-navbar, .space-float),
html.bwc-watchlater :is(.bili-footer, .fixed-side-menu, .fixed-nav-shim) {
  display: none !important;
}
html.bwc-favorites .space-main {
  width: min(1180px, calc(100% - 40px)) !important; min-width: 0 !important;
  margin: 0 auto !important; padding: 18px 0 0 !important;
  background: transparent !important;
}
html.bwc-favorites .space-favlist {
  display: grid !important; grid-template-columns: 180px minmax(0, 1fr);
  align-items: start; gap: 24px; min-width: 0 !important;
  padding: 0 !important; margin: 0 !important;
}
html.bwc-favorites .favlist-aside {
  position: sticky !important; top: 110px !important;
  width: 180px !important; min-width: 0 !important;
  max-height: calc(100dvh - 150px); overflow: auto;
  padding-right: 12px !important; border-right: 1px solid #303034;
  background: transparent !important;
}
html.bwc-favorites .favlist-aside :is(
  .vui_collapse, .vui_collapse_item, .vui_collapse_item_header,
  .vui_collapse_item_content, .vui_sidebar, .fav-collapse-wrap, .fav-sidebar-item,
  .vui_sidebar-item, .fav-collapse-create
) {
  background: transparent !important; color: #b2b2b8 !important;
  border-color: #303034 !important; min-width: 0;
}
html.bwc-favorites .vui_collapse_item_header {
  line-height: 36px !important; font-size: 12px;
}
html.bwc-favorites .vui_sidebar-item { padding: 8px !important; border-radius: 3px; }
html.bwc-favorites .vui_sidebar-item--active {
  background: #37373d !important; color: #f0f0f0 !important;
}
html.bwc-favorites .fav-sidebar-item__icon { flex-shrink: 0; }
html.bwc-favorites .vui_sidebar-item-right { color: #85858e !important; }
html.bwc-favorites .favlist-main {
  width: 100% !important; min-width: 0 !important; padding: 0 !important;
}
html.bwc-favorites .favlist-info {
  display: block !important; min-height: 0 !important;
  padding: 0 0 14px !important; margin: 0 0 12px !important;
  border-bottom: 1px solid #303034; background: transparent !important;
}
html.bwc-favorites :is(.favlist-info-file-card, .favlist-info-action) { display: none !important; }
html.bwc-favorites .favlist-info-detail {
  width: 100% !important; min-width: 0; padding: 0 !important;
}
html.bwc-favorites .favlist-info-detail__title {
  height: auto !important; min-height: 0 !important;
}
html.bwc-favorites .favlist-info-detail__title-row {
  color: #9cdcfe !important; font-size: 16px !important;
}
html.bwc-favorites .favlist-info-detail__data {
  color: #85858e !important; margin: 8px 0 !important; font-size: 12px;
}
html.bwc-favorites .favlist-info-detail__actions {
  display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px !important;
}
html.bwc-favorites .fav-list-header-filter {
  display: flex !important; flex-wrap: wrap; gap: 10px; height: auto !important;
  flex-direction: row !important; justify-content: space-between;
  padding: 6px 0 12px !important; align-items: center;
}
html.bwc-favorites :is(.fav-list-header-filter__left, .fav-list-header-filter__right) {
  min-width: 0; max-width: 100%;
}
html.bwc-favorites .fav-list-header-filter__search { max-width: 100%; }
html.bwc-favorites .radio-filter { display: flex; gap: 14px; flex-wrap: wrap; }
html.bwc-favorites .radio-filter__item { color: #85858e !important; font-size: 12px; }
html.bwc-favorites .radio-filter__item--active {
  color: #75beff !important; background: #37373d !important; border-color: #454549 !important;
}
html.bwc-favorites .items {
  display: block !important; width: 100% !important; margin: 0 !important;
  padding: 0 !important; counter-reset: bwc-library-record;
}
html.bwc-favorites .items__item {
  width: 100% !important; margin: 0 !important; padding: 14px 0 !important;
  border-bottom: 1px solid #303034; height: auto !important;
}
html.bwc-watchlater .watchlater-list {
  width: min(1000px, calc(100% - 40px)) !important; min-width: 0 !important;
  margin: 0 auto !important; padding: 18px 0 0 !important;
  background: transparent !important;
}
html.bwc-watchlater .watchlater-list-slim {
  width: 100% !important; min-width: 0 !important; margin: 0 !important;
}
html.bwc-watchlater .watchlater-list-title {
  position: static !important; display: flex; flex-wrap: wrap;
  height: auto !important; padding: 0 0 14px !important; gap: 12px;
  color: #9cdcfe !important; background: transparent !important;
  border-bottom: 1px solid #303034;
}
html.bwc-watchlater .watchlater-list-title-left { font-size: 16px !important; }
html.bwc-watchlater .watchlater-list-title-left > svg { width: 20px; height: 20px; }
html.bwc-watchlater .watchlater-list-title__count { font-size: 12px; color: #85858e !important; }
html.bwc-watchlater .watchlater-list-nav {
  position: static !important; width: 100% !important; min-width: 0 !important;
  height: auto !important; padding: 10px 0 !important; margin: 0 !important;
  background: #1f1f1f !important;
}
html.bwc-watchlater :is(.breadcrums-nav, .list-header, .list-header-main) {
  min-width: 0 !important; width: 100% !important; height: auto !important;
  max-width: none !important; padding: 0 !important; margin: 0 !important;
  background: transparent !important;
}
html.bwc-watchlater .list-header-main {
  display: flex !important; flex-direction: row !important; flex-wrap: wrap; align-items: center;
  justify-content: space-between; gap: 10px;
}
html.bwc-watchlater :is(.list-header-filter, .list-header-options) {
  display: flex; flex-wrap: wrap; min-width: 0; width: auto !important;
  max-width: 100%; gap: 10px;
}
html.bwc-watchlater .list-header-filter__btn { color: #85858e !important; }
html.bwc-watchlater .list-header-filter__btn.active {
  color: #75beff !important; background: #37373d !important;
}
html.bwc-watchlater .watchlater-list-container {
  display: block !important; width: 100% !important; gap: 0 !important;
  margin: 0 !important; padding: 0 !important;
}
html.bwc-watchlater .video-card {
  width: 100% !important; height: auto !important; min-width: 0 !important;
  margin: 0 !important; padding: 14px 0 !important;
  border-bottom: 1px solid #303034; background: transparent !important;
}
html.bwc-watchlater .video-card:has(.bili-video-card) { display: block !important; }
html.bwc-watchlater .video-card:has(.bili-video-card) .video-card__left {
  width: 100% !important; height: auto !important; flex: 1;
}
html.bwc-watchlater .video-card:has(.bili-video-card) .video-card__right { display: none !important; }
html.bwc-watchlater .video-card:not(:has(.bili-video-card)) {
  display: grid !important; grid-template-columns: 144px minmax(0, 1fr); gap: 16px;
}
html.bwc-watchlater .video-card:not(:has(.bili-video-card)) .video-card__left {
  width: 144px !important; height: 86px !important; min-width: 0 !important;
}
html.bwc-watchlater .video-card:not(:has(.bili-video-card)) .video-card__right {
  display: block !important; min-width: 0 !important; padding: 0 !important;
}
html:is(.bwc-favorites, .bwc-watchlater) .bili-video-card {
  width: 100% !important; min-width: 0 !important; height: auto !important;
  background: transparent !important;
}
html:is(.bwc-favorites, .bwc-watchlater) .bili-video-card__wrap {
  display: flex !important; flex-direction: row !important; align-items: flex-start !important;
  gap: 16px; width: 100% !important; min-width: 0 !important;
}
html:is(.bwc-favorites, .bwc-watchlater) .bili-video-card__cover {
  flex: 0 0 144px; width: 144px !important; height: 86px !important;
  min-height: 0 !important; max-height: 86px !important;
  padding: 0 !important; border-radius: 4px; overflow: hidden;
}
html:is(.bwc-favorites, .bwc-watchlater) :is(.bili-cover-card, .bili-cover-card__thumbnail) {
  display: block; width: 100% !important; height: 100% !important;
  padding: 0 !important; min-height: 0 !important;
}
html:is(.bwc-favorites, .bwc-watchlater) .bili-cover-card__thumbnail img {
  width: 100% !important; height: 100% !important; object-fit: cover;
}
html:is(.bwc-favorites, .bwc-watchlater) .bili-video-card__details {
  flex: 1; min-width: 0 !important; width: auto !important; padding: 2px 0 0 !important;
}
html:is(.bwc-favorites, .bwc-watchlater) :is(.bili-video-card__title, .video-card__right > .title) {
  height: auto !important; margin: 0 0 8px !important;
  font-size: 14px !important; line-height: 23px !important;
  color: #ce9178 !important; -webkit-line-clamp: 2; overflow-wrap: anywhere;
}
html:is(.bwc-favorites, .bwc-watchlater) .bili-video-card__title a {
  color: #ce9178 !important;
}
html:is(.bwc-favorites, .bwc-watchlater) :is(
  .bili-video-card__subtitle, .bili-video-card__author, .bili-video-card__text,
  .video-card__stats, .video-card__stats a, .vui_pagination, .vui_pagenation, .watchlater-list-empty
) { color: #85858e !important; font-size: 12px; }
html:is(.bwc-favorites, .bwc-watchlater) :is(
  .vui_button, .vui_input-wrapper, .search-bar, .search-bar-input,
  .vui_pagination button, .vui_pagination input, .vui_pagenation button, .vui_pagenation input
) {
  color: #d4d4d4 !important; background: #252526 !important;
  border-color: #454549 !important; border-radius: 3px;
}
html:is(.bwc-favorites, .bwc-watchlater) input {
  color: #d4d4d4 !important; background: transparent !important;
}
html:is(.bwc-favorites, .bwc-watchlater) :is(
  .vui_popover, .vui_popover-content, .vui_dropdown-menu, .menu-popover-content
) { color: #d4d4d4 !important; background: #252526 !important; border-color: #454549 !important; }
html.bwc-watchlater .video-skeleton-card { max-height: 100px; }
html.bwc-favorites :is(.vui_pagination, .vui_pagenation) {
  display: flex; flex-wrap: wrap; max-width: 100%; gap: 10px;
  margin-top: 18px !important;
}
html.bwc-favorites .vui_pagenation--btns { flex-wrap: wrap; max-width: 100%; }
html.bwc-favorites .vui_pagenation .vui_button--active {
  background: #37373d !important; color: #75beff !important;
}
@media (max-width: 760px) {
  html.bwc-favorites .space-favlist { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  html.bwc-favorites .favlist-aside {
    position: static !important; width: 100% !important; max-height: 200px;
    border-right: 0; border-bottom: 1px solid #303034; padding-bottom: 10px !important;
  }
}
/* Native followed-stream list: retain Vue pagination and room click handlers. */
html.bwc-following #live-center-app {
  min-width: 0 !important; background: #1f1f1f !important; color: #d4d4d4 !important;
}
html.bwc-following .app-ctnr { min-width: 0 !important; background: transparent !important; }
html.bwc-following .app-ctnr > :is(.link-navbar-wrap, .link-footer) { display: none !important; }
html.bwc-following .app-body {
  min-width: 0 !important; width: min(900px, calc(100% - 40px)) !important;
  margin: 0 auto !important; padding: 16px 0 0 !important; background: transparent !important;
}
html.bwc-following .app-body > nav.side-bar { display: none !important; }
html.bwc-following .app-body .main-ctnr {
  width: 100% !important; float: none !important; padding: 0 !important;
  border: 0 !important; background: transparent !important;
}
html.bwc-following .page-title {
  padding: 0 0 14px !important; margin: 0 !important; height: auto !important;
  border-bottom: 1px solid #303034; color: #9cdcfe !important;
  font: 14px/26px "Segoe UI", "Microsoft YaHei", sans-serif !important;
}
html.bwc-following .page-title::before { content: "// "; color: #6a9955; }
html.bwc-following .page-title :is(.liveCount,.live-person) { font-size: 12px !important; color: #85858e !important; }
html.bwc-following :is(.my-favourite,.section-block,.card-ctnr,.favourite-cards) {
  width: 100% !important; min-height: 0 !important; height: auto !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important;
  background: transparent !important; box-shadow: none !important;
}
html.bwc-following .a-move-in-left { animation: none !important; transform: none !important; }
html.bwc-following .favourite-card {
  display: flex !important; align-items: flex-start; gap: 16px;
  width: 100% !important; min-height: 114px; height: auto !important; box-sizing: border-box;
  padding: 16px 0 !important; margin: 0 !important;
  border: 0 !important; border-bottom: 1px solid #303034 !important;
  border-radius: 0 !important; background: transparent !important; box-shadow: none !important;
}
html.bwc-following .favourite-card .avatar {
  flex: 0 0 44px; width: 44px !important; height: 44px !important; margin: 0 !important;
}
html.bwc-following .favourite-card :is(.avatar-pic,.anchor-avatar) {
  width: 40px !important; height: 40px !important; border-color: #454549 !important;
}
html.bwc-following .favourite-card :is(.spot-mark,.gif-icon,.blue-playback) { display: none !important; }
html.bwc-following .favourite-card .pink-live {
  top: 34px !important; left: 0 !important; width: 42px !important; height: 16px !important;
  background: #25332a !important; border: 0 !important; border-radius: 2px !important;
}
html.bwc-following .favourite-card .live-text,
html.bwc-following .favourite-card .live-text span { color: #89d185 !important; font-size: 10px !important; }
html.bwc-following .favourite-card .anchor-info {
  position: static !important; display: grid !important;
  grid-template-columns: minmax(0, 1fr) 144px; grid-template-rows: auto 1fr;
  column-gap: 16px; flex: 1; min-width: 0; width: auto !important; height: auto !important;
}
html.bwc-following .favourite-card .anchor { grid-column: 1; grid-row: 1; min-width: 0; }
html.bwc-following .favourite-card .anchor-name {
  color: #9cdcfe !important; font: 13px/24px "Segoe UI", "Microsoft YaHei", sans-serif !important;
}
html.bwc-following .favourite-card a.title {
  grid-column: 1; grid-row: 2; width: auto !important; height: auto !important;
  color: #ce9178 !important; white-space: normal !important;
  font: 14px/24px "Segoe UI", "Microsoft YaHei", sans-serif !important;
}
html.bwc-following .favourite-card .live-detail {
  grid-column: 2; grid-row: 1 / span 2; width: 144px !important; height: 81px !important;
}
html.bwc-following .favourite-card .live-detail .cover { width: 100% !important; height: 100% !important; object-fit: cover; }
html.bwc-following .favourite-card .block-views {
  display: flex !important; align-items: center; justify-content: space-between;
  gap: 6px; left: 6px !important; right: 6px !important; font-size: 10px !important;
}
html.bwc-following .favourite-card .block-views .block {
  min-width: 0; max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
html.bwc-following .favourite-card .block-views .views {
  display: flex; flex-shrink: 0; align-items: center; gap: 3px; white-space: nowrap;
}
html.bwc-following .favourite-card .views img { width: 10px !important; height: 10px !important; }
html.bwc-following .link-panigation-ctnr { margin: 16px 0 !important; text-align: center; }
html.bwc-following .link-panigation .panigation,
html.bwc-following .jumping-input {
  background: #252526 !important; color: #b5b5bd !important; border-color: #454549 !important;
}
html.bwc-following .link-panigation .panigation.selected { background: #094771 !important; color: #fff !important; }
html.bwc-following .jumping-ctnr { color: #85858e !important; }
html.bwc-following .empty-hint-ctnr { position: relative !important; min-height: 250px; color: #85858e; }
html.bwc-active :is(.bili-dyn-home--member, .bili-dyn-home) {
  display: block !important; min-width: 0 !important;
  width: min(780px, calc(100% - 40px)) !important;
  margin: 0 auto !important; padding: 16px 0 0 !important;
}
html.bwc-active .bili-dyn-home--member > aside,
html.bwc-active .bili-dyn-home > aside,
html.bwc-active #app > :is(.bg, .bgc),
html.bwc-active .bili-dyn-publishing,
html.bwc-active main > section:has(> .bili-dyn-up-list) { display: none !important; }
html.bwc-active .bili-dyn-home--member > main,
html.bwc-active .bili-dyn-home > main {
  display: block !important; width: 100% !important; min-width: 0 !important;
  margin: 0 !important; padding: 0 !important; float: none !important;
}
html.bwc-active main > section { margin: 0 !important; }
html.bwc-active .bili-dyn-list-tabs {
  position: relative !important; top: auto !important; margin: 0 0 10px !important;
  border-bottom: 1px solid #363639; background: transparent !important;
  box-shadow: none !important; border-radius: 0 !important;
}
html.bwc-active .bili-dyn-list__items { counter-reset: bwc-record; }
html.bwc-active .bili-dyn-list__item { margin-bottom: 0 !important; }
html.bwc-active .bili-dyn-item {
  border: 0 !important; border-bottom: 1px solid #303034 !important;
  border-radius: 0 !important; margin: 0 !important; padding: 18px 0 !important;
  background: transparent !important; box-shadow: none !important;
  color: #d4d4d4; counter-increment: bwc-record;
}
html.bwc-active .bili-dyn-item__main {
  margin: 0 !important; padding: 0 0 0 46px !important; position: relative;
}
html.bwc-active .bili-dyn-item__main::before {
  content: counter(bwc-record, decimal-leading-zero);
  position: absolute; top: 2px; left: 4px; color: #61616b;
  font: 12px/22px Consolas, monospace;
}
html.bwc-active .bili-dyn-item__avatar { display: none !important; }
html.bwc-active .bili-dyn-item__header {
  min-height: 0 !important; margin: 0 0 10px !important; padding: 0 !important;
}
html.bwc-active .bili-dyn-title__text {
  color: #9cdcfe !important; font: 13px/22px "Segoe UI", "Microsoft YaHei", sans-serif;
}
html.bwc-active .bili-dyn-title__text::before { content: "// "; color: #6a9955; }
html.bwc-active .bili-dyn-item__desc { display: inline-block; margin-top: 1px; }
html.bwc-active .bili-dyn-time { color: #85858e !important; font-size: 11px !important; }
html.bwc-active .bili-dyn-item__body { margin: 0 !important; }
html.bwc-active .bili-rich-text {
  font: 14px/1.8 "Segoe UI", "Microsoft YaHei", sans-serif !important;
  color: #d4d4d4 !important;
}
html.bwc-active .bili-rich-text__content { line-height: 1.8 !important; }
html.bwc-active .bili-dyn-content__orig__desc { margin-bottom: 10px !important; }
html.bwc-active .bili-dyn-card-video {
  display: flex !important; align-items: stretch; width: 100% !important;
  height: auto !important; min-height: 86px; border: 1px solid #363639 !important;
  background: #252526 !important; border-radius: 4px !important; overflow: hidden;
}
html.bwc-active .bili-dyn-card-video__header {
  width: 144px !important; height: 86px !important; min-width: 144px; flex: 0 0 144px;
}
html.bwc-active .bili-dyn-card-video__cover { width: 100% !important; height: 100% !important; }
html.bwc-active .bili-dyn-card-video__body {
  width: auto !important; min-width: 0; padding: 10px 14px !important;
  display: flex; flex-direction: column; justify-content: center;
}
html.bwc-active .bili-dyn-card-video__title {
  font-size: 13px !important; color: #ce9178 !important; line-height: 1.6 !important;
}
html.bwc-active .bili-dyn-card-video__desc { font-size: 11px !important; color: #9999a2 !important; }
html.bwc-active .bili-dyn-card-video__stat { color: #85858e !important; font-size: 11px !important; }
html.bwc-active :is(.bili-dyn-content__orig.reference, .bili-dyn-content__forw) {
  background: #252526 !important; border-left: 2px solid #454549; border-radius: 0 !important;
}
html.bwc-active .bili-dyn-item__footer {
  margin-top: 12px !important; border-top: 0 !important; color: #9999a2;
}
html.bwc-active .bili-dyn-action { font-size: 12px !important; }
html.bwc-active .bili-dyn-item__panel {
  background: #1f1f1f !important; border-top: 1px solid #363639; margin-top: 12px;
}
html.bwc-active .bili-album { max-width: 520px; }
html.bwc-active .bili-album__preview__picture { max-height: 220px; }
html.bwc-active :is(.bb-comment, .bili-comment, .comment-container) {
  background: #1f1f1f !important; color: #d4d4d4 !important;
}
html.bwc-active :is(.bb-comment, .bili-comment) :is(.text, .reply-content, .reply-item) {
  color: #d4d4d4 !important;
}
html.bwc-active.bwc-video #mirror-vdcon {
  display: block !important; width: min(780px, calc(100% - 40px)) !important;
  min-width: 0 !important; margin: 0 auto !important; padding: 18px 0 0 !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded),
html.bwc-active.bwc-video:not(.bwc-expanded) body { overflow: hidden !important; }
html.bwc-active.bwc-video:not(.bwc-expanded) body {
  box-sizing: border-box !important; height: 100dvh !important;
  padding-bottom: 24px !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #app { height: 100% !important; }
html.bwc-active.bwc-video:not(.bwc-expanded) #mirror-vdcon {
  box-sizing: border-box !important; height: 100% !important;
}
html.bwc-active.bwc-video #mirror-vdcon > .right-container,
html.bwc-active.bwc-video #mirror-vdcon > .left-container > :is(
  .video-toolbar-container, .video-desc-container, .video-tag-container,
  .ad-report, .video-resource-list
) { display: none !important; }
html.bwc-active.bwc-video #mirror-vdcon > .left-container {
  width: 100% !important; min-width: 0 !important; padding: 0 !important;
  margin: 0 !important; position: static !important; float: none !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #mirror-vdcon > .left-container {
  display: flex !important; flex-direction: column !important;
  height: 100% !important; min-height: 0 !important; overflow: hidden !important;
}
html.bwc-active.bwc-video .video-info-container {
  height: auto !important; min-height: 0 !important; padding: 0 0 16px !important;
  margin: 0 !important; color: #d4d4d4; flex: 0 0 auto;
}
html.bwc-active.bwc-video :is(.video-info-title, .video-info-title-inner) {
  height: auto !important; padding: 0 !important; margin: 0 !important;
}
html.bwc-active.bwc-video .video-title {
  color: #ce9178 !important; font: 15px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif !important;
  white-space: normal !important; height: auto !important; overflow: visible !important;
  padding: 0 !important; margin: 0 !important; text-indent: 0 !important;
}
html.bwc-active.bwc-video .video-title::before { content: "// "; color: #6a9955; }
html.bwc-active.bwc-video :is(.video-info-meta, .video-info-detail-list) {
  color: #85858e !important; font-size: 11px !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #playerWrap {
  position: relative !important; width: 100% !important;
  max-width: min(var(--bwc-player-width), max(280px, calc((100dvh - 440px) * 16 / 9))) !important;
  min-width: 0 !important; flex: 0 0 auto;
  height: calc(var(--bwc-video-height) + 46px) !important;
  margin: 0 auto 8px !important; padding: 0 !important;
  box-shadow: 0 0 0 1px #363639; border-radius: 3px; scroll-margin-top: 116px;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player {
  position: relative !important; inset: auto !important; width: 100% !important;
  height: 100% !important; min-width: 0 !important; max-width: none !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player-placeholder {
  display: none !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-docker-major {
  width: 100% !important; height: 100% !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded)
.bpx-player-container:not([data-screen="web"],[data-screen="full"]) {
  position: relative !important; inset: auto !important; transform: none !important;
  min-width: 0 !important; max-width: none !important;
  min-height: 0 !important; max-height: none !important;
  margin: 0 !important; z-index: 0 !important;
  width: 100% !important; height: 100% !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded)
.bpx-player-container:not([data-screen="web"],[data-screen="full"])
.bpx-player-primary-area { width: 100% !important; height: 100% !important; }
html.bwc-active.bwc-video:not(.bwc-expanded)
.bpx-player-container:not([data-screen="web"],[data-screen="full"])
:is(.bpx-player-video-area, .bpx-player-video-perch, .bpx-player-video-wrap) {
  width: 100% !important; height: var(--bwc-video-height) !important;
  min-width: 0 !important; max-width: none !important;
  min-height: 0 !important; max-height: none !important;
}
/* A site/plugin may keep the native mode flag at "mini". Constrain its
   presentation without changing stored plugin preferences or playback state. */
html.bwc-active.bwc-video:not(.bwc-expanded)
.bpx-player-container[data-screen="mini"] .bpx-player-mini-warp { display: none !important; }
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-player-control-wrap {
  display: block !important; visibility: visible !important;
  opacity: 1 !important; pointer-events: auto !important;
  position: absolute !important; inset: auto 0 0 !important;
  width: 100% !important; height: 64px !important; z-index: 20 !important;
  background: linear-gradient(transparent, rgba(0,0,0,.65));
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-player-control-entity {
  display: block !important; position: relative !important;
  visibility: visible !important; opacity: 1 !important;
  width: 100% !important; height: 100% !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-player-control-top {
  display: block !important; position: absolute !important;
  left: 0 !important; right: 0 !important; bottom: 36px !important;
  height: 20px !important; padding: 0 12px !important;
  opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
  box-sizing: border-box !important; transform: none !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-player-control-bottom {
  display: flex !important; position: absolute !important;
  bottom: 0 !important; left: 0 !important; right: 0 !important;
  height: 35px !important; margin: 0 !important;
  opacity: 1 !important; visibility: visible !important; transform: none !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-player-progress-area {
  display: block !important; width: 100% !important; height: 20px !important;
  opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-player-progress-wrap {
  box-sizing: border-box !important; width: 100% !important; height: 20px !important;
  visibility: visible !important; pointer-events: auto !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #bilibili-player .bpx-player-shadow-progress-area {
  display: none !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) .bpx-player-sending-area {
  display: block !important; height: 46px !important;
  background: #252526 !important; color: #aaaab2 !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) .bpx-player-sending-bar {
  background: #252526 !important; color: #aaaab2 !important; padding: 0 10px !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) .bpx-player-dm-switch {
  display: flex !important; visibility: visible !important;
}
html.bwc-active.bwc-video:not(.bwc-expanded) .bpx-player-dm-input {
  color: #d4d4d4 !important; background: #303034 !important;
}
html.bwc-active.bwc-small-player:not(.bwc-expanded) #bilibili-player :is(
  .bpx-player-ctrl-quality, .bpx-player-ctrl-subtitle, .bpx-player-ctrl-wide
) { display: none !important; }
html.bwc-active.bwc-video #commentapp {
  display: block !important; width: 100% !important; min-width: 0 !important;
  margin-top: 0 !important; padding-top: 8px !important;
  border-top: 1px solid #363639; scroll-margin-top: 106px;
}
html.bwc-active.bwc-video:not(.bwc-expanded) #commentapp {
  box-sizing: border-box; flex: 1 1 0 !important; min-height: 0 !important;
  overflow-y: auto !important; overflow-x: hidden !important;
  overscroll-behavior: contain; padding-right: 12px;
  scrollbar-color: #55555d #1f1f1f; scrollbar-width: thin;
}
html.bwc-active.bwc-video #commentapp::before {
  content: "COMMENTS"; display: block; color: #9999a2; font-size: 11px;
  letter-spacing: 1px; margin: 0 0 8px;
}
/* Live rooms retain their original media, chat socket, controls and scroll list. */
html.bwc-live:not(.bwc-expanded),
html.bwc-live:not(.bwc-expanded) body {
  overflow: hidden !important; min-width: 0 !important;
}
html.bwc-live:not(.bwc-expanded) body {
  box-sizing: border-box !important; height: 100dvh !important; padding-bottom: 24px !important;
}
html.bwc-live:not(.bwc-expanded) .live-room-app {
  height: 100% !important; min-width: 0 !important; width: 100% !important;
  background: #1f1f1f !important; color: #d4d4d4 !important;
  --brand-color: #75beff; --text-color: #d4d4d4;
}
html.bwc-live:not(.bwc-expanded) .app-content,
html.bwc-live:not(.bwc-expanded) .app-content > .app-body {
  position: relative !important; width: 100% !important; height: 100% !important;
  min-width: 0 !important; min-height: 0 !important; max-width: none !important;
  margin: 0 !important; padding: 0 !important; background: transparent !important;
}
html.bwc-live:not(.bwc-expanded) :is(
  #room-ssr-vm, #sections-vm, #sidebar-vm, .link-footer, .chat-panel-fit-dragger,
  .container-tool-paddingbox, #gift-control-vm, #live-charge-vm, #limit-boomman,
  #player-effect-vm, #shop-popover-vm, #cloud-game
) { display: none !important; }
html.bwc-live:not(.bwc-expanded) .player-and-aside-area {
  box-sizing: border-box !important; width: min(780px, calc(100% - 40px)) !important;
  min-width: 0 !important; height: 100% !important; min-height: 0 !important;
  display: flex !important; flex-direction: column !important; gap: 8px;
  margin: 0 auto !important; padding: 18px 0 0 !important;
}
html.bwc-live:not(.bwc-expanded) #player-ctnr {
  flex: 0 0 auto; position: relative !important; inset: auto !important;
  width: 100% !important; height: auto !important; min-width: 0 !important;
  margin: 0 !important; padding: 0 !important; float: none !important;
}
html.bwc-live:not(.bwc-expanded) #head-info-vm {
  box-sizing: border-box !important; position: relative !important;
  display: flex !important; align-items: center; width: 100% !important;
  height: auto !important; min-height: 40px !important; padding: 0 0 16px !important;
  background: transparent !important; border: 0 !important;
}
html.bwc-live:not(.bwc-expanded) #head-info-vm > :not(.rows-ctnr),
html.bwc-live:not(.bwc-expanded) #head-info-vm .normal-row-ctnr > :not(.left-anchor-section),
html.bwc-live:not(.bwc-expanded) #head-info-vm :is(
  .follow-ctnr, .heat-index-scroll-wrapper, .lower-row, .right-section, .right-dynamic-modules
) { display: none !important; }
html.bwc-live:not(.bwc-expanded) #head-info-vm :is(
  .rows-ctnr, .normal-row-ctnr, .left-anchor-section, .left-anchor-section .content
) {
  position: static !important; width: 100% !important; height: auto !important;
  min-width: 0 !important; margin: 0 !important; padding: 0 !important;
}
html.bwc-live:not(.bwc-expanded) #head-info-vm :is(.room-title, .room-owner-username) {
  color: #ce9178 !important; font: 15px/24px "Segoe UI", "Microsoft YaHei", sans-serif !important;
}
html.bwc-live:not(.bwc-expanded) #head-info-vm .room-owner-username::before {
  content: "// "; color: #6a9955;
}
html.bwc-live:not(.bwc-expanded) #player-ctnr .fullscreen-container-paddingbox,
html.bwc-live:not(.bwc-expanded) #fullscreen-container {
  position: relative !important; inset: auto !important; display: block !important;
  width: 100% !important; height: auto !important; margin: 0 !important;
  padding: 0 !important; background: transparent !important; overflow: visible !important;
}
html.bwc-live:not(.bwc-expanded) #player-ctnr .player-section {
  position: relative !important; inset: auto !important; width: 100% !important;
  min-width: 0 !important; height: var(--bwc-video-height) !important;
  max-width: min(var(--bwc-player-width), max(280px, calc((100dvh - 440px) * 16 / 9))) !important;
  margin: 0 auto !important; padding: 0 !important; flex: 0 0 auto;
  box-shadow: 0 0 0 1px #363639; border-radius: 3px; overflow: hidden;
}
html.bwc-live:not(.bwc-expanded) #live-player-ctnr,
html.bwc-live:not(.bwc-expanded) #live-player-ctnr > div,
html.bwc-live:not(.bwc-expanded) #live-player {
  position: relative !important; inset: auto !important; transform: none !important;
  width: 100% !important; height: 100% !important;
  min-width: 0 !important; min-height: 0 !important; max-width: none !important;
}
html.bwc-live:not(.bwc-expanded) #live-player > video {
  width: 100% !important; height: 100% !important; object-fit: contain !important;
}
html.bwc-live:not(.bwc-expanded) #aside-area-vm {
  box-sizing: border-box !important; position: relative !important; inset: auto !important;
  display: flex !important; flex-direction: column !important; flex: 1 1 0 !important;
  width: 100% !important; height: auto !important; min-width: 0 !important; min-height: 0 !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important;
  background: #1f1f1f !important; overflow: hidden !important;
}
html.bwc-live:not(.bwc-expanded) #aside-area-vm::before {
  content: "STREAM OUTPUT"; display: block; flex: 0 0 auto;
  color: #9999a2; font: 11px/24px Consolas, monospace; letter-spacing: 1px; padding-bottom: 8px;
}
html.bwc-live:not(.bwc-expanded) #aside-area-vm > :not(.chat-history-panel, #chat-control-panel-vm) {
  display: none !important;
}
html.bwc-live:not(.bwc-expanded) .chat-history-panel {
  flex: 1 1 0 !important; width: 100% !important; height: auto !important;
  min-height: 0 !important; margin: 0 !important; padding: 0 !important;
  background: transparent !important; overflow: hidden !important;
}
html.bwc-live:not(.bwc-expanded) #chat-history-list {
  box-sizing: border-box !important; height: 100% !important; min-height: 0 !important;
  width: 100% !important; padding: 0 12px 0 0 !important;
  overflow-y: auto !important; overflow-x: hidden !important;
  overscroll-behavior: contain; scrollbar-color: #55555d #1f1f1f; scrollbar-width: thin;
}
html.bwc-live:not(.bwc-expanded) #chat-items {
  width: 100% !important; margin: 0 !important; padding: 0 !important;
}
html.bwc-live:not(.bwc-expanded) #chat-items .chat-item {
  box-sizing: border-box !important; width: 100% !important;
  padding: 8px 0 !important; border-bottom: 1px solid #29292d;
  color: #d4d4d4 !important; background: transparent !important;
  font: 13px/22px "Segoe UI", "Microsoft YaHei", sans-serif !important;
}
html.bwc-live:not(.bwc-expanded) #chat-items .user-name { color: #9cdcfe !important; }
html.bwc-live:not(.bwc-expanded) #chat-items :is(.danmaku-item-left, .danmaku-item-right) {
  height: auto !important; color: inherit; white-space: normal !important; overflow-wrap: anywhere;
}
html.bwc-live:not(.bwc-expanded) #chat-items :is(
  .fans-medal-item-ctnr, .guard-icon, .user-level-icon, .wealth-medal-ctnr
) { display: none !important; }
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm {
  flex: 0 0 auto; width: 100% !important; height: auto !important; padding: 8px 0 !important;
  background: #1f1f1f !important; border-top: 1px solid #363639;
}
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm :is(
  .control-panel-ctnr, .chat-input-ctnr, .send-btn-wrapper
) { background: #252526 !important; color: #d4d4d4 !important; }
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm :is(.medal-section, .recharge-btn) {
  display: none !important;
}
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm .chat-input {
  color: #d4d4d4 !important; background: #252526 !important; min-width: 0 !important;
}
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm .chat-input-ctnr {
  box-sizing: border-box !important; display: flex !important; align-items: center;
  height: 42px !important; width: 100% !important; border: 1px solid #454549; border-radius: 3px;
}
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm .chat-input-area {
  flex: 1; min-width: 0 !important; height: 100% !important;
}
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm .chat-input {
  box-sizing: border-box !important; width: 100% !important; height: 100% !important;
  padding: 8px !important; border: 0 !important; resize: none !important;
  font: 13px/22px "Segoe UI", "Microsoft YaHei", sans-serif !important;
}
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm .send-btn-wrapper { flex: 0 0 auto; }
html.bwc-live:not(.bwc-expanded) #chat-control-panel-vm .send-btn {
  height: 34px !important; margin: 0 4px !important; padding: 0 14px !important;
  background: #0e639c !important; color: #fff !important; border-color: #0e639c !important;
}
html.bwc-active bili-comments {
  display: block !important; min-width: 0 !important; width: 100% !important;
}
html.bwc-active.bwc-expanded #bwc-shell { display: none !important; }
@media (min-width: 1000px) {
  html.bwc-live.bwc-layout-split:not(.bwc-expanded) .player-and-aside-area {
    width: min(1440px, calc(100% - 48px)) !important;
    display: grid !important; grid-template-columns: minmax(0, 1.15fr) minmax(320px, 1fr);
    grid-template-rows: minmax(0, 1fr); gap: 24px; align-items: start;
  }
  html.bwc-live.bwc-layout-split:not(.bwc-expanded) #player-ctnr {
    grid-column: 1; grid-row: 1;
  }
  html.bwc-live.bwc-layout-split:not(.bwc-expanded) #player-ctnr .player-section {
    max-width: min(var(--bwc-player-width), max(280px, calc((100dvh - 260px) * 16 / 9))) !important;
  }
  html.bwc-live.bwc-layout-split:not(.bwc-expanded) #aside-area-vm {
    grid-column: 2; grid-row: 1; height: 100% !important; align-self: stretch;
    border-left: 1px solid #363639 !important; padding: 0 12px 0 20px !important;
  }
  html.bwc-active.bwc-video.bwc-layout-split:not(.bwc-expanded) #mirror-vdcon {
    width: min(1440px, calc(100% - 48px)) !important;
  }
  html.bwc-active.bwc-video.bwc-layout-split:not(.bwc-expanded) #mirror-vdcon > .left-container {
    display: grid !important;
    grid-template-columns: minmax(0, 1.15fr) minmax(320px, 1fr);
    grid-template-rows: auto minmax(0, 1fr); column-gap: 24px;
    align-items: start;
  }
  html.bwc-active.bwc-video.bwc-layout-split:not(.bwc-expanded) .video-info-container {
    grid-column: 1; grid-row: 1;
  }
  html.bwc-active.bwc-video.bwc-layout-split:not(.bwc-expanded) #playerWrap {
    grid-column: 1; grid-row: 2; align-self: start;
    max-width: min(var(--bwc-player-width), max(280px, calc((100dvh - 260px) * 16 / 9))) !important;
    margin: 0 auto !important;
  }
  html.bwc-active.bwc-video.bwc-layout-split:not(.bwc-expanded) #commentapp {
    grid-column: 2; grid-row: 1 / 3; height: 100% !important;
    border-top: 0 !important; border-left: 1px solid #363639;
    padding: 0 12px 0 20px !important;
  }
}
@media (max-width: 1100px) {
  html.bwc-active { --bwc-tree: 0px; }
  .bwc-explorer { display: none !important; }
  #bwc-shell .bwc-source-shortcut { display: grid; }
}
@media (max-width: 600px) {
  html.bwc-active { --bwc-rail: 36px; }
  .bwc-menutext { display: none; }
  .bwc-titlebar { gap: 8px; }
  .bwc-windowtitle { flex: 1; width: auto; }
  html.bwc-active .bili-dyn-home--member,
  html.bwc-active .bili-dyn-home,
  html.bwc-active.bwc-video #mirror-vdcon { width: calc(100% - 24px) !important; }
  html.bwc-active .bili-dyn-item__main { padding-left: 30px !important; }
  html.bwc-active .bili-dyn-card-video__header {
    min-width: 100px; width: 100px !important; height: 72px !important; flex-basis: 100px;
  }
  html.bwc-active .bili-dyn-card-video__body { padding: 7px 9px !important; }
  html.bwc-active .bili-dyn-card-video__desc { display: none; }
  html.bwc-active.bwc-video:not(.bwc-expanded) .bpx-player-video-info { display: none !important; }
  .bwc-status { gap: 12px; }
  .bwc-tab { padding-inline: 10px; }
  .bwc-view-tools { gap: 4px; margin-right: 6px; }
  #bwc-shell :is(.bwc-size,.bwc-layout) { padding-inline: 3px; }
  #bwc-shell .bwc-workspace-file > .bwc-tab { max-width: 150px; }
  html.bwc-home .recommended-container_floor-aside :is(.bili-video-card__image--link, .bili-live-card__image--link) {
    flex-basis: 112px; width: 112px !important; height: 70px !important;
  }
  html.bwc-home .recommended-container_floor-aside :is(
    .bili-video-card__image,.bili-video-card__image--wrap,.bili-live-card__image
  ) {
    height: 70px !important;
  }
  html.bwc-following .favourite-card .avatar { display: none !important; }
  html.bwc-following .favourite-card .anchor-info {
    grid-template-columns: minmax(0, 1fr) 112px; column-gap: 12px;
  }
  html.bwc-following .favourite-card .live-detail { width: 112px !important; height: 70px !important; }
  html.bwc-following .link-panigation-ctnr { white-space: normal !important; }
}
`;
  }
})();
