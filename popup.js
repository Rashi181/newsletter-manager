// popup.js
let currentData = [];
let activeCategory = "All";
let activeGroup = null;

const els = {
  statusBar: document.getElementById("status-bar"),
  categoryFilters: document.getElementById("category-filters"),
  list: document.getElementById("newsletter-list"),
  emptyState: document.getElementById("empty-state"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  refreshBtn: document.getElementById("refresh-btn"),
  scanBtn: document.getElementById("scan-btn"),
  backBtn: document.getElementById("back-btn"),
  unsubscribeBtn: document.getElementById("unsubscribe-btn"),
  detailSenderName: document.getElementById("detail-sender-name"),
  detailSenderMeta: document.getElementById("detail-sender-meta"),
  detailMessageList: document.getElementById("detail-message-list"),
  deleteAllBtn: document.getElementById("delete-all-btn"),
  mailModal: document.getElementById("mail-modal"),
  mailModalClose: document.getElementById("mail-modal-close"),
  mailModalSubject: document.getElementById("mail-modal-subject"),
  mailModalMeta: document.getElementById("mail-modal-meta"),
  mailModalBody: document.getElementById("mail-modal-body")
};

// -------------------- INIT --------------------

document.addEventListener("DOMContentLoaded", async () => {
  const cached = await chrome.runtime.sendMessage({ action: "getCached" });
  if (cached.ok && cached.data.newsletters && cached.data.newsletters.length > 0) {
    currentData = cached.data.newsletters;
    renderList();
    setStatus(`Last updated ${timeAgo(cached.data.lastScanned)}`);
  } else {
    els.emptyState.classList.remove("hidden");
  }
});

els.refreshBtn.addEventListener("click", runScan);
els.scanBtn.addEventListener("click", runScan);
els.backBtn.addEventListener("click", showListView);
els.unsubscribeBtn.addEventListener("click", handleUnsubscribeClick);
els.deleteAllBtn.addEventListener("click", handleDeleteAllClick);
els.mailModalClose.addEventListener("click", closeMailModal);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "scanProgress") {
    const p = msg.progress;
    if (p.phase === "listing") {
      setStatus(`Finding emails… ${p.found} found`);
    } else if (p.phase === "fetching") {
      setStatus(`Scanning… ${p.processed}/${p.total}`);
    }
  }
});

// -------------------- SCAN --------------------

async function runScan() {
  els.refreshBtn.classList.add("spinning");
  els.emptyState.classList.add("hidden");
  setStatus("Starting scan…");

  const response = await chrome.runtime.sendMessage({ action: "scan" });

  els.refreshBtn.classList.remove("spinning");

  if (!response.ok) {
    setStatus("Scan failed: " + response.error);
    return;
  }

  currentData = response.data;
  activeCategory = "All";
  renderList();
  setStatus(`Last updated just now`);

  if (currentData.length === 0) {
    els.emptyState.classList.remove("hidden");
  }
}

// -------------------- LIST VIEW --------------------

function getCategories() {
  const cats = new Set(currentData.map((g) => g.category));
  return ["All", ...Array.from(cats).sort()];
}

function renderList() {
  renderCategoryFilters();
  els.list.innerHTML = "";

  const filtered =
    activeCategory === "All"
      ? currentData
      : currentData.filter((g) => g.category === activeCategory);

  if (filtered.length === 0) {
    els.emptyState.classList.remove("hidden");
    return;
  }
  els.emptyState.classList.add("hidden");

  for (const group of filtered) {
    const li = document.createElement("li");
    li.className = "newsletter-item";
    const unreadChip = group.unreadCount > 0
      ? `<span class="unread-count">${group.unreadCount} unread</span>`
      : "";
    li.innerHTML = `
      <div class="newsletter-info">
        <span class="newsletter-name">
          ${group.unreadCount > 0 ? '<span class="unread-badge"></span>' : ""}
          ${escapeHtml(group.senderName)}
        </span>
        <span class="newsletter-meta">
          <span class="category-tag">${escapeHtml(group.category)}</span>
          <span>${escapeHtml(group.senderEmail)}</span>
        </span>
      </div>
      <div style="display:flex;align-items:center">
        ${unreadChip}
        <span class="newsletter-count">${group.count}</span>
      </div>
    `;
    li.addEventListener("click", () => showDetailView(group));
    els.list.appendChild(li);
  }
}

function renderCategoryFilters() {
  els.categoryFilters.innerHTML = "";
  for (const cat of getCategories()) {
    const chip = document.createElement("span");
    chip.className = "category-chip" + (cat === activeCategory ? " active" : "");
    chip.textContent = cat;
    chip.addEventListener("click", () => {
      activeCategory = cat;
      renderList();
    });
    els.categoryFilters.appendChild(chip);
  }
}

