// ── ERC-8004 + x402 Demo — Client JS ──────────────────────────────────────

const BASESCAN = "https://sepolia.basescan.org";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

// ── State ────────────────────────────────────────────────────────────────────
let activeTab = "prompt";
let uploadedFile = null;
let isProcessing = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const generateBtn     = document.getElementById("generate-btn");
const promptInput     = document.getElementById("prompt-input");
const accessTokenInput = document.getElementById("access-token");
const terminalSection = document.getElementById("terminal-section");
const terminalBody    = document.getElementById("terminal-body");
const progressBar     = document.getElementById("progress-bar");
const stepText        = document.getElementById("step-text");
const resultsSection  = document.getElementById("results-section");
const inputImage      = document.getElementById("input-image");
const outputImage     = document.getElementById("output-image");
const inputMeta       = document.getElementById("input-meta");
const outputMeta      = document.getElementById("output-meta");
const proofItems      = document.getElementById("proof-items");
const agentIdentityEl = document.getElementById("agent-identity");
const repBody         = document.getElementById("rep-body");
const refreshRepBtn   = document.getElementById("refresh-rep");
const fileInput       = document.getElementById("file-input");
const dropzone        = document.getElementById("dropzone");
const dropzonePreview = document.getElementById("dropzone-preview");
const dropzoneContent = dropzone.querySelector(".dropzone-content");
const previewImg      = document.getElementById("preview-img");
const removeFileBtn   = document.getElementById("remove-file");

// ── Tabs ─────────────────────────────────────────────────────────────────────
const tabs = Array.from(document.querySelectorAll(".tab"));

function activateTab(tab) {
  tabs.forEach(t => {
    const selected = t === tab;
    t.classList.toggle("active", selected);
    t.setAttribute("aria-selected", String(selected));
    t.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));

  activeTab = tab.dataset.tab;
  document.getElementById(`panel-${activeTab}`).classList.add("active");
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();

    let nextIndex = index;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;

    activateTab(tabs[nextIndex]);
    tabs[nextIndex].focus();
  });
});

// ── Example prompts ───────────────────────────────────────────────────────────
document.querySelectorAll(".example-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    promptInput.value = chip.dataset.prompt;
    promptInput.focus();
  });
});

// ── File upload ───────────────────────────────────────────────────────────────
function revokePreviewUrl() {
  if (previewImg.src.startsWith("blob:")) URL.revokeObjectURL(previewImg.src);
}

function setUploadedFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  uploadedFile = file;
  revokePreviewUrl();

  const url = URL.createObjectURL(file);
  previewImg.src = url;
  dropzoneContent.classList.add("hidden");
  dropzonePreview.classList.remove("hidden");
}

function clearUploadedFile() {
  uploadedFile = null;
  revokePreviewUrl();
  previewImg.src = "";
  dropzoneContent.classList.remove("hidden");
  dropzonePreview.classList.add("hidden");
  fileInput.value = "";
}

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) setUploadedFile(fileInput.files[0]);
});

removeFileBtn.addEventListener("click", e => {
  e.stopPropagation();
  clearUploadedFile();
});

dropzone.addEventListener("click", event => {
  if (!event.target.closest("label, input, button")) fileInput.click();
});
dropzone.addEventListener("keydown", event => {
  if (event.target !== dropzone || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  fileInput.click();
});

dropzone.addEventListener("dragover", e => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) setUploadedFile(file);
});

// ── Terminal log helpers ──────────────────────────────────────────────────────
function clearTerminal() {
  terminalBody.innerHTML = "";
  setProgress(0, 5);
}

function logLine(message, type = "normal") {
  const span = document.createElement("span");

  if (type === "step") {
    span.className = "log-step";
  } else {
    span.className = "log-line";
    if (message.startsWith("✓") || message.startsWith("→ ✓")) span.classList.add("log-ok");
    else if (message.startsWith("⚠") || message.startsWith("→ ⚠")) span.classList.add("log-warn");
    else if (message.startsWith("✗")) span.classList.add("log-error");
  }

  span.textContent = message;
  terminalBody.appendChild(span);
  terminalBody.scrollTop = terminalBody.scrollHeight;
}

function setProgress(n, total) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  stepText.textContent = `${n} / ${total}`;
}

// ── Image display ─────────────────────────────────────────────────────────────
function showInputImage(dataUrl) {
  inputImage.src = dataUrl;
  inputImage.classList.remove("hidden");
}

function showOutputImage(dataUrl) {
  outputImage.src = dataUrl;
  outputImage.classList.remove("hidden");
  outputMeta.textContent = "Base Sepolia · $0.01 USDC paid";
}

