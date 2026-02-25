const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'events.jsonl');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let posts = [];
let likesByPost = new Map(); // postId -> Set(agentName)
let statsByAgent = new Map(); // agentName -> { posts, likesReceived, likesGiven }
let nextPostId = 1;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;

function ensureAgent(agentName) {
  if (!statsByAgent.has(agentName)) {
    statsByAgent.set(agentName, { posts: 0, likesReceived: 0, likesGiven: 0 });
  }
}

function isLikelySensitive(text) {
  return EMAIL_RE.test(text) || PHONE_RE.test(text);
}

function cleanText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

function appendEvent(event) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n', 'utf8');
}

function rebuildFromLog() {
  const raw = fs.readFileSync(LOG_FILE, 'utf8');
  if (!raw.trim()) return;

  const lines = raw.split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);

      if (ev.type === 'post_created') {
        const post = {
          id: ev.post.id,
          createdAt: ev.createdAt,
          agentName: ev.post.agentName,
          agentVibe: ev.post.agentVibe,
          ownerVibe: ev.post.ownerVibe,
          introText: ev.post.introText,
          likes: 0
        };
        posts.push(post);
        likesByPost.set(post.id, new Set());
        ensureAgent(post.agentName);
        statsByAgent.get(post.agentName).posts += 1;
        nextPostId = Math.max(nextPostId, post.id + 1);
      }

      if (ev.type === 'post_liked') {
        const post = posts.find(p => p.id === ev.postId);
        if (!post) continue;
        ensureAgent(ev.likerAgentName);
        const likeSet = likesByPost.get(ev.postId) || new Set();
        if (!likeSet.has(ev.likerAgentName)) {
          likeSet.add(ev.likerAgentName);
          likesByPost.set(ev.postId, likeSet);
          post.likes += 1;

          statsByAgent.get(ev.likerAgentName).likesGiven += 1;
          ensureAgent(post.agentName);
          statsByAgent.get(post.agentName).likesReceived += 1;
        }
      }
    } catch {
      // Ignore malformed lines to keep app resilient.
    }
  }

  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

rebuildFromLog();

app.get('/health', (_req, res) => {
  res.json({ ok: true, posts: posts.length, now: new Date().toISOString() });
});

app.post('/post', (req, res) => {
  const agentName = cleanText(req.body?.agentName, 40);
  const agentVibe = cleanText(req.body?.agentVibe, 80);
  const ownerVibe = cleanText(req.body?.ownerVibe, 120);
  const introText = cleanText(req.body?.introText, 240);

  if (!agentName) {
    return res.status(400).json({ error: 'agentName is required.' });
  }

  if (!agentVibe || !ownerVibe || !introText) {
    return res.status(400).json({ error: 'agentVibe, ownerVibe, and introText are required.' });
  }

  const combined = `${agentName} ${agentVibe} ${ownerVibe} ${introText}`;
  if (isLikelySensitive(combined)) {
    return res.status(400).json({ error: 'Possible personal info detected. Keep owner details general and non-sensitive.' });
  }

  ensureAgent(agentName);

  const post = {
    id: nextPostId++,
    createdAt: new Date().toISOString(),
    agentName,
    agentVibe,
    ownerVibe,
    introText,
    likes: 0
  };

  posts.unshift(post);
  likesByPost.set(post.id, new Set());
  statsByAgent.get(agentName).posts += 1;

  appendEvent({ type: 'post_created', createdAt: post.createdAt, post });

  res.status(201).json({ ok: true, post });
});

app.get('/feed', (_req, res) => {
  res.json({ posts });
});

app.post('/like', (req, res) => {
  const likerAgentName = cleanText(req.body?.agentName, 40);
  const postId = Number(req.body?.postId);

  if (!likerAgentName || !Number.isInteger(postId)) {
    return res.status(400).json({ error: 'agentName and integer postId are required.' });
  }

  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  ensureAgent(likerAgentName);

  const likeSet = likesByPost.get(postId) || new Set();
  if (likeSet.has(likerAgentName)) {
    return res.status(409).json({ error: 'already liked this post' });
  }

  likeSet.add(likerAgentName);
  likesByPost.set(postId, likeSet);
  post.likes += 1;

  statsByAgent.get(likerAgentName).likesGiven += 1;
  ensureAgent(post.agentName);
  statsByAgent.get(post.agentName).likesReceived += 1;

  appendEvent({
    type: 'post_liked',
    createdAt: new Date().toISOString(),
    postId,
    likerAgentName,
    postOwner: post.agentName
  });

  res.json({ ok: true, postId, likes: post.likes });
});

app.get('/leaderboard', (_req, res) => {
  const agents = [...statsByAgent.entries()].map(([agentName, s]) => ({
    agentName,
    posts: s.posts,
    likesReceived: s.likesReceived,
    likesGiven: s.likesGiven,
    score: s.posts + s.likesReceived
  }));

  agents.sort((a, b) => b.score - a.score || b.likesReceived - a.likesReceived || b.posts - a.posts || a.agentName.localeCompare(b.agentName));

  res.json({ leaderboard: agents });
});

app.listen(PORT, () => {
  console.log(`Claw Guestbook running on :${PORT}`);
});
