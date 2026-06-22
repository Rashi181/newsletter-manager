// background.js
// This runs in the background and does all the heavy lifting:
// - Auth with Google
// - Fetch emails from Gmail API
// - Detect which ones are newsletters (List-Unsubscribe header)
// - Group them by sender, count them, guess a category
// - Cache results in chrome.storage so popup loads instantly
// - Handle unsubscribe clicks

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

// -------------------- AUTH --------------------
//get token from Google Oauth
function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => { //checks if user signed in or not and checks cached token  
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError?.message || "No token received");
        return;
      }
      resolve(token);
    });
  });
}

// Call this if a request comes back 401 — the cached token may be stale.
function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// -------------------- GMAIL FETCHING --------------------

// Get a page of message IDs matching a search query.
async function listMessageIds(token, query, pageToken) {
  const url = new URL(`${GMAIL_API}/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 401) throw { status: 401 };
  if (!res.ok) throw new Error(`Gmail list failed: ${res.status}`);

  return res.json(); // { messages: [{id, threadId}], nextPageToken }
}

// Get headers for a single message (cheap — metadata only, not full body).
async function getMessageMetadata(token, id) {
  const url = new URL(`${GMAIL_API}/messages/${id}`);
  url.searchParams.set("format", "metadata");
  ["From", "Subject", "Date", "List-Unsubscribe", "List-Unsubscribe-Post"].forEach((h) =>
    url.searchParams.append("metadataHeaders", h)
  );

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 401) throw { status: 401 };
  if (!res.ok) return null;

  return res.json();
}

// Pull out the header value we want, case-insensitively.
function getHeader(headers, name) {
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// Extract a clean sender name + email from a "From" header like:
// "The Hustle" <thehustle@mail.thehustle.co>
function parseSender(fromHeader) {
  if (!fromHeader) return { name: "Unknown sender", email: "unknown" };
  const match = fromHeader.match(/^(.*?)\s*<(.+)>$/);
  if (match) {
    let name = match[1].trim().replace(/^"|"$/g, "");
    return { name: name || match[2], email: match[2].toLowerCase() };
  }
  return { name: fromHeader, email: fromHeader.toLowerCase() };
}

// -------------------- CATEGORIZATION --------------------
// Simple keyword-based categorizer. Checks sender domain/name and subject
// lines against keyword lists. Good enough heuristic without ML.

const CATEGORY_RULES = [
  {
    category: "News",
    keywords: ["news", "times", "post", "herald", "tribune", "daily", "bulletin", "briefing", "morning brew", "the hustle", "axios"]
  },
  {
    category: "Tech",
    keywords: ["tech", "dev", "github", "product hunt", "hacker", "engineering", "stack overflow", "vercel", "ai", "code"]
  },
  {
    category: "Finance",
    keywords: ["finance", "bank", "invest", "money", "market", "trading", "crypto", "wealth", "billing", "invoice", "payment"]
  },
  {
    category: "Shopping",
    keywords: ["amazon", "shop", "store", "deal", "sale", "order", "cart", "ebay", "etsy", "myntra", "flipkart"]
  },
  {
    category: "Social",
    keywords: ["linkedin", "facebook", "twitter", "x.com", "instagram", "reddit", "discord", "slack"]
  },
  {
    category: "Productivity",
    keywords: ["notion", "trello", "asana", "calendar", "zoom", "meet", "jira", "confluence"]
  },
  {
    category: "Entertainment",
    keywords: ["netflix", "spotify", "youtube", "prime video", "hotstar", "music", "podcast", "gaming"]
  },
  {
    category: "Education",
    keywords: ["course", "udemy", "coursera", "university", "school", "learn", "edu", "academy"]
  }
];

function guessCategory(senderName, senderEmail, subject) {
  const haystack = `${senderName} ${senderEmail} ${subject || ""}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => haystack.includes(kw))) {
      return rule.category;
    }
  }
  return "Other";
}

// -------------------- MAIN SCAN --------------------

