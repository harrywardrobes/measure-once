// ── Ideas & Feedback ──────────────────────────────────────────────────────────

let _ideas = [];
let _expandedIdeaId = null;
let _commentsCache = {};

function ideaSkeletonHtml() {
  return `
    <div class="idea-card idea-card-skeleton">
      <div class="idea-card-body">
        <div class="skeleton-line" style="height:13px;width:72%;margin-bottom:8px"></div>
        <div class="skeleton-line" style="height:13px;width:88%"></div>
        <div class="skeleton-line" style="height:13px;width:55%;margin-top:6px"></div>
      </div>
      <div class="idea-card-meta">
        <div class="skeleton-line" style="height:11px;width:90px"></div>
        <div class="skeleton-line" style="height:11px;width:60px"></div>
      </div>
    </div>`;
}

async function loadIdeas() {
  const list = document.getElementById('ideas-list');
  if (!list) return;

  list.innerHTML = [1, 2, 3].map(ideaSkeletonHtml).join('');

  try {
    _ideas = await GET('/api/ideas');
    renderIdeas();
  } catch (e) {
    list.innerHTML = `
      <div class="ideas-empty">
        <p>Could not load ideas — ${escHtml(e.message)}</p>
        <button onclick="loadIdeas()" class="ideas-retry-btn">Retry</button>
      </div>`;
  }
}

function renderIdeas() {
  const list = document.getElementById('ideas-list');
  if (!list) return;

  if (!_ideas.length) {
    list.innerHTML = `
      <div class="ideas-empty">
        <svg width="36" height="36" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--stone-deep);margin-bottom:10px">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
        </svg>
        <p>No ideas yet — be the first to share one!</p>
      </div>`;
    return;
  }

  list.innerHTML = _ideas.map(ideaCardHtml).join('');

  list.querySelectorAll('.idea-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id, 10);
      toggleComments(id);
    });
  });

  if (_expandedIdeaId !== null) {
    const section = document.getElementById(`idea-comments-${_expandedIdeaId}`);
    if (section) section.style.display = '';
  }
}

function ideaCardHtml(idea) {
  const id       = idea.id;
  const body     = escHtml(idea.body);
  const author   = escHtml(idea.author_name);
  const count    = idea.comment_count || 0;
  const countLbl = count === 1 ? '1 comment' : `${count} comments`;
  const isExpanded = _expandedIdeaId === id;

  const commentsHtml = isExpanded
    ? buildCommentsSection(id)
    : `<div class="idea-comments-section" id="idea-comments-${id}" style="display:none">${buildCommentsSection(id)}</div>`;

  return `
    <div class="idea-card" id="idea-${id}">
      <div class="idea-card-body">${body}</div>
      <div class="idea-card-meta">
        <span class="idea-author">${author}</span>
        <button class="idea-toggle-btn" data-id="${id}" aria-expanded="${isExpanded}">
          <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
          ${countLbl}
        </button>
      </div>
      ${isExpanded
        ? `<div class="idea-comments-section" id="idea-comments-${id}">${buildCommentsSection(id)}</div>`
        : `<div class="idea-comments-section" id="idea-comments-${id}" style="display:none"></div>`}
    </div>`;
}

function buildCommentsSection(ideaId) {
  const comments = _commentsCache[ideaId];

  let commentsHtml = '';
  if (!comments) {
    commentsHtml = `<div class="idea-comments-loading"><div class="spinner spinner-sm"></div> Loading…</div>`;
  } else if (!comments.length) {
    commentsHtml = `<div class="idea-comments-empty">No comments yet.</div>`;
  } else {
    commentsHtml = comments.map(c => `
      <div class="idea-comment">
        <span class="idea-comment-author">${escHtml(c.author_name)}</span>
        <span class="idea-comment-body">${escHtml(c.body)}</span>
      </div>`).join('');
  }

  return `
    <div class="idea-comments-list" id="idea-comments-list-${ideaId}">${commentsHtml}</div>
    <form class="idea-reply-form" id="idea-reply-form-${ideaId}">
      <input
        type="text"
        class="idea-reply-input"
        id="idea-reply-input-${ideaId}"
        placeholder="Add a comment…"
        required
        autocomplete="off"
      >
      <button type="submit" class="idea-reply-btn" id="idea-reply-btn-${ideaId}">Reply</button>
    </form>`;
}