// ── Proof panel ───────────────────────────────────────────────────────────────
function buildProofPanel({ paymentTxHash, requestHash, validationTxHash,
                            validationResponseTxHash, agentId, agentIdentifier }) {
  proofItems.innerHTML = "";

  // x402 Payment
  addProofItem(
    "x402 Payment",
    paymentTxHash,
    paymentTxHash && !paymentTxHash.startsWith("MOCK") && paymentTxHash !== "pending"
      ? `${BASESCAN}/tx/${paymentTxHash}`
      : null,
    paymentTxHash?.startsWith("MOCK") ? "mock" : null
  );

  // Validation request
  addProofItem("Validation Commitment", requestHash ?? null, null);

  addProofItem(
    "Validation Request",
    validationTxHash ?? null,
    validationTxHash ? `${BASESCAN}/tx/${validationTxHash}` : null
  );

  // Validation response
  addProofItem(
    "Validation Response",
    validationResponseTxHash ?? null,
    validationResponseTxHash ? `${BASESCAN}/tx/${validationResponseTxHash}` : null,
    !validationResponseTxHash ? "skipped" : null
  );

  // Agent identity
  if (agentIdentifier) {
    agentIdentityEl.innerHTML = `
      <div class="agent-identity-label">Agent Identity</div>
      <div class="agent-identity-id">
        <a class="proof-link" href="${BASESCAN}/token/${IDENTITY_REGISTRY}/instance/${agentId}" target="_blank" rel="noopener">
          agentId #${agentId} <span class="proof-link-icon">↗</span>
        </a>
        <br/><span style="font-size:10px;color:var(--text-3)">${agentIdentifier}</span>
      </div>`;
  }
}

function addProofItem(label, value, href, modifier) {
  const item = document.createElement("div");
  item.className = "proof-item";

  const labelEl = document.createElement("div");
  labelEl.className = "proof-item-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "proof-item-value";

  if (modifier === "mock") {
    valueEl.innerHTML = `<span class="proof-skipped">⚠ Mock transaction</span>`;
  } else if (modifier === "skipped") {
    valueEl.innerHTML = `<span class="proof-skipped">⚠ Not submitted</span>`;
  } else if (!value) {
    valueEl.innerHTML = `<span class="proof-skipped">—</span>`;
  } else if (href) {
    const short = `${value.slice(0, 10)}…${value.slice(-6)}`;
    valueEl.innerHTML = `
      <a class="proof-link" href="${href}" target="_blank" rel="noopener">
        <span>${short}</span>
        <span class="proof-link-icon">↗</span>
      </a>`;
  } else {
    valueEl.textContent = value;
  }

  item.appendChild(labelEl);
  item.appendChild(valueEl);
  proofItems.appendChild(item);
}

// ── Reputation ────────────────────────────────────────────────────────────────
async function loadReputation() {
  repBody.innerHTML = `<div class="rep-loading">Loading on-chain data…</div>`;

  try {
    const res = await fetch("/api/reputation");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    const rate = Math.max(0, Math.min(100, data.successRate));

    repBody.innerHTML = `
      <div class="rep-content">
        <div class="rep-stats">
          <div class="rep-stat">
            <div class="rep-stat-value">${data.totalCalls}</div>
            <div class="rep-stat-label">Total Calls</div>
          </div>
          <div class="rep-stat">
            <div class="rep-stat-value" style="color:${rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--orange)' : 'var(--red)'}">${rate}%</div>
            <div class="rep-stat-label">Success Rate</div>
          </div>
          <div class="rep-stat">
            <div class="rep-stat-value" style="font-size:18px">#${data.agentId}</div>
            <div class="rep-stat-label">Agent ID</div>
          </div>
        </div>

        <div class="rep-bar-wrap">
          <div class="rep-bar-label">
            <span>Success Rate — tag: successRate</span>
            <span>${rate}%</span>
          </div>
          <div class="rep-bar-track">
            <div class="rep-bar-fill" style="width: 0%" data-target="${rate}"></div>
          </div>
        </div>

        <div class="rep-agent-info">
          <strong style="color:var(--text-2)">${data.agentName}</strong><br/>
          ${data.agentIdentifier}<br/>
          <a href="${BASESCAN}/address/0x8004B663056A597Dffe9eCcC1965A193B7388713" target="_blank" rel="noopener">
            ReputationRegistry ↗
          </a>
          &nbsp;·&nbsp;
          <a href="${BASESCAN}/token/${IDENTITY_REGISTRY}/instance/${data.agentId}" target="_blank" rel="noopener">
            NFT #${data.agentId} ↗
          </a>
        </div>
      </div>`;

    // Animate the bar after render
    requestAnimationFrame(() => {
      const fill = repBody.querySelector(".rep-bar-fill");
      if (fill) fill.style.width = fill.dataset.target + "%";
    });

  } catch (err) {
    repBody.innerHTML = `
      <div class="rep-loading">
        ⚠ Could not load reputation: ${err.message}<br/>
        <button class="btn btn-outline btn-sm" onclick="loadReputation()" style="margin-top:12px">Retry</button>
      </div>`;
  }
}