// Scans the inbox for newsletter-type emails (anything with a
// List-Unsubscribe header is, by definition, a bulk/newsletter sender)
// and groups them by sender.
async function scanInbox(onProgress) {
  let token = await getToken(true);

  // Only look at emails with a List-Unsubscribe header. Gmail search
  // doesn't support filtering by header directly, so we pull a window
  // of recent mail and filter client-side.
  const query = "newer_than:180d";

  let allIds = [];
  let pageToken = undefined;
  let pages = 0;
  const MAX_PAGES = 5; // ~500 emails max, keeps this fast for a v1

  do {
    let listResult;
    try {
      listResult = await listMessageIds(token, query, pageToken);
    } catch (err) {
      if (err.status === 401) {
        await removeCachedToken(token);
        token = await getToken(true);
        listResult = await listMessageIds(token, query, pageToken);
      } else {
        throw err;
      }
    }
    const ids = (listResult.messages || []).map((m) => m.id);
    allIds = allIds.concat(ids);
    pageToken = listResult.nextPageToken;
    pages++;
    if (onProgress) onProgress({ phase: "listing", found: allIds.length });
  } while (pageToken && pages < MAX_PAGES);

  // Fetch metadata for each message. We batch these with a concurrency
  // limit so we don't hammer the API or hit rate limits.
  const CONCURRENCY = 10;
  const newsletterMessages = [];
  let processed = 0;

  async function worker(queue) {
    while (queue.length > 0) {
      const id = queue.pop();
      let data;
      try {
        data = await getMessageMetadata(token, id);
      } catch (err) {
        if (err && err.status === 401) {
          await removeCachedToken(token);
          token = await getToken(true);
          data = await getMessageMetadata(token, id);
        }
      }
      processed++;
      if (onProgress && processed % 10 === 0) {
        onProgress({ phase: "fetching", processed, total: allIds.length });
      }

      if (!data || !data.payload) continue;
      const headers = data.payload.headers || [];
      const listUnsub = getHeader(headers, "List-Unsubscribe");
      if (!listUnsub) continue; // not a newsletter/bulk sender

      newsletterMessages.push({
        id: data.id,
        threadId: data.threadId,
        from: getHeader(headers, "From"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        snippet: data.snippet || "",
        listUnsubscribe: listUnsub,
        oneClick: !!getHeader(headers, "List-Unsubscribe-Post")
      });
    }
  }

  const queue = [...allIds];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  // Group by sender email
  const groups = {};
  for (const msg of newsletterMessages) {
    const { name, email } = parseSender(msg.from);
    if (!groups[email]) {
      groups[email] = {
        senderEmail: email,
        senderName: name,
        category: guessCategory(name, email, msg.subject),
        count: 0,
        listUnsubscribe: msg.listUnsubscribe,
        oneClick: msg.oneClick,
        messages: []
      };
    }
    groups[email].count++;
    groups[email].messages.push({
      id: msg.id,
      threadId: msg.threadId,
      subject: msg.subject,
      date: msg.date,
      snippet: msg.snippet
    });
  }

  // Sort each group's messages newest first
  Object.values(groups).forEach((g) => {
    g.messages.sort((a, b) => new Date(b.date) - new Date(a.date));
  });

  const result = Object.values(groups).sort((a, b) => b.count - a.count);

  // Cache it so the popup can show data instantly next time,
  // with a timestamp so we know how fresh it is.
  await chrome.storage.local.set({
    newsletters: result,
    lastScanned: Date.now()
  });

  return result;
}

// -------------------- UNSUBSCRIBE --------------------

// Parses a List-Unsubscribe header value like:
// "<https://example.com/unsub?id=123>, <mailto:unsub@example.com>"
function parseUnsubscribeLinks(headerValue) {
  const matches = [...headerValue.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  return {
    http: matches.find((l) => l.startsWith("http")),
    mailto: matches.find((l) => l.startsWith("mailto"))
  };
}

async function unsubscribe(group) {
  const { http, mailto } = parseUnsubscribeLinks(group.listUnsubscribe);

  // RFC 8058 one-click unsubscribe: POST to the link, no tab needed.
  if (group.oneClick && http) {
    try {
      const res = await fetch(http, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click"
      });
      return { method: "one-click", success: res.ok };
    } catch (e) {
      // fall through to opening the link manually
    }
  }

  if (http) {
    chrome.tabs.create({ url: http });
    return { method: "link", success: true };
  }
  if (mailto) {
    chrome.tabs.create({ url: mailto });
    return { method: "mailto", success: true };
  }
  return { method: "none", success: false };
}
// -------------------- DELETE --------------------

async function deleteAllFromSender(group) {
  let token = await getToken(false); // non-interactive — user already authed
  let deleted = 0;

  for (const msg of group.messages) {
    try {
      const res = await fetch(`${GMAIL_API}/messages/${msg.id}/trash`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) deleted++;
    } catch (e) {
      // skip failed individual deletes, continue with rest
    }
  }

  // Update cache to remove this sender
  const cached = await chrome.storage.local.get("newsletters");
  if (cached.newsletters) {
    const updated = cached.newsletters.filter(
      (g) => g.senderEmail !== group.senderEmail
    );
    await chrome.storage.local.set({ newsletters: updated });
  }

  return { deleted, total: group.messages.length };
}

// -------------------- FETCH FULL EMAIL --------------------

async function fetchFullMessage(messageId) {
  let token = await getToken(false);

  const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) throw new Error(`Failed to fetch message: ${res.status}`);
  const data = await res.json();

  // Extract body — emails can be plain text, HTML, or multipart.
  // We walk the payload parts to find the best version.
  function extractBody(payload) {
    if (!payload) return "";

    // Single-part message
    if (payload.body?.data) {
      return decodeBase64(payload.body.data);
    }

    // Multipart — prefer text/html, fall back to text/plain
    if (payload.parts) {
      let plainText = "";
      let htmlText = "";
      for (const part of payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          htmlText = decodeBase64(part.body.data);
        } else if (part.mimeType === "text/plain" && part.body?.data) {
          plainText = decodeBase64(part.body.data);
        } else if (part.parts) {
          // nested multipart
          const nested = extractBody(part);
          if (nested) htmlText = htmlText || nested;
        }
      }
      return htmlText || plainText;
    }

    return "";
  }

  function decodeBase64(data) {
    // Gmail uses URL-safe base64
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    try {
      return decodeURIComponent(
        atob(base64)
          .split("")
          .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
    } catch {
      return atob(base64);
    }
  }

  const headers = data.payload?.headers || [];
  return {
    subject: getHeader(headers, "Subject"),
    from: getHeader(headers, "From"),
    date: getHeader(headers, "Date"),
    body: extractBody(data.payload)
  };
}
// -------------------- MESSAGE ROUTER --------------------
// The popup talks to this background script via chrome.runtime.sendMessage.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "scan") {
    scanInbox((progress) => {
      chrome.runtime.sendMessage({ action: "scanProgress", progress }).catch(() => {});
    })
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for async response
  }

  if (request.action === "unsubscribe") {
    unsubscribe(request.group)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (request.action === "getCached") {
    chrome.storage.local.get(["newsletters", "lastScanned"]).then((data) => {
      sendResponse({ ok: true, data });
    });
    return true;
  }
  if (request.action === "deleteAll") {
    deleteAllFromSender(request.group)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (request.action === "fetchMessage") {
    fetchFullMessage(request.messageId)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
