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
  // your research projects, alphabetical (used for the manual tag editor)
  var PROJECTS = ['CHASM', 'CV', 'Drug Resistance', 'Drugs', 'Forecasting',
    'Genomics', 'ICEMR', 'IMPRINT', 'MACEPA', 'MARSHAL', 'PDMC', 'PharCide', 'PK/PD',
    'PLATFORM', 'Review', 'Serology', 'VSA', 'Other'];

  // ---------- defensive storage ----------
  function load(key, fb) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var state = load(LS.state, {});
  var prefs = load(LS.prefs, { view: 'inbox', sort: 'newest' });
  var meta  = load(LS.meta, { seenIds: [] });
  if (['inbox', 'important', 'archive'].indexOf(prefs.view) < 0) prefs.view = 'inbox';

  var allArticles = [];
  var allById = {};
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
  var starModal = document.getElementById('star-modal');
  var exportBtn = document.getElementById('export-btn');

  // ---------- helpers ----------
  function stEntry(pmid) { return state[pmid] || (state[pmid] = {}); }
  function isArchived(p) { return !!(state[p] && state[p].archived); }
  function isImportant(p) { return !!(state[p] && state[p].important); }
  function getStars(p) { return (state[p] && state[p].stars) || 0; }
  function persistState() { save(LS.state, state); }

  function parseDate(s) {
    if (!s) return null;
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(s) {
    var d = parseDate(s); if (!d) return '';
    return d.toLocaleString('en-US', { month: 'short' }) + ' ' + d.getDate() + ', ' + d.getFullYear();
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

  // ---------- high-impact journals (edit this list freely) ----------
  var HIGH_JOURNAL_EXACT = {
    'n engl j med': 1, 'lancet': 1, 'nature': 1, 'science': 1, 'cell': 1, 'jama': 1,
    'bmj': 1, 'proc natl acad sci u s a': 1,
    'nat med': 1, 'nat microbiol': 1, 'nat immunol': 1, 'nat genet': 1, 'nat commun': 1,
    'nat biotechnol': 1, 'nat methods': 1, 'nat metab': 1, 'nat ecol evol': 1,
    'sci transl med': 1, 'sci immunol': 1,
    'immunity': 1, 'cell host microbe': 1, 'mol cell': 1, 'cancer cell': 1,
    'plos med': 1, 'plos biol': 1, 'elife': 1, 'j exp med': 1, 'embo j': 1, 'blood': 1,
    'clin infect dis': 1, 'lancet infect dis': 1, 'lancet microbe': 1,
    'lancet glob health': 1, 'lancet public health': 1, 'lancet haematol': 1
  };
  var HIGH_JOURNAL_PREFIX = ['lancet ', 'nat rev ', 'jama '];
  function isHighJournal(j) {
    if (!j) return false;
    var s = j.toLowerCase().trim().replace(/\.$/, '');
    if (HIGH_JOURNAL_EXACT[s]) return true;
    for (var i = 0; i < HIGH_JOURNAL_PREFIX.length; i++) {
      if (s.indexOf(HIGH_JOURNAL_PREFIX[i]) === 0) return true;
    }
    return false;
  }

  // ---------- projects (auto-tags + manual filing) ----------
  function effProjects(a) {
    var s = state[a.id];
    return (s && s.projects) ? s.projects : [];      // manual tags only (no auto-labeling)
  }
  function matchesProject(a) {
    if (!prefs.project) return true;
    return effProjects(a).indexOf(prefs.project) >= 0;
  }
  function setProjectFilter(p) {
    prefs.project = (p && prefs.project === p) ? '' : p;
    save(LS.prefs, prefs);
    renderProjectBar();
    window.scrollTo(0, 0);
    applyView();
  }
  function toggleProject(a, label, node) {
    var cur = effProjects(a).slice();
    var i = cur.indexOf(label);
    if (i >= 0) cur.splice(i, 1); else cur.push(label);
    stEntry(a.id).projects = cur;
    persistState();
    renderProjChips(node, a);
    renderProjEditor(node, a);
    renderProjectBar();
    if (prefs.project && !matchesProject(a)) removeCard(node);
  }
  function renderProjectBar() {
    var bar = document.getElementById('project-bar');
    if (!bar) return;
    var counts = {};
    for (var i = 0; i < allArticles.length; i++) {
      var ps = effProjects(allArticles[i]);
      for (var j = 0; j < ps.length; j++) counts[ps[j]] = (counts[ps[j]] || 0) + 1;
    }
    bar.innerHTML = '';
    bar.appendChild(mkFilterChip('All', '', !prefs.project));
    Object.keys(counts).sort().forEach(function (p) {
      var b = mkFilterChip(p, p, prefs.project === p);
      var n = document.createElement('span');
      n.className = 'pbar-n'; n.textContent = counts[p];
      b.appendChild(n);
      bar.appendChild(b);
    });
  }
  function mkFilterChip(text, project, active) {
    var b = document.createElement('button');
    b.className = 'pbar-chip' + (active ? ' active' : '');
    b.type = 'button';
    b.appendChild(document.createTextNode(text));
    b.addEventListener('click', function () { setProjectFilter(project); });
    return b;
  }
  function renderProjChips(node, a) {
    var box = node.querySelector('.proj-chips');
    box.innerHTML = '';
    var ps = effProjects(a);
    ps.forEach(function (p) {
      var c = document.createElement('button');
      c.className = 'proj-chip'; c.type = 'button'; c.textContent = p;
      c.addEventListener('click', function () { setProjectFilter(p); });
      box.appendChild(c);
    });
    var edit = document.createElement('button');
    edit.className = 'proj-chip proj-edit-chip'; edit.type = 'button';
    edit.textContent = ps.length ? '＋' : '＋ Tag';
    edit.setAttribute('aria-label', 'Edit project tags');
    edit.addEventListener('click', function () {
      var peek = node.querySelector('.proj-editor');
      var willOpen = peek.hidden;
      closePeeks(node);               // collapse any other open peek first
      if (willOpen) { peek.hidden = false; renderProjEditor(node, a); }
    });
    box.appendChild(edit);
  }
  function renderProjEditor(node, a) {
    var box = node.querySelector('.proj-editor-chips');
    box.innerHTML = '';
    var cur = effProjects(a);
    PROJECTS.forEach(function (p) {
      var c = document.createElement('button');
      c.className = 'proj-opt' + (cur.indexOf(p) >= 0 ? ' active' : '');
      c.type = 'button'; c.textContent = p;
      c.addEventListener('click', function () { toggleProject(a, p, node); });
      box.appendChild(c);
    });
  }

  // ---------- counts ----------
  function updateCounts() {
    var inbox = 0, important = 0, archive = 0;
    for (var i = 0; i < allArticles.length; i++) {
      var p = allArticles[i].id;
      if (isArchived(p)) archive++;
      else if (isImportant(p)) important++;
      else inbox++;
    }
    setCount('inbox', inbox);
    setCount('important', important);
    setCount('archive', archive);
    if (exportBtn) exportBtn.textContent = important > 0 ? ('Export ★' + important) : 'Export';
  }
  function setCount(view, n) {
    var el = document.querySelector('.tab-count[data-count="' + view + '"]');
    if (el) el.textContent = n > 0 ? String(n) : '';
  }

  // ---------- filtering ----------
  function matchesView(a) {
    if (prefs.view === 'important') return isImportant(a.id);
    if (prefs.view === 'archive') return isArchived(a.id);
    return !isArchived(a.id) && !isImportant(a.id); // inbox = untriaged
  }
  function matchesSearch(a) {
    if (!searchTerm) return true;
    return (a._hay || '').indexOf(searchTerm) !== -1;
  }
  function applyView() {
    visible = allArticles.filter(function (a) { return matchesView(a) && matchesProject(a) && matchesSearch(a); });
    visible.sort(function (x, y) {
      if (prefs.view === 'important') {
        var sx = getStars(x.id), sy = getStars(y.id);
        if (sx !== sy) return sy - sx;             // highest-rated first
      }
      var dx = x._t, dy = y._t;
      return prefs.sort === 'oldest' ? dx - dy : dy - dx;
    });
    feedEl.innerHTML = '';
    rendered = 0;
    renderMore();
    showEmptyState();
  }

  function csvCell(v) {
    return '"' + (v == null ? '' : String(v)).replace(/"/g, '""') + '"';
  }
  function savedItems() {
    return allArticles.filter(function (a) { return isImportant(a.id); })
      .sort(function (x, y) { return (getStars(y.id) - getStars(x.id)) || (y._t - x._t); });
  }
  function exportCSV() {
    var items = savedItems();
    if (!items.length) { alert('No saved articles yet — swipe a card right (★) to save it, then export.'); return; }
    var cols = ['labels', 'author', 'year', 'title', 'journal', 'summary', 'stars', 'link'];
    var rows = [cols.join(',')];
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var d = parseDate(a.date);
      rows.push([
        effProjects(a).join('; '),
        a.authors || '',
        d ? d.getFullYear() : '',
        a.title_original || '',
        a.journal || '',
        a.details || '',
        getStars(a.id) || '',
        a.url || ('https://pubmed.ncbi.nlm.nih.gov/' + a.id + '/')
      ].map(csvCell).join(','));
    }
    var fname = 'malaria-feed-saved-' + items.length + '.csv';
    var blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    try {                                   // iOS: native share sheet (Save to Files, email, AirDrop)
      var file = new File([blob], fname, { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Malaria Feed export' }).catch(function () {});
        return;
      }
    } catch (e) {}
    var url = URL.createObjectURL(blob);    // desktop fallback: direct download
    var aEl = document.createElement('a');
    aEl.href = url; aEl.download = fname;
    document.body.appendChild(aEl);
    aEl.click();
    setTimeout(function () { document.body.removeChild(aEl); URL.revokeObjectURL(url); }, 200);
  }
  function showEmptyState() {
    var none = visible.length === 0;
    emptyEl.hidden = !none;
    if (none) {
      if (searchTerm) emptyEl.textContent = 'No headlines match “' + searchEl.value + '”.';
      else if (prefs.project) emptyEl.textContent = 'No “' + prefs.project + '” articles in ' + prefs.view + '.';
      else if (prefs.view === 'inbox') emptyEl.textContent = 'Inbox zero. 🎉 Nothing left to triage.';
      else if (prefs.view === 'important') emptyEl.textContent = 'Nothing important yet. Swipe a card right to file it here.';
      else emptyEl.textContent = 'Archive is empty. Swipe a card left to archive it.';
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
    node.querySelector('.headline').textContent = a.headline || a.title_original || '(untitled)';
    node.querySelector('.orig-title').textContent = a.title_original || '';
    node.querySelector('.details-text').textContent = a.details || '';
    node.querySelector('.authors-text').textContent = a.authors || 'Authors not listed';
    var url = a.url || ('https://pubmed.ncbi.nlm.nih.gov/' + a.id + '/');
    var links = node.querySelectorAll('.fulltext-link');
    for (var k = 0; k < links.length; k++) links[k].href = url;
    var titleBtn = node.querySelector('.title-btn');
    if (!a.title_original) titleBtn.style.display = 'none';
    var jEl = node.querySelector('.journal');
    jEl.textContent = a.journal || '';
    if (isHighJournal(a.journal)) jEl.classList.add('high-impact');
    var dt = node.querySelector('.date'); dt.textContent = fmtDate(a.date);
    if (!a.journal || !dt.textContent) node.querySelector('.meta-dot').style.display = 'none';
    renderProjChips(node, a);

    var abBtn = node.querySelector('.abstract-btn');
    if (!a.has_abstract) abBtn.style.display = 'none';

    if (newIds[a.id]) node.classList.add('is-new');
    paintState(node, a);

    main.addEventListener('click', function () { togglePeek(node, '.details-peek', null); });
    node.querySelector('.authors-btn').addEventListener('click', function (e) { togglePeek(node, '.authors-peek', e.currentTarget); });
    titleBtn.addEventListener('click', function (e) { togglePeek(node, '.title-peek', e.currentTarget); });
    abBtn.addEventListener('click', function () { toggleAbstract(node, a); });
    addSwipe(node, a);
    return node;
  }

  function paintState(node, a) {
    node.classList.toggle('is-archived', isArchived(a.id));
    node.classList.toggle('is-important', isImportant(a.id));
    var sEl = node.querySelector('.card-stars');
    if (isImportant(a.id)) {
      var n = getStars(a.id);
      sEl.textContent = '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
      sEl.hidden = false;
    } else {
      sEl.hidden = true;
    }
  }

  var SWIPE_COMMIT = 85;
  function addSwipe(node, a) {
    var startX = 0, startY = 0, dx = 0, active = false, decided = false, horiz = false;
    node.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest('.card-actions') || e.target.closest('.proj-chips') ||
          e.target.closest('.proj-editor') || e.target.closest('a')) return;
      startX = e.clientX; startY = e.clientY; dx = 0; active = true; decided = false; horiz = false;
      node.style.transition = 'none';
    });
    node.addEventListener('pointermove', function (e) {
      if (!active) return;
      dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        decided = true; horiz = Math.abs(dx) > Math.abs(dy);
        if (horiz) { try { node.setPointerCapture(e.pointerId); } catch (_) {} }
      }
      if (decided && horiz) {
        e.preventDefault();
        node.style.transform = 'translateX(' + dx + 'px)';
        node.classList.toggle('swipe-arch', dx <= -SWIPE_COMMIT);
        node.classList.toggle('swipe-imp', dx >= SWIPE_COMMIT);
        node.classList.add('swiping');
      }
    });
    function end() {
      if (!active) return; active = false;
      node.classList.remove('swiping', 'swipe-arch', 'swipe-imp');
      if (decided && horiz && Math.abs(dx) > SWIPE_COMMIT) {
        if (dx < 0) applyTriage(node, a, 'archive');
        else openStarModal(node, a);
      } else {
        node.style.transition = 'transform .2s ease';
        node.style.transform = '';
      }
    }
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }
  var pendingStar = null;
  function openStarModal(node, a) {
    node.style.transition = 'transform .2s ease';
    node.style.transform = '';                 // snap card back; the modal does the prompting
    pendingStar = { node: node, a: a };
    fillStars(getStars(a.id));
    starModal.hidden = false;
  }
  function fillStars(n) {
    var sts = starModal.querySelectorAll('.sm-star');
    for (var i = 0; i < sts.length; i++) sts[i].classList.toggle('on', i < n);
  }
  function closeStarModal() { starModal.hidden = true; pendingStar = null; }

  // ---------- triage: archive / important (+stars) ----------
  function archive(a) {
    var e = stEntry(a.id);
    e.archived = 1; delete e.important; delete e.stars;
    persistState();
  }
  function setImportant(a, stars) {
    var e = stEntry(a.id);
    e.important = 1; e.stars = stars; delete e.archived;
    persistState();
  }
  function applyTriage(node, a, kind, stars) {
    if (kind === 'archive') archive(a); else setImportant(a, stars);
    updateCounts();
    if (matchesView(a)) {                 // stays in current view
      node.style.transition = 'transform .2s ease';
      node.style.transform = '';
      paintState(node, a);
    } else {                              // left the view: slide off in swipe direction
      node.style.transition = 'transform .24s ease, opacity .24s ease';
      node.style.transform = 'translateX(' + (kind === 'archive' ? '-115%' : '115%') + ')';
      node.style.opacity = '0';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); showEmptyState(); }, 230);
    }
  }
  function removeCard(node) {
    node.style.transition = 'opacity .18s ease, transform .18s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateX(8px)';
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); showEmptyState(); }, 180);
  }

  // ---------- peeks (only one open per card) ----------
  function closePeeks(node) {
    var peeks = node.querySelectorAll('.peek');
    for (var i = 0; i < peeks.length; i++) peeks[i].hidden = true;
    var btns = node.querySelectorAll('.act');
    for (var j = 0; j < btns.length; j++) btns[j].setAttribute('aria-expanded', 'false');
  }
  function togglePeek(node, boxSel, btn) {
    var box = node.querySelector(boxSel);
    var willOpen = box.hidden;
    closePeeks(node);                 // collapse any other open peek first
    if (willOpen) { box.hidden = false; if (btn) btn.setAttribute('aria-expanded', 'true'); }
  }

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
    var willOpen = box.hidden;
    closePeeks(node);                 // collapse any other open peek first
    if (!willOpen) return;            // was open -> now closed
    btn.setAttribute('aria-expanded', 'true');
    box.hidden = false;
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
    a._hay = ((a.headline || '') + ' ' + (a.details || '') + ' ' + (a.title_original || '') + ' ' +
              (a.journal || '') + ' ' + (a.authors || '')).toLowerCase();
    allById[a.id] = a;
    return a;
  }
  function ingest(data, isFresh) {
    allById = {};
    allArticles = (data.articles || []).map(indexArticle);
    updatedEl.textContent = data.generated_at ? relTime(data.generated_at) : '';
    computeNew();
    updateCounts();
    renderProjectBar();
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
  if (exportBtn) exportBtn.addEventListener('click', exportCSV);
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

  // star-rating modal (shown on swipe-right)
  if (starModal) {
    var smStars = document.getElementById('sm-stars');
    for (var v = 1; v <= 5; v++) {
      (function (val) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'sm-star'; b.textContent = '★';
        b.setAttribute('aria-label', val + (val > 1 ? ' stars' : ' star'));
        b.addEventListener('mouseenter', function () { fillStars(val); });
        b.addEventListener('pointerdown', function () { fillStars(val); });
        b.addEventListener('click', function () {
          if (pendingStar) applyTriage(pendingStar.node, pendingStar.a, 'important', val);
          closeStarModal();
        });
        smStars.appendChild(b);
      })(v);
    }
    document.getElementById('sm-cancel').addEventListener('click', closeStarModal);
    starModal.addEventListener('click', function (e) { if (e.target === starModal) closeStarModal(); });
  }
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
