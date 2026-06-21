(function () {
  'use strict';

  var ARTICLES_URL = 'articles.json';
  var ABSTRACTS_URL = 'abstracts.json';
  var LS = {
    state: 'ncbifeed.v1.state', // { pmid: {archived?,important?,stars?,projects?, t} }
    prefs: 'ncbifeed.v1.prefs', // { view, sort }
    meta:  'ncbifeed.v1.meta',  // { seenIds:[...] }
    sync:  'ncbifeed.v1.sync'   // { token }  (device-local; GitHub triage backup)
  };
  var PAGE = 30;
  // your research projects, alphabetical (used for the manual tag editor)
  var PROJECTS = ['CHASM', 'CV', 'Drug Resistance', 'Drugs', 'Forecasting',
    'Genomics', 'ICEMR', 'IMPRINT', 'MACEPA', 'MalarAI', 'MARSHAL', 'Modeling', 'Mol Bio', 'PDMC',
    'PharCide', 'PK/PD', 'PLATFORM', 'Review', 'Serology', 'Vaccine', 'VSA', 'Other'];

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
  function persistState() { save(LS.state, state); scheduleSync(); }

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
  function effNote(a) { var s = state[a.id]; return (s && s.note) || ''; }
  // one-time, idempotent: rename legacy tag strings in saved triage
  var TAG_RENAMES = { 'Computer Vision': 'CV' };
  function migrateTags() {
    var changed = false;
    for (var pmid in state) {
      var ps = state[pmid] && state[pmid].projects;
      if (!ps) continue;
      for (var i = 0; i < ps.length; i++) {
        if (TAG_RENAMES[ps[i]]) { ps[i] = TAG_RENAMES[ps[i]]; state[pmid].t = Date.now(); changed = true; }
      }
    }
    return changed;
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
    var e = stEntry(a.id); e.projects = cur; e.t = Date.now();
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

    var notes = document.createElement('button');
    var hasNote = !!effNote(a);
    notes.className = 'proj-chip note-chip' + (hasNote ? ' has-note' : '');
    notes.type = 'button';
    notes.textContent = hasNote ? '✎ Notes' : '＋ Notes';
    notes.setAttribute('aria-label', 'Edit notes');
    notes.addEventListener('click', function () {
      var peek = node.querySelector('.note-peek');
      var willOpen = peek.hidden;
      closePeeks(node);
      if (willOpen) { peek.hidden = false; node.querySelector('.note-text').focus(); }
    });
    box.appendChild(notes);
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
      if (prefs.sort === 'shuffle') return (x._shuf || 0) - (y._shuf || 0);
      if (prefs.view === 'important') {
        var sx = getStars(x.id), sy = getStars(y.id);
        if (sx !== sy) return sy - sx;             // highest-rated first
      }
      return prefs.sort === 'oldest' ? (x._t - y._t) : (y._t - x._t);
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
    var cols = ['labels', 'author', 'year', 'title', 'journal', 'summary', 'stars', 'notes', 'link'];
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
        effNote(a),
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
    var noteBox = node.querySelector('.note-text');
    noteBox.value = effNote(a);
    var noteTimer;
    noteBox.addEventListener('input', function () {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () {
        var e = stEntry(a.id); e.note = noteBox.value; e.t = Date.now();
        persistState();
        renderProjChips(node, a);   // refresh the Notes chip indicator
      }, 500);
    });
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
      // swipe is allowed over the Notes area/textarea too: a tap still focuses it for typing,
      // a horizontal drag swipes the card. Only true tap targets (buttons/links/chips) opt out.
      if (e.target.closest('.card-actions') || e.target.closest('.proj-chips') ||
          e.target.closest('.proj-editor') ||
          e.target.closest('a, button')) return;
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
    e.archived = 1; delete e.important; delete e.stars; e.t = Date.now();
    persistState();
  }
  function setImportant(a, stars) {
    var e = stEntry(a.id);
    e.important = 1; e.stars = stars; delete e.archived; e.t = Date.now();
    persistState();
  }
  function applyTriage(node, a, kind, stars) {
    // snapshot the entry BEFORE archiving so Undo can restore it exactly (untriaged, or any tags/note)
    var prevSnap = kind === 'archive'
      ? (state[a.id] ? JSON.parse(JSON.stringify(state[a.id])) : null) : null;
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
    if (kind === 'archive') showUndo(a, prevSnap);
  }
  function removeCard(node) {
    node.style.transition = 'opacity .18s ease, transform .18s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateX(8px)';
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); showEmptyState(); }, 180);
  }

  // ---------- undo (accidental archive) ----------
  var undoToast = document.getElementById('undo-toast');
  var undoMsgEl = undoToast.querySelector('.undo-msg');
  var undoBtnEl = document.getElementById('undo-btn');
  var undoCtx = null, undoTimer = null;
  function showUndo(a, prevSnap) {
    undoCtx = { id: a.id, prev: prevSnap };
    undoMsgEl.textContent = 'Archived';
    undoToast.hidden = false;
    void undoToast.offsetWidth;                 // force reflow so the slide-in transition runs
    undoToast.classList.add('show');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 3500);
  }
  function hideUndo() {
    clearTimeout(undoTimer);
    undoCtx = null;
    undoToast.classList.remove('show');
    setTimeout(function () { if (!undoToast.classList.contains('show')) undoToast.hidden = true; }, 220);
  }
  undoBtnEl.addEventListener('click', function () {
    if (!undoCtx) return;
    if (undoCtx.prev == null) delete state[undoCtx.id];   // was untriaged -> remove entry entirely
    else state[undoCtx.id] = undoCtx.prev;                // restore prior entry (tags/note/etc.)
    persistState();
    updateCounts();
    renderProjectBar();
    applyView();                                          // re-renders the card back into place
    hideUndo();
  });

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
    a._shuf = Math.random();
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
  var SORT_NEXT = { newest: 'oldest', oldest: 'shuffle', shuffle: 'newest' };
  function sortGlyph(s) { return s === 'oldest' ? '↓' : s === 'shuffle' ? '🔀' : '↑'; }
  function sortTip(s) { return s === 'oldest' ? 'Oldest first' : s === 'shuffle' ? 'Shuffle' : 'Newest first'; }
  function reshuffle() { for (var i = 0; i < allArticles.length; i++) allArticles[i]._shuf = Math.random(); }
  function paintSortBtn() { sortBtn.textContent = sortGlyph(prefs.sort); sortBtn.title = sortTip(prefs.sort); }
  sortBtn.addEventListener('click', function () {
    prefs.sort = SORT_NEXT[prefs.sort] || 'newest';
    if (prefs.sort === 'shuffle') reshuffle();
    paintSortBtn();
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
  paintSortBtn();
  tabs.forEach(function (t) { t.setAttribute('aria-selected', t.dataset.view === prefs.view ? 'true' : 'false'); });

  // ---------- GitHub triage backup/sync (single user) ----------
  var GH_OWNER = 'matthew-m-ippolito', GH_REPO = 'ncbi-feed', GH_BRANCH = 'triage-state', GH_PATH = 'triage.json';
  var GH_API = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO;
  var sync = load(LS.sync, {});
  var remoteSha = null, syncing = false, pushTimer = null;

  function syncEnabled() { return !!(sync && sync.token); }
  function ghHeaders() { return { 'Authorization': 'Bearer ' + sync.token, 'Accept': 'application/vnd.github+json' }; }
  function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64dec(s) { return decodeURIComponent(escape(atob((s || '').replace(/\n/g, '')))); }

  function setSyncStatus(txt, kind) {
    var el = document.getElementById('sync-status');
    if (el) { el.textContent = txt; el.className = 'sync-status ' + (kind || ''); }
  }

  function ghGet() { // -> {items, sha}
    return fetch(GH_API + '/contents/' + GH_PATH + '?ref=' + GH_BRANCH, { headers: ghHeaders(), cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { items: {}, sha: null };
        if (!r.ok) throw new Error('GET ' + r.status);
        return r.json().then(function (j) {
          var data = {}; try { data = JSON.parse(b64dec(j.content)); } catch (e) {}
          return { items: (data && data.items) || {}, sha: j.sha };
        });
      });
  }
  function ensureBranch() {
    return fetch(GH_API + '/git/ref/heads/' + GH_BRANCH, { headers: ghHeaders() }).then(function (r) {
      if (r.ok) return true;
      if (r.status !== 404) throw new Error('ref ' + r.status);
      return fetch(GH_API + '/git/ref/heads/main', { headers: ghHeaders() })
        .then(function (r2) { if (!r2.ok) throw new Error('main ' + r2.status); return r2.json(); })
        .then(function (m) {
          return fetch(GH_API + '/git/refs', { method: 'POST', headers: ghHeaders(),
            body: JSON.stringify({ ref: 'refs/heads/' + GH_BRANCH, sha: m.object.sha }) });
        }).then(function () { return true; });
    });
  }
  function ghPut(sha) {
    var payload = { v: 1, updatedAt: Date.now(), items: state };
    var body = { message: 'triage ' + new Date().toISOString(),
      content: b64enc(JSON.stringify(payload)), branch: GH_BRANCH };
    if (sha) body.sha = sha;
    return fetch(GH_API + '/contents/' + GH_PATH, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 409 || r.status === 422) return null; // sha conflict -> retry
        if (!r.ok) throw new Error('PUT ' + r.status);
        return r.json().then(function (j) { return j.content.sha; });
      });
  }
  function mergeItems(remote) { // per-pmid last-writer-wins by t
    var changed = false;
    for (var pmid in remote) {
      var rt = remote[pmid] || {}, lt = state[pmid];
      if (!lt || (rt.t || 0) > (lt.t || 0)) { state[pmid] = rt; changed = true; }
    }
    return changed;
  }
  function syncNow() {
    if (!syncEnabled() || syncing) return;
    syncing = true; setSyncStatus('Syncing…', 'busy');
    ensureBranch().then(ghGet).then(function (res) {
      remoteSha = res.sha;
      var merged = mergeItems(res.items);
      var migrated = migrateTags();   // also fix any legacy tags pulled from remote
      if (merged || migrated) { save(LS.state, state); updateCounts(); renderProjectBar(); applyView(); }
      return ghPut(remoteSha).then(function (ns) {
        if (ns === null) { // conflict: re-pull, merge, retry once
          return ghGet().then(function (r2) { mergeItems(r2.items); save(LS.state, state); return ghPut(r2.sha); });
        }
        return ns;
      }).then(function (ns) { if (ns) remoteSha = ns; });
    }).then(function () {
      syncing = false; setSyncStatus('Synced ✓', 'ok');
    }).catch(function () {
      syncing = false; setSyncStatus(navigator.onLine === false ? 'Offline — will retry' : 'Error — check token', 'err');
    });
  }
  function scheduleSync() {
    if (!syncEnabled()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, 2500);
  }

  // ---------- boot ----------
  function boot() {
    fetch(ARTICLES_URL).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (d) {
      currentGenerated = d.generated_at || '';
      if (migrateTags()) save(LS.state, state);
      ingest(d, false);
      setTimeout(checkForUpdates, 1500);
      if (syncEnabled()) syncNow();
    }).catch(function (err) {
      loadingEl.hidden = true;
      if (allArticles.length === 0) { errorEl.hidden = false; }
    });
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden && syncEnabled()) syncNow(); });

  // ---------- settings sheet (sync token + JSON backup) ----------
  var settingsModal = document.getElementById('settings-modal');
  var tokenInput = document.getElementById('sync-token');
  function openSettings() {
    if (tokenInput) tokenInput.value = (sync && sync.token) ? sync.token : '';
    setSyncStatus(syncEnabled() ? 'Connected' : 'Not set up', syncEnabled() ? 'ok' : '');
    settingsModal.hidden = false;
  }
  function closeSettings() { settingsModal.hidden = true; }
  function exportJSON() {
    var blob = new Blob([JSON.stringify({ v: 1, exportedAt: Date.now(), items: state }, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob), el = document.createElement('a');
    el.href = url; el.download = 'malaria-feed-triage-backup.json';
    document.body.appendChild(el); el.click();
    setTimeout(function () { document.body.removeChild(el); URL.revokeObjectURL(url); }, 200);
  }
  function importJSON(file) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var d = JSON.parse(rd.result), items = d.items || d;
        if (mergeItems(items)) { save(LS.state, state); updateCounts(); renderProjectBar(); applyView(); }
        setSyncStatus('Imported ✓', 'ok'); scheduleSync();
      } catch (e) { setSyncStatus('Import failed — bad file', 'err'); }
    };
    rd.readAsText(file);
  }
  if (settingsModal) {
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('set-close').addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', function (e) { if (e.target === settingsModal) closeSettings(); });
    document.getElementById('sync-save').addEventListener('click', function () {
      var t = tokenInput.value.trim();
      sync = t ? { token: t } : {};
      save(LS.sync, sync);
      if (syncEnabled()) { setSyncStatus('Connecting…', 'busy'); syncNow(); } else { setSyncStatus('Not set up', ''); }
    });
    document.getElementById('sync-disconnect').addEventListener('click', function () {
      sync = {}; save(LS.sync, sync); if (tokenInput) tokenInput.value = ''; setSyncStatus('Disconnected', '');
    });
    document.getElementById('export-json').addEventListener('click', exportJSON);
    var imp = document.getElementById('import-json');
    document.getElementById('import-json-btn').addEventListener('click', function () { imp.click(); });
    imp.addEventListener('change', function () { if (imp.files[0]) importJSON(imp.files[0]); });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }
  boot();
})();