// -------------------- DETAIL VIEW --------------------

function showDetailView(group) {
  activeGroup = group;
  els.listView.classList.add("hidden");
  els.detailView.classList.remove("hidden");

  els.detailSenderName.textContent = group.senderName;
  els.detailSenderMeta.textContent = `${group.senderEmail} · ${group.count} emails · ${group.category}`;

  els.unsubscribeBtn.disabled = false;
  els.unsubscribeBtn.textContent = "Unsubscribe";
  els.deleteAllBtn.disabled = false;
  els.deleteAllBtn.textContent = "🗑 Delete All";

  els.detailMessageList.innerHTML = "";
  for (const msg of group.messages) {
    const li = document.createElement("li");
    li.className = "detail-message-item" + (msg.unread ? " is-unread" : "");
    li.style.cursor = "pointer";
    const unreadDot = msg.unread ? '<span class="detail-unread-dot"></span>' : "";
    li.innerHTML = `
      <div class="detail-message-subject">${unreadDot}${escapeHtml(msg.subject || "(no subject)")}</div>
      <div class="detail-message-date">${formatDate(msg.date)}</div>
      <div class="detail-message-snippet">${escapeHtml(msg.snippet || "")}</div>
    `;
    li.addEventListener("click", () => openMailModal(msg));
    els.detailMessageList.appendChild(li);
  }
}

function showListView() {
  els.detailView.classList.add("hidden");
  els.listView.classList.remove("hidden");
  activeGroup = null;
}

// -------------------- UNSUBSCRIBE --------------------

async function handleUnsubscribeClick() {
  if (!activeGroup) return;
  els.unsubscribeBtn.disabled = true;
  els.unsubscribeBtn.textContent = "Working…";

  const response = await chrome.runtime.sendMessage({
    action: "unsubscribe",
    group: activeGroup
  });

  if (response.ok && response.data.success) {
    els.unsubscribeBtn.textContent =
      response.data.method === "one-click"
        ? "Unsubscribed ✓"
        : "Opened unsubscribe page ✓";
    els.unsubscribeBtn.textContent = "Couldn't unsubscribe";
    els.unsubscribeBtn.disabled = false;
  }
}

// -------------------- DELETE --------------------

async function handleDeleteAllClick() {
  if (!activeGroup) return;
  const confirmed = confirm(
    `Delete all ${activeGroup.count} emails from ${activeGroup.senderName}? This moves them to Trash.`
  );
  if (!confirmed) return;

  els.deleteAllBtn.disabled = true;
  els.deleteAllBtn.textContent = "Deleting…";

  const response = await chrome.runtime.sendMessage({
    action: "deleteAll",
    group: activeGroup
  });

  if (response.ok) {
    els.deleteAllBtn.textContent = `Deleted ${response.data.deleted} ✓`;
    currentData = currentData.filter(
      (g) => g.senderEmail !== activeGroup.senderEmail
    );
    setTimeout(() => showListView(), 1200);
  } else {
    els.deleteAllBtn.textContent = "Delete failed";
    els.deleteAllBtn.disabled = false;
  }
}

// -------------------- MAIL READER --------------------

async function openMailModal(msg) {
  els.mailModalSubject.textContent = msg.subject || "(no subject)";
  els.mailModalMeta.textContent = formatDate(msg.date);
  els.mailModalBody.innerHTML = "<p style='color:#aaa'>Loading…</p>";
  els.mailModal.classList.remove("hidden");

  const response = await chrome.runtime.sendMessage({
    action: "fetchMessage",
    messageId: msg.id
  });

  if (!response.ok) {
    els.mailModalBody.innerHTML = "<p style='color:#e33'>Could not load email body.</p>";
    return;
  }

  const { body, from, date } = response.data;
  els.mailModalMeta.textContent = `From: ${from} · ${formatDate(date)}`;

  if (body && body.includes("<")) {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-same-origin";
    iframe.style.cssText = "width:100%;border:none;min-height:400px;";
    els.mailModalBody.innerHTML = "";
    els.mailModalBody.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(body);
    iframe.contentDocument.close();
    iframe.onload = () => {
      iframe.style.height = iframe.contentDocument.body.scrollHeight + "px";
    };
  } else {
    els.mailModalBody.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(body || "No content found.")}</pre>`;
  }
}

function closeMailModal() {
  els.mailModal.classList.add("hidden");
  els.mailModalBody.innerHTML = "";
}

// -------------------- HELPERS --------------------

function setStatus(text) {
  els.statusBar.textContent = text;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(timestamp) {
  if (!timestamp) return "never";
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}