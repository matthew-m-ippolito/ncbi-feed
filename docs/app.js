(function () {
  'use strict';

  var ARTICLES_URL = 'articles.json';
  var ABSTRACTS_URL = 'abstracts.json';
  var LS = {
    state: 'ncbifeed.v1.state', // { pmid: {read:1, starred:1, readAt:ts} }
    prefs: 'ncbifeed.v1.prefs', // { view, sort }
    meta:  'ncbifeed.v1.meta'   // { seenIds:[...] }
  };
  var PAGE = 30;

  // ---------- defensive storage ----------
  function load(key, fb) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var state = load(LS.state, {});
  var prefs = load(LS.prefs, { view: 'all', sort: 'newest' });
  var meta  = load(LS.meta, { seenIds: [] });

  var allArticles = [];
  var visible = [];
  var rendered = 0;
  var searchTerm = '';
  var abstracts = null, abstractsPromise = null;
  var newIds = {};
  var freshData = null;

  // ---------- DOM ----------
  var feedEl = document.getElementById('feed');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var errorEl = document.getElementById('error');
  var sentinelEl = document.getElementById('sentinel');
  var searchEl = document.getElementById('search');
  var sortBtn = document.getElementById('sort-btn');
  var updatedEl = document.getElementById('updated');
  var newPill = document.getElementById('new-pill');
  var tpl = document.getElementById('card-tpl');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));

  // ---------- helpers ----------
  function stEntry(pmid) { return state[pmid] || (state[pmid] = {}); }
  function isRead(p) { return !!(state[p] && state[p].read); }
  function isStarred(p) { return !!(state[p] && state[p].starred); }
  function persistState() { save(LS.state, state); }

  function parseDate(s) {
    if (!s) return null;
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(s) {
    var d = parseDate(s); if (!d) return '';
    var now = new Date();
    var mon = d.toLocaleString('en-US', { month: 'short' });
    return d.getFullYear() === now.getFullYear()
      ? mon + ' ' + d.getDate()
      : mon + ' ' + d.getFullYear();
  }
  function relTime(s) {
    var d = parseDate(s); if (!d) return '';
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 2) return 'Updated just now';
    if (mins < 60) return 'Updated ' + mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return 'Updated ' + hrs + 'h ago';
    var days = Math.round(hrs / 24);
    if (days < 30) return 'Updated ' + days + 'd ago';
    return 'Updated ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---------- counts ----------
  function updateCounts() {
    var unread = 0, starred = 0;
    for (var i = 0; i < allArticles.length; i++) {
      var p = allArticles[i].id;
      if (!isRead(p)) unread++;
      if (isStarred(p)) starred++;
    }
    setCount('all', allArticles.length);
    setCount('unread', unread);
    setCount('starred', starred);
  }
  function setCount(view, n) {
    var el = document.querySelector('.tab-count[data-count="' + view + '"]');
    if (el) el.textContent = n > 0 ? String(n) : (view === 'all' ? String(n) : '');
  }

  // ---------- filtering ----------
  function matchesView(a) {
    if (prefs.view === 'unread') return !isRead(a.id);
    if (prefs.view === 'starred') return isStarred(a.id);
    return true;
  }
  function matchesSearch(a) {
    if (!searchTerm) return true;
    return (a._hay || '').indexOf(searchTerm) !== -1;
  }
  function applyView() {
    visible = allArticles.filter(function (a) { return matchesView(a) && matchesSearch(a); });
    visible.sort(function (x, y) {
      var dx = x._t, dy = y._t;
      return prefs.sort === 'oldest' ? dx - dy : dy - dx;
    });
    feedEl.innerHTML = '';
    rendered = 0;
    renderMore();
    showEmptyState();
  }
  function showEmptyState() {
    var none = visible.length === 0;
    emptyEl.hidden = !none;
    if (none) {
      if (searchTerm) emptyEl.textContent = 'No headlines match “' + searchEl.value + '”.';
      else if (prefs.view === 'unread') emptyEl.textContent = 'You’re all caught up. 🎉';
      else if (prefs.view === 'starred') emptyEl.textContent = 'Nothing starred yet. Tap ☆ on an article to keep it here.';
      else emptyEl.textContent = 'No articles yet. New papers will appear here.';
    }
  }

  // ---------- rendering ----------
  function renderMore() {
    var frag = document.createDocumentFragment();
    var end = Math.min(rendered + PAGE, visible.length);
    for (var i = rendered; i < end; i++) frag.appendChild(buildCard(visible[i]));
    feedEl.appendChild(frag);
    rendered = end;
  }

  function buildCard(a) {
    var node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.pmid = a.id;
    var main = node.querySelector('.card-main');
    main.href = a.url || ('https://pubmed.ncbi.nlm.nih.gov/' + a.id + '/');
    node.querySelector('.headline').textContent = a.headline || a.title_original || '(untitled)';
    var ot = node.querySelector('.orig-title');
    ot.textContent = a.title_original || '';
    if (!a.title_original || a.title_original === a.headline) ot.style.display = 'none';
    node.querySelector('.journal').textContent = a.journal || '';
    var dt = node.querySelector('.date'); dt.textContent = fmtDate(a.date);
    if (!a.journal || !dt.textContent) node.querySelector('.meta-dot').style.display = 'none';
    var chip = node.querySelector('.source');
    if (a.source) chip.textContent = a.source; else chip.style.display = 'none';

    var abBtn = node.querySelector('.abstract-btn');
    if (!a.has_abstract) abBtn.style.display = 'none';

    if (newIds[a.id]) node.classList.add('is-new');
    paintState(node, a);

    // open PubMed + mark read
    main.addEventListener('click', function () { setRead(a.id, true, node, a); });
    abBtn.addEventListener('click', function () { toggleAbstract(node, a); });
    node.querySelector('.read-btn').addEventListener('click', function () { setRead(a.id, !isRead(a.id), node, a); });
    node.querySelector('.star-btn').addEventListener('click', function () { toggleStar(a.id, node, a); });
    return node;
  }

  function paintState(node, a) {
    var read = isRead(a.id), starred = isStarred(a.id);
    node.classList.toggle('is-read', read);
    var rb = node.querySelector('.read-btn');
    rb.setAttribute('aria-pressed', read ? 'true' : 'false');
    rb.textContent = read ? 'Read ✓' : 'Mark read';
    var sb = node.querySelector('.star-btn');
    sb.setAttribute('aria-pressed', starred ? 'true' : 'false');
    sb.querySelector('.star-ico').textContent = starred ? '★' : '☆';
    sb.querySelector('.star-txt').textContent = starred ? 'Starred' : 'Star';
  }

  // ---------- state mutations ----------
  function setRead(pmid, val, node, a) {
    var e = stEntry(pmid);
    if (val) { e.read = 1; e.readAt = Date.now(); } else { delete e.read; delete e.readAt; }
    persistState();
    afterChange(node, a);
  }
  function toggleStar(pmid, node, a) {
    var e = stEntry(pmid);
    if (e.starred) delete e.starred; else e.starred = 1;
    persistState();
    afterChange(node, a);
  }
  function afterChange(node, a) {
    updateCounts();
    if (node && a) {
      if (!matchesView(a)) removeCard(node);
      else paintState(node, a);
    }
  }
  function removeCard(node) {
    node.style.transition = 'opacity .18s ease, transform .18s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateX(8px)';
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); showEmptyState(); }, 180);
  }

  // ---------- abstracts ----------
  function loadAbstracts() {
    if (abstracts) return Promise.resolve(abstracts);
    if (abstractsPromise) return abstractsPromise;
    abstractsPromise = fetch(ABSTRACTS_URL).then(function (r) {
      if (!r.ok) throw new Error('no abstracts');
      return r.json();
    }).then(function (d) { abstracts = (d && d.abstracts) || {}; return abstracts; })
      .catch(function () { abstracts = {}; return abstracts; });
    return abstractsPromise;
  }
  function toggleAbstract(node, a) {
    var box = node.querySelector('.abstract');
    var btn = node.querySelector('.abstract-btn');
    var expanded = btn.getAttribute('aria-expanded') === 'true';
    if (expanded) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    btn.setAttribute('aria-expanded', 'true');
    box.hidden = false;
    var link = node.querySelector('.fulltext-link');
    link.href = a.url || ('https://pubmed.ncbi.nlm.nih.gov/' + a.id + '/');
    var txt = node.querySelector('.abstract-text');
    if (txt.dataset.loaded) return;
    txt.textContent = 'Loading abstract…';
    txt.classList.add('is-loading');
    loadAbstracts().then(function (map) {
      var ab = map[a.id];
      txt.classList.remove('is-loading');
      txt.textContent = ab || 'No abstract available for this article.';
      txt.dataset.loaded = '1';
    });
  }

  // ---------- ingest + freshness ----------
  function indexArticle(a) {
    a.id = String(a.id || a.pmid || '');
    var d = parseDate(a.date) || parseDate(a.date_added);
    a._t = d ? d.getTime() : 0;
    a._hay = ((a.headline || '') + ' ' + (a.title_original || '') + ' ' +
              (a.journal || '') + ' ' + (a.authors || '')).toLowerCase();
    return a;
  }
  function ingest(data, isFresh) {
    allArticles = (data.articles || []).map(indexArticle);
    updatedEl.textContent = data.generated_at ? relTime(data.generated_at) : '';
    computeNew();
    updateCounts();
    applyView();
    loadingEl.hidden = true;
    errorEl.hidden = true;
  }
  function computeNew() {
    newIds = {};
    var seen = {};
    for (var i = 0; i < meta.seenIds.length; i++) seen[meta.seenIds[i]] = 1;
    if (meta.seenIds.length) {
      for (var j = 0; j < allArticles.length; j++) {
        if (!seen[allArticles[j].id]) newIds[allArticles[j].id] = 1;
      }
    }
    meta.seenIds = allArticles.map(function (a) { return a.id; });
    save(LS.meta, meta);
  }

  function checkForUpdates() {
    fetch(ARTICLES_URL, { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d || !d.articles) return;
      if (d.generated_at && d.generated_at !== currentGenerated) {
        var have = {}; allArticles.forEach(function (a) { have[a.id] = 1; });
        var n = 0; d.articles.forEach(function (a) { if (!have[String(a.id)]) n++; });
        freshData = d;
        newPill.hidden = false;
        newPill.textContent = (n > 0 ? n + ' new article' + (n === 1 ? '' : 's') : 'Feed updated') + ' — tap to load';
      }
    }).catch(function () {});
  }
  var currentGenerated = '';

  // ---------- events ----------
  var searchTimer;
  searchEl.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchTerm = searchEl.value.trim().toLowerCase();
      applyView();
    }, 140);
  });
  sortBtn.addEventListener('click', function () {
    prefs.sort = prefs.sort === 'newest' ? 'oldest' : 'newest';
    sortBtn.textContent = prefs.sort === 'newest' ? 'Newest' : 'Oldest';
    save(LS.prefs, prefs);
    applyView();
  });
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      prefs.view = tab.dataset.view;
      save(LS.prefs, prefs);
      tabs.forEach(function (t) { t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
      window.scrollTo(0, 0);
      applyView();
    });
  });
  newPill.addEventListener('click', function () {
    if (freshData) { currentGenerated = freshData.generated_at; ingest(freshData, true); freshData = null; }
    newPill.hidden = true;
    window.scrollTo(0, 0);
  });
  document.getElementById('retry').addEventListener('click', function () { errorEl.hidden = true; loadingEl.hidden = false; boot(); });

  if (sentinelEl && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && rendered < visible.length) renderMore();
    }, { rootMargin: '600px' }).observe(sentinelEl);
  }

  // restore UI prefs
  sortBtn.textContent = prefs.sort === 'oldest' ? 'Oldest' : 'Newest';
  tabs.forEach(function (t) { t.setAttribute('aria-selected', t.dataset.view === prefs.view ? 'true' : 'false'); });

  // ---------- boot ----------
  function boot() {
    fetch(ARTICLES_URL).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (d) {
      currentGenerated = d.generated_at || '';
      ingest(d, false);
      setTimeout(checkForUpdates, 1500);
    }).catch(function (err) {
      loadingEl.hidden = true;
      if (allArticles.length === 0) { errorEl.hidden = false; }
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }
  boot();
})();
