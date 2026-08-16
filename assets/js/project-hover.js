/*==================================
 * Project card menu
 *
 * Clicking (or focusing) a .project-card dims the page and grows a curved
 * arc out of the card edge; the card's links ride along the arc as buttons,
 * and a project figure floats alongside if the card declares one.
 *
 * Click rather than hover, because the arc lives outside the card: on hover
 * the cursor has to cross dead space to reach a button, and any wobble on
 * the way dismisses the thing you were reaching for.
 *
 * Progressive enhancement:
 *   - nothing runs without a fine pointer and a >=992px viewport, so touch
 *     devices keep the plain inline-button cards.
 *   - the real <a> elements in .project-links stay in the DOM (visually
 *     hidden once enhanced) so they remain focusable and crawlable. The arc
 *     buttons are decorative mirrors: aria-hidden, tabindex -1.
 *   - figures are fetched on first open, never on page load.
 *
 * Only opacity / transform / stroke-dashoffset are animated.
==================================== */

(function () {
    'use strict';

    if (!window.matchMedia) return;

    var grids = document.querySelectorAll('.projects-grid');
    if (!grids.length) return;

    var hoverMQ = window.matchMedia('(hover: hover) and (pointer: fine)');
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Re-evaluated rather than checked once, so a window that starts narrow
    // (or a device that gains a mouse) still picks the enhancement up.
    function enabled() {
        return hoverMQ.matches && window.innerWidth >= 992;
    }
    var SVG_NS = 'http://www.w3.org/2000/svg';

    // Arc geometry. Stems fan away from the card edge, each one a little
    // longer than the last, so the labels stack without colliding.
    var BASE_ANGLE = -8;    // degrees from horizontal for the nearest stem
    var ANGLE_STEP = -24;   // each further stem swings this much more
    var BASE_RADIUS = 122;
    var RADIUS_STEP = 24;
    var STEM_STAGGER = 60;  // ms between stems drawing
    var FIGURE_GAP = 46;

    var overlay = null, backdrop = null, stage = null, svg = null, itemsBox = null;
    var panel = null, figure = null, figImg = null, notes = null, notesList = null;
    var cite = null, citePre = null, citeCopy = null, citeOpen = false;
    var panelW = 0, panelX = 0, panelMidY = 0;
    var activeItems = null;
    var lightbox = null, lightImg = null, lightPrevFocus = null;
    var activeCard = null, activeLinks = null;
    var openScrollY = 0, scrollRaf = null;

    /* ---------- overlay construction (lazy, once) ---------- */

    function buildOverlay() {
        overlay = document.createElement('div');
        overlay.id = 'project-hover';
        overlay.setAttribute('aria-hidden', 'true');

        backdrop = document.createElement('div');
        backdrop.className = 'ph-backdrop';

        svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'ph-spine');
        svg.setAttribute('preserveAspectRatio', 'none');

        itemsBox = document.createElement('div');
        itemsBox.className = 'ph-items';

        // One column beside the arc, holding the project's artwork and/or its
        // takeaway notes. They are separate boxes: artwork keeps its white
        // mount, notes sit as plain text straight on the dimmed page.
        panel = document.createElement('div');
        panel.className = 'ph-panel';

        figure = document.createElement('div');
        figure.className = 'ph-figure';
        figImg = document.createElement('img');
        figImg.alt = '';
        figImg.decoding = 'async';
        figure.appendChild(figImg);

        notes = document.createElement('div');
        notes.className = 'ph-notes';
        notes.innerHTML = '<p class="ph-notes-title">Key takeaways</p>'
                        + '<ol class="ph-notes-list"></ol>';
        notesList = notes.querySelector('.ph-notes-list');

        cite = document.createElement('div');
        cite.className = 'ph-cite';
        cite.innerHTML = '<div class="ph-cite-head">'
                       + '<span class="ph-cite-title">BibTeX</span>'
                       + '<button type="button" class="ph-cite-copy">Copy</button>'
                       + '</div><pre class="ph-cite-body"></pre>';
        citePre = cite.querySelector('.ph-cite-body');
        citeCopy = cite.querySelector('.ph-cite-copy');
        citeCopy.addEventListener('click', function (e) { e.stopPropagation(); copyCite(); });
        // Let the reader select the entry by hand without dismissing the menu.
        cite.addEventListener('click', function (e) { e.stopPropagation(); });
        cite.addEventListener('mousedown', function (e) { e.stopPropagation(); });

        panel.appendChild(figure);
        panel.appendChild(notes);
        panel.appendChild(cite);

        // Everything anchored to the card lives in one stage, so following a
        // scroll is a single transform write rather than a geometry rebuild.
        stage = document.createElement('div');
        stage.className = 'ph-stage';
        stage.appendChild(svg);
        stage.appendChild(itemsBox);
        stage.appendChild(panel);

        overlay.appendChild(backdrop);
        overlay.appendChild(stage);
        document.body.appendChild(overlay);

        // Clicking the dimmed area dismisses the menu — unless the click
        // landed on another card underneath, in which case switch to it.
        backdrop.addEventListener('click', function (e) {
            var under = document.elementsFromPoint
                ? document.elementsFromPoint(e.clientX, e.clientY)
                : [];
            for (var i = 0; i < under.length; i++) {
                var card = cardOf(under[i]);
                if (card && card !== activeCard) { open(card); return; }
            }
            close();
        });

        // The buttons mirror the card's real links; a click is forwarded to
        // the link itself so target/rel/href behaviour stays in one place.
        itemsBox.addEventListener('click', function (e) {
            var item = e.target.closest ? e.target.closest('.ph-item') : null;
            if (!item || !activeItems) return;
            var entry = activeItems[item.dataset.index | 0];
            if (!entry) return;
            if (entry.bibtex !== undefined) { toggleCite(item); return; }
            var link = activeLinks[entry.index];
            if (link) link.click();
        });

        panel.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!activeCard || !figure.contains(e.target)) return;
            var full = activeCard.getAttribute('data-figure-full')
                    || activeCard.getAttribute('data-figure');
            if (full) openLightbox(full, activeCard.getAttribute('data-figure-alt'));
        });
    }

    /* ---------- geometry ---------- */

    function stemPath(ax, ay, ex, ey, hdir) {
        // Leave the anchor climbing vertically, arrive at the label flat —
        // the hand-drawn "J" of the sketch.
        var c1x = ax + hdir * 16;
        var c1y = ay + (ey - ay) * 0.62;
        var c2x = ex - hdir * 84;
        var c2y = ey;
        return 'M' + ax + ' ' + ay + ' C' + c1x + ' ' + c1y + ',' + c2x + ' ' + c2y + ',' + ex + ' ' + ey;
    }

    /* ---------- open / close ---------- */

    function open(card) {
        if (!enabled()) return;
        if (activeCard === card) return;
        if (activeCard) close();

        if (card.classList.contains('no-menu')) return;

        var links = card.querySelectorAll('.project-links a');
        if (!links.length) return;

        if (!overlay) buildOverlay();

        activeCard = card;
        activeLinks = links;

        // Arc entries are the card's real links, plus a Cite stem for anything
        // that ships a BibTeX record. Cite is an action, not a destination, so
        // it carries no link and toggles the citation panel instead.
        // Index 0 is the shortest, lowest stem, so Cite goes first to sit at
        // the bottom of the fan — under the links, not above them.
        var bib = card.querySelector('.project-bibtex');
        activeItems = [];
        if (bib) activeItems.push({ label: 'Cite', cls: 'cite-link', bibtex: bib.textContent });
        for (var q = 0; q < links.length; q++) {
            activeItems.push({ label: links[q].textContent.trim(), cls: links[q].className, index: q });
        }
        citeOpen = false;
        card.classList.add('is-active');

        openScrollY = window.pageYOffset;
        stage.style.transform = '';

        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var rect = card.getBoundingClientRect();

        svg.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh);
        svg.setAttribute('width', vw);
        svg.setAttribute('height', vh);

        var n = activeItems.length;
        var maxRadius = BASE_RADIUS + (n - 1) * RADIUS_STEP;

        // Flip to the left when the arc would run off the right edge.
        var hdir = (rect.right + maxRadius + 150 > vw - 24) ? -1 : 1;
        // Flip downward when the fan would climb out of the top of the screen.
        var vdir = (rect.top + 34 - maxRadius < 96) ? 1 : -1;

        var ax = hdir === 1 ? rect.right - 6 : rect.left + 6;
        var ay = vdir === -1 ? rect.top + 34 : rect.bottom - 34;

        // Pass 1: build the buttons so we can measure their widths.
        itemsBox.innerHTML = '';
        var buttons = [];
        var i;
        for (i = 0; i < n; i++) {
            var src = activeItems[i];
            var btn = document.createElement('span');
            btn.className = 'ph-item ' + src.cls;
            btn.textContent = src.label;
            btn.setAttribute('aria-hidden', 'true');
            btn.setAttribute('tabindex', '-1');
            btn.dataset.index = i;
            itemsBox.appendChild(btn);
            buttons.push(btn);
        }

        // Pass 2: place everything. All measurements are read up front so the
        // positioning writes below cannot thrash layout.
        var widths = [], heights = [];
        for (i = 0; i < n; i++) {
            widths.push(buttons[i].offsetWidth);
            heights.push(buttons[i].offsetHeight);
        }

        while (svg.firstChild) svg.removeChild(svg.firstChild);

        var farthestX = ax;
        for (i = 0; i < n; i++) {
            var deg = BASE_ANGLE + i * ANGLE_STEP;
            var rad = (deg * Math.PI) / 180;
            var r = BASE_RADIUS + i * RADIUS_STEP;
            var ex = ax + hdir * Math.cos(rad) * r;
            var ey = ay + vdir * -Math.sin(rad) * r;

            var w = widths[i];
            var tailX = ex + hdir * (w + 16);
            if (hdir === 1 ? tailX > farthestX : tailX < farthestX) farthestX = tailX;

            var path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('class', 'ph-stem');
            path.setAttribute('d', stemPath(ax, ay, ex, ey, hdir) + ' L' + tailX + ' ' + ey);
            svg.appendChild(path);

            if (!reduce) {
                var len = path.getTotalLength();
                path.style.strokeDasharray = len;
                path.style.strokeDashoffset = len;
                path.style.transitionDelay = (i * STEM_STAGGER) + 'ms';
            }

            buttons[i].style.left = (hdir === 1 ? ex + 8 : ex - w - 8) + 'px';
            buttons[i].style.top = (ey - heights[i] - 5) + 'px';
            if (!reduce) buttons[i].style.transitionDelay = (140 + i * STEM_STAGGER) + 'ms';
            buttons[i].style.setProperty('--ph-slide', (hdir * -14) + 'px');
        }

        // The side column: artwork and/or takeaway notes, independently. Images
        // are fetched on demand, so a project with no artwork costs nothing and
        // nothing loads until the card opens.
        var figSrc = card.getAttribute('data-figure');
        var takeaways = card.querySelectorAll('.project-takeaways li');
        var hasNotes = takeaways.length > 0;
        panel.hidden = true;
        figure.hidden = !figSrc;
        notes.hidden = !hasNotes;
        cite.hidden = true;
        if (figSrc || hasNotes || bib) {
            // Prefer the far side of the arc; fall back to the other side of
            // the card when the arc has run out of room, so the figure never
            // lands on top of its own buttons.
            var spaceOut = hdir === 1
                ? vw - 24 - (farthestX + FIGURE_GAP)
                : (farthestX - FIGURE_GAP) - 24;
            var spaceBack = hdir === 1
                ? rect.left - 24 - FIGURE_GAP
                : vw - 24 - (rect.right + FIGURE_GAP);

            var maxW = figSrc ? 400 : 380;
            var figW, figX;
            if (spaceOut >= 260 || spaceOut >= spaceBack) {
                figW = Math.min(maxW, Math.floor(spaceOut));
                figX = hdir === 1 ? farthestX + FIGURE_GAP : farthestX - FIGURE_GAP - figW;
            } else {
                figW = Math.min(maxW, Math.floor(spaceBack));
                figX = hdir === 1 ? rect.left - FIGURE_GAP - figW : rect.right + FIGURE_GAP;
            }

            if (figW >= 220) {
                if (hasNotes) {
                    notesList.innerHTML = '';
                    for (var t = 0; t < takeaways.length; t++) {
                        var li = document.createElement('li');
                        li.textContent = takeaways[t].textContent;
                        notesList.appendChild(li);
                    }
                }
                if (figSrc && figImg.getAttribute('src') !== figSrc) {
                    figImg.setAttribute('src', figSrc);
                    figImg.alt = card.getAttribute('data-figure-alt') || '';
                }
                if (bib) citePre.textContent = bib.textContent.trim();

                panelW = figW;
                panelX = figX;
                panelMidY = (rect.top + rect.bottom) / 2;
                // A card with only a citation keeps the column hidden until
                // Cite is actually pressed.
                if (figSrc || hasNotes) placePanel();
            }
        }

        // Commit the start values (dashoffset, opacity) before flipping the
        // class, otherwise the transitions are skipped. A forced reflow rather
        // than requestAnimationFrame, which never fires in a background tab.
        void overlay.offsetWidth;
        overlay.classList.add('is-open');
    }

    function close() {
        if (!activeCard) return;
        activeCard.classList.remove('is-active');
        activeCard = null;
        activeLinks = null;
        activeItems = null;
        citeOpen = false;
        if (cite) cite.hidden = true;
        if (overlay) overlay.classList.remove('is-open');
    }

    /* ---------- side column placement ---------- */

    // Re-measured rather than cached, because toggling the citation changes the
    // column's height and it has to stay centred on the card and on screen.
    function placePanel() {
        var vh = window.innerHeight;
        panel.style.width = panelW + 'px';
        panel.style.left = panelX + 'px';
        panel.style.visibility = 'hidden';
        panel.hidden = false;
        var half = Math.min(panel.offsetHeight, vh - 120) / 2;
        panel.style.top = Math.max(96 + half, Math.min(vh - 24 - half, panelMidY)) + 'px';
        panel.style.visibility = '';
    }

    function toggleCite(item) {
        citeOpen = !citeOpen;
        cite.hidden = !citeOpen;
        if (item) item.classList.toggle('is-on', citeOpen);
        citeCopy.textContent = 'Copy';
        citeCopy.classList.remove('is-done');
        if (citeOpen || !panel.hidden) placePanel();
        if (!citeOpen && figure.hidden && notes.hidden) panel.hidden = true;
    }

    function copyCite() {
        var text = citePre.textContent;
        var done = function () {
            citeCopy.textContent = 'Copied';
            citeCopy.classList.add('is-done');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () {
                citeCopy.textContent = 'Press ⌘C';
            });
        } else {
            // Older Safari: select the block so the keyboard shortcut works.
            var r = document.createRange();
            r.selectNodeContents(citePre);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
            citeCopy.textContent = 'Press ⌘C';
        }
    }

    /* ---------- lightbox ---------- */

    function openLightbox(src, alt) {
        if (!lightbox) {
            lightbox = document.createElement('div');
            lightbox.className = 'ph-lightbox';
            lightbox.innerHTML =
                '<div class="ph-backdrop"></div>' +
                '<button type="button" class="ph-lightbox-close" aria-label="Close">&times;</button>' +
                '<img alt="">';
            document.body.appendChild(lightbox);
            lightImg = lightbox.querySelector('img');
            lightbox.addEventListener('click', function (e) {
                if (e.target === lightImg) return;
                closeLightbox();
            });
        }
        lightPrevFocus = document.activeElement;
        if (lightImg.getAttribute('src') !== src) {
            lightImg.setAttribute('src', src);
            lightImg.alt = alt || '';
        }
        lightbox.classList.add('is-open');
        document.body.classList.add('ph-locked');
        lightbox.querySelector('.ph-lightbox-close').focus();
    }

    function closeLightbox() {
        if (!lightbox || !lightbox.classList.contains('is-open')) return;
        lightbox.classList.remove('is-open');
        document.body.classList.remove('ph-locked');
        if (lightPrevFocus && lightPrevFocus.focus) lightPrevFocus.focus();
        lightPrevFocus = null;
    }

    /* ---------- wiring: one delegated listener set per grid ---------- */

    function cardOf(node) {
        return node && node.closest ? node.closest('.project-card') : null;
    }

    // Venue labels are nowrap, so a long journal name would spill out of the
    // card. Shrink the type to fit instead of wrapping or truncating. Sized
    // from one measurement rather than a shrink-until-it-fits loop, so this
    // costs a single layout read per label; a second pass corrects for
    // rounding and for the fact that glyph widths are not perfectly linear.
    var VENUE_MIN = 8.5;

    function fitVenues() {
        var els = document.querySelectorAll('.project-venue');
        if (!els.length) return;
        var i, base;

        for (i = 0; i < els.length; i++) els[i].style.fontSize = '';
        base = parseFloat(getComputedStyle(els[0]).fontSize);

        // One size for all of them, driven by the longest label. Sizing each
        // label independently fits too, but a row of venues at four different
        // sizes reads as an accident rather than a choice.
        for (var pass = 0; pass < 2; pass++) {
            var scale = 1;
            for (i = 0; i < els.length; i++) {
                var have = els[i].clientWidth, need = els[i].scrollWidth;
                if (have && need > have) scale = Math.min(scale, have / need);
            }
            if (scale === 1) return;
            var cur = parseFloat(els[0].style.fontSize) || base;
            var size = Math.max(VENUE_MIN, Math.floor(cur * scale * 10) / 10);
            for (i = 0; i < els.length; i++) els[i].style.fontSize = size + 'px';
        }
    }

    // Titles wrap to different line counts, which pushes each card's venue
    // label to a different height. Pad every title in a row up to the tallest
    // one so the venues — and the copy under them — sit on shared baselines.
    // Done per visual row, and by measurement rather than a fixed two-line
    // min-height, so it survives reflow to 3/2/1 columns and any title length.
    function alignCardHeads() {
        var cards = document.querySelectorAll('.projects-grid .project-card');
        if (!cards.length) return;
        var i, h3, rows = {}, key, tops = [];

        for (i = 0; i < cards.length; i++) {
            h3 = cards[i].querySelector('h3');
            if (h3) h3.style.minHeight = '';
        }
        // Cards in a row share a top, since the grid already equalises heights.
        for (i = 0; i < cards.length; i++) {
            h3 = cards[i].querySelector('h3');
            if (!h3) continue;
            key = Math.round(cards[i].getBoundingClientRect().top);
            if (!rows[key]) { rows[key] = []; tops.push(key); }
            rows[key].push(h3);
        }
        for (var t = 0; t < tops.length; t++) {
            var group = rows[tops[t]], tallest = 0;
            for (i = 0; i < group.length; i++) {
                tallest = Math.max(tallest, group[i].getBoundingClientRect().height);
            }
            for (i = 0; i < group.length; i++) {
                group[i].style.minHeight = Math.ceil(tallest) + 'px';
            }
        }
    }

    // A card whose only link is a placeholder (work in progress, no paper yet)
    // has nothing to open, so it never becomes a menu and never invites a click.
    function markStaticCards() {
        var cards = document.querySelectorAll('.projects-grid .project-card');
        for (var i = 0; i < cards.length; i++) {
            var live = cards[i].querySelectorAll('.project-links a:not(.inactive-link)');
            cards[i].classList.toggle('no-menu', live.length === 0);
        }
    }

    function syncEnabled() {
        var on = enabled();
        for (var i = 0; i < grids.length; i++) {
            grids[i].classList.toggle('hover-menu-on', on);
        }
        if (!on) close();
    }

    for (var g = 0; g < grids.length; g++) {
        (function (grid) {
            grid.addEventListener('click', function (e) {
                if (!enabled()) return;
                // Let a click on one of the (visually hidden) real links run
                // its own course rather than toggling the panel under it.
                if (e.target.closest && e.target.closest('.project-links a')) return;
                var card = cardOf(e.target);
                if (!card) return;
                if (card === activeCard) close();
                else open(card);
            });

            grid.addEventListener('focusin', function (e) {
                var card = cardOf(e.target);
                if (!card) return;
                open(card);
                // Mirror the focus ring onto the matching arc button, so the
                // keyboard user can see where they are on the arc.
                if (!itemsBox || !activeLinks) return;
                var items = itemsBox.children;
                for (var i = 0; i < items.length; i++) {
                    items[i].classList.toggle('is-focus', activeLinks[i] === e.target);
                }
            });

            grid.addEventListener('focusout', function (e) {
                var card = cardOf(e.target);
                if (!card) return;
                if (e.relatedTarget && card.contains(e.relatedTarget)) return;
                close();
            });

        })(grids[g]);
    }

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' && e.keyCode !== 27) return;
        if (lightbox && lightbox.classList.contains('is-open')) { closeLightbox(); return; }
        if (activeCard) { activeCard.blur(); close(); }
    });

    // The panel is pinned to viewport coordinates read when it opened. Now
    // that it is click-opened it should survive a scroll, so the whole stage
    // rides along on one compositor-only transform instead of being rebuilt.
    window.addEventListener('scroll', function () {
        if (!activeCard || scrollRaf) return;
        scrollRaf = requestAnimationFrame(function () {
            scrollRaf = null;
            if (!activeCard) return;
            stage.style.transform =
                'translateY(' + (openScrollY - window.pageYOffset) + 'px)';
        });
    }, { passive: true });

    var fitTimer = null;
    window.addEventListener('resize', function () {
        close();
        syncEnabled();
        // Debounced: card widths only settle once the resize stops.
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(refitCards, 120);
    });

    if (hoverMQ.addEventListener) hoverMQ.addEventListener('change', syncEnabled);
    else if (hoverMQ.addListener) hoverMQ.addListener(syncEnabled);

    // Title alignment runs after the venue fit, because the venue's final
    // font size feeds into the card's layout.
    function refitCards() { fitVenues(); alignCardHeads(); }

    markStaticCards();
    syncEnabled();
    refitCards();
    // Webfonts land after first paint and change the measurement.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refitCards);
})();