async function toggleComments(ideaId) {
  const section = document.getElementById(`idea-comments-${ideaId}`);
  const btn     = document.querySelector(`.idea-toggle-btn[data-id="${ideaId}"]`);
  if (!section) return;

  const isVisible = section.style.display !== 'none';

  if (isVisible) {
    section.style.display = 'none';
    if (btn) btn.setAttribute('aria-expanded', 'false');
    _expandedIdeaId = null;
    return;
  }

  _expandedIdeaId = ideaId;
  section.style.display = '';
  if (btn) btn.setAttribute('aria-expanded', 'true');

  if (_commentsCache[ideaId]) {
    section.innerHTML = buildCommentsSection(ideaId);
    attachReplyHandler(ideaId);
    return;
  }

  section.innerHTML = `<div class="idea-comments-list"><div class="idea-comments-loading"><div class="spinner spinner-sm"></div> Loading…</div></div>`;

  try {
    const comments = await GET(`/api/ideas/${ideaId}/comments`);
    _commentsCache[ideaId] = comments;
    section.innerHTML = buildCommentsSection(ideaId);
    attachReplyHandler(ideaId);
  } catch (e) {
    section.innerHTML = `<div class="idea-comments-list"><div class="idea-comments-empty">Could not load comments.</div></div>`;
  }
}

function attachReplyHandler(ideaId) {
  const form = document.getElementById(`idea-reply-form-${ideaId}`);
  if (form && !form._bound) {
    form._bound = true;
    form.addEventListener('submit', e => submitComment(e, ideaId));
  }
}

async function submitComment(e, ideaId) {
  e.preventDefault();
  const input = document.getElementById(`idea-reply-input-${ideaId}`);
  const btn   = document.getElementById(`idea-reply-btn-${ideaId}`);
  const body  = (input?.value || '').trim();
  if (!body) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }

  try {
    const comment = await POST(`/api/ideas/${ideaId}/comments`, { body });
    if (!_commentsCache[ideaId]) _commentsCache[ideaId] = [];
    _commentsCache[ideaId].push(comment);

    const idea = _ideas.find(i => i.id === ideaId);
    if (idea) idea.comment_count = (_commentsCache[ideaId] || []).length;

    const listEl = document.getElementById(`idea-comments-list-${ideaId}`);
    if (listEl) {
      const emptyEl = listEl.querySelector('.idea-comments-empty');
      if (emptyEl) emptyEl.remove();

      const commentEl = document.createElement('div');
      commentEl.className = 'idea-comment';
      commentEl.innerHTML = `
        <span class="idea-comment-author">${escHtml(comment.author_name)}</span>
        <span class="idea-comment-body">${escHtml(comment.body)}</span>`;
      listEl.appendChild(commentEl);
    }

    const toggleBtn = document.querySelector(`.idea-toggle-btn[data-id="${ideaId}"]`);
    if (toggleBtn) {
      const cnt = _commentsCache[ideaId].length;
      toggleBtn.innerHTML = `
        <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
        </svg>
        ${cnt === 1 ? '1 comment' : `${cnt} comments`}`;
    }

    if (input) input.value = '';
  } catch (err) {
    showToast(err.message || 'Could not post comment.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Reply'; }
  }
}

async function submitIdea(e) {
  e.preventDefault();
  const input = document.getElementById('ideas-input');
  const btn   = document.getElementById('ideas-submit-btn');
  const body  = (input?.value || '').trim();
  if (!body) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }

  try {
    const idea = await POST('/api/ideas', { body });
    _ideas.unshift(idea);
    _commentsCache[idea.id] = [];
    if (input) input.value = '';
    renderIdeas();
    showToast('Idea posted!');
  } catch (err) {
    showToast(err.message || 'Could not post idea.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
      </svg>
      Post idea`; }
  }
}