// ── Button state ──────────────────────────────────────────────────────────────
function setLoading(loading) {
  isProcessing = loading;
  generateBtn.disabled = loading;
  generateBtn.classList.toggle("loading", loading);
}

// ── SSE stream reader ─────────────────────────────────────────────────────────
async function readSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let receivedTerminalEvent = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? ""; // keep incomplete event

    for (const rawEvent of events) {
      const lines = rawEvent.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "done" || event.type === "error") receivedTerminalEvent = true;
          handleSSEEvent(event);
        } catch {
          // malformed JSON — ignore
        }
      }
    }
  }

  if (!receivedTerminalEvent) {
    logLine("✗ Connection closed before the operation completed.", "normal");
    setLoading(false);
  }
}

// ── SSE event handler ─────────────────────────────────────────────────────────
function handleSSEEvent(event) {
  switch (event.type) {

    case "step":
      setProgress(event.n, event.total);
      logLine(`[${event.n}/${event.total}] ${event.label}`, "step");
      break;

    case "log":
      logLine(event.message);
      break;

    case "input_image":
      showInputImage(event.data);
      break;

    case "output_image":
      showOutputImage(event.data);
      // Make results section visible as soon as we have output
      resultsSection.classList.remove("hidden");
      break;

    case "proof":
      buildProofPanel(event);
      break;

    case "done":
      setProgress(5, 5);
      logLine("✓ Done!", "step");
      setLoading(false);
      // Refresh reputation after successful run
      setTimeout(loadReputation, 2000);
      break;

    case "error":
      logLine(`✗ Error: ${event.message}`, "normal");
      terminalBody.querySelector(".log-line:last-child")?.classList.add("log-error");
      setLoading(false);
      break;
  }
}

// ── Main: handle form submit ──────────────────────────────────────────────────
generateBtn.addEventListener("click", async () => {
  if (isProcessing) return;

  // Validate input
  if (activeTab === "prompt" && !promptInput.value.trim()) {
    promptInput.focus();
    promptInput.style.borderColor = "var(--red)";
    setTimeout(() => promptInput.style.borderColor = "", 1500);
    return;
  }
  if (activeTab === "upload" && !uploadedFile) {
    dropzone.style.borderColor = "var(--red)";
    setTimeout(() => dropzone.style.borderColor = "", 1500);
    return;
  }

  // Reset UI
  setLoading(true);
  clearTerminal();
  terminalSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  inputImage.src = "";
  outputImage.src = "";
  proofItems.innerHTML = "";
  agentIdentityEl.innerHTML = "";

  inputMeta.textContent =
    activeTab === "upload" ? "Uploaded image · optimized PNG" : "GPT Image 2 · optimized PNG";

  // Scroll to terminal while respecting reduced-motion preferences.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  terminalSection.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });

  // Build request
  let response;
  const serviceToken = accessTokenInput.value.trim();
  const authHeaders = serviceToken ? { "x-service-token": serviceToken } : {};
  try {
    if (activeTab === "upload" && uploadedFile) {
      const formData = new FormData();
      formData.append("image", uploadedFile);
      response = await fetch("/api/process", {
        method: "POST",
        headers: authHeaders,
        body: formData,
      });
    } else {
      response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ prompt: promptInput.value.trim() }),
      });
    }

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      let detail = "";
      if (contentType.includes("application/json")) {
        const body = await response.json().catch(() => ({}));
        detail = typeof body.error === "string" ? body.error : "";
      } else {
        detail = (await response.text().catch(() => "")).trim();
      }
      throw new Error(detail || `Server error: HTTP ${response.status}`);
    }

    await readSSEStream(response);

  } catch (err) {
    logLine(`✗ ${err.message}`, "normal");
    const last = terminalBody.querySelector(".log-line:last-child");
    if (last) last.classList.add("log-error");
    setLoading(false);
  }
});

// Allow Enter (Ctrl+Enter or Cmd+Enter) to submit
promptInput.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    generateBtn.click();
  }
});

// ── Refresh reputation ────────────────────────────────────────────────────────
refreshRepBtn.addEventListener("click", loadReputation);

// ── Init ──────────────────────────────────────────────────────────────────────
loadReputation();
