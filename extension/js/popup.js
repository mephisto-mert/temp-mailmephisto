const GUERRILLA_API = "https://api.guerrillamail.com/ajax.php";
const MAIL_TM_API = "https://api.mail.tm";
const MAIL_GW_API = "https://api.mail.gw";

let currentAccount = null;
let pollInterval = null;
let cachedMessages = new Map();

const stateLoading = document.getElementById("stateLoading");
const loadingText = document.getElementById("loadingText");
const stateNoAccount = document.getElementById("stateNoAccount");
const createError = document.getElementById("createError");
const stateActive = document.getElementById("stateActive");
const stateMessageDetail = document.getElementById("stateMessageDetail");
const btnCreate = document.getElementById("btnCreate");
const emailAddressInput = document.getElementById("emailAddress");
const btnCopy = document.getElementById("btnCopy");
const btnRefresh = document.getElementById("btnRefresh");
const btnDelete = document.getElementById("btnDelete");
const msgCount = document.getElementById("msgCount");
const messageList = document.getElementById("messageList");
const btnBackToInbox = document.getElementById("btnBackToInbox");
const detailFrom = document.getElementById("detailFrom");
const detailSubject = document.getElementById("detailSubject");
const detailLoading = document.getElementById("detailLoading");
const detailFrame = document.getElementById("detailFrame");

const showState = (stateNode) => {
    stateLoading.classList.add("hidden");
    stateNoAccount.classList.add("hidden");
    stateActive.classList.add("hidden");
    stateMessageDetail.classList.add("hidden");
    stateNode.classList.remove("hidden");
};

const showError = (msg) => {
    if (createError) {
        createError.textContent = msg;
        createError.classList.remove("hidden");
    }
};

const clearError = () => {
    if (createError) {
        createError.textContent = "";
        createError.classList.add("hidden");
    }
};

const generateRandomString = (length = 10) => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => chars[value % chars.length]).join("");
};

const extractOTP = (text) => {
    if (!text) return null;
    const match = String(text).match(/\b\d{4,8}\b|\b[A-Z0-9]{6}\b/);
    return match ? match[0] : null;
};

// ── Storage Helpers (RAM-only Session Storage for Security) ──
const saveAccountToStorage = async (account) => {
    try {
        if (chrome.storage?.session) {
            await chrome.storage.session.set({ mephistoAccount: account });
        }
    } catch {}
};

const getAccountFromStorage = async () => {
    try {
        if (chrome.storage?.session) {
            const res = await chrome.storage.session.get(["mephistoAccount"]);
            if (res?.mephistoAccount?.address) return res.mephistoAccount;
        }
    } catch {}
    return null;
};

const removeAccountFromStorage = async () => {
    try {
        if (chrome.storage?.session) await chrome.storage.session.remove(["mephistoAccount"]);
    } catch {}
};

// ── Provider 1: Guerrilla Mail (Primary & Fastest) ──
const createGuerrillaMailbox = async () => {
    const res = await fetch(`${GUERRILLA_API}?f=get_email_address`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Guerrilla HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.email_addr || !data?.sid_token) throw new Error("Invalid Guerrilla response");

    return {
        id: data.sid_token,
        address: data.email_addr,
        provider: 'guerrilla',
        token: data.sid_token,
        createdAt: Date.now()
    };
};

const fetchGuerrillaMessages = async (token) => {
    const res = await fetch(`${GUERRILLA_API}?f=get_email_list&offset=0&sid_token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Guerrilla fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.list) ? data.list : [];

    return list.map(m => ({
        id: String(m.mail_id),
        from: { name: m.mail_from || 'Unknown', address: m.mail_from || '' },
        subject: m.mail_subject || '(No subject)',
        intro: m.mail_excerpt || '',
        date: m.mail_date || '',
        seen: m.mail_read === 1 || m.mail_read === '1',
        rawBody: m.mail_body || ''
    }));
};

const fetchGuerrillaDetail = async (token, id) => {
    const res = await fetch(`${GUERRILLA_API}?f=fetch_email&email_id=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Guerrilla detail failed: HTTP ${res.status}`);
    const data = await res.json();
    return {
        from: data.mail_from || '',
        subject: data.mail_subject || '(No subject)',
        html: data.mail_body || '',
        text: data.mail_excerpt || ''
    };
};

// ── Provider 2: Hydra (Mail.tm / Mail.gw Fallback) ──
const createHydraMailbox = async (apiBase) => {
    const domainRes = await fetch(`${apiBase}/domains`, { cache: 'no-store' });
    if (!domainRes.ok) throw new Error(`${apiBase} domains failed: HTTP ${domainRes.status}`);
    const domainsData = await domainRes.json();
    const members = domainsData['hydra:member'];
    if (!Array.isArray(members) || !members[0]?.domain) throw new Error("No Hydra domain available");
    const domain = members[0].domain;
    const address = `${generateRandomString()}@${domain}`;
    const password = generateRandomString(18);

    const accRes = await fetch(`${apiBase}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
    });
    const accData = await accRes.json().catch(() => ({}));
    if (!accRes.ok) throw new Error(accData.message || "Failed to create Hydra account");

    const tokenRes = await fetch(`${apiBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ address, password })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.token) throw new Error("Failed to authenticate with Hydra");

    return {
        id: accData.id,
        address,
        provider: 'hydra',
        apiBase,
        token: tokenData.token,
        password,
        createdAt: Date.now()
    };
};

const fetchHydraMessages = async (apiBase, token) => {
    const res = await fetch(`${apiBase}/messages`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/ld+json' },
        cache: 'no-store'
    });
    if (!res.ok) throw new Error(`Hydra messages failed: HTTP ${res.status}`);
    const data = await res.json();
    const members = Array.isArray(data?.['hydra:member']) ? data['hydra:member'].filter(m => !m.isDeleted) : [];

    return members.map(m => ({
        id: String(m.id),
        from: { name: m.from?.name || m.from?.address || 'Unknown', address: m.from?.address || '' },
        subject: m.subject || '(No subject)',
        intro: m.intro || '',
        date: m.createdAt || '',
        seen: Boolean(m.seen),
        rawBody: ''
    }));
};

const fetchHydraDetail = async (apiBase, token, id) => {
    const res = await fetch(`${apiBase}/messages/${encodeURIComponent(id)}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/ld+json' },
        cache: 'no-store'
    });
    if (!res.ok) throw new Error(`Hydra detail failed: HTTP ${res.status}`);
    const msg = await res.json();
    return {
        from: msg.from?.name ? `${msg.from.name} <${msg.from.address}>` : (msg.from?.address || ''),
        subject: msg.subject || '(No subject)',
        html: msg.html?.[0] || '',
        text: msg.text || ''
    };
};

// ── Multi-Provider Orchestrator ──
const createAccount = async () => {
    clearError();
    if (loadingText) loadingText.textContent = "Connecting to secure provider...";
    showState(stateLoading);

    try {
        // Step 1: Try Guerrilla Mail (instant, highest reliability)
        try {
            currentAccount = await createGuerrillaMailbox();
        } catch (guerrillaErr) {
            console.warn("Guerrilla creation failed, trying Mail.tm...", guerrillaErr);
            if (loadingText) loadingText.textContent = "Trying backup provider...";
            
            // Step 2: Try Mail.tm
            try {
                currentAccount = await createHydraMailbox(MAIL_TM_API);
            } catch (mailTmErr) {
                console.warn("Mail.tm creation failed, trying Mail.gw...", mailTmErr);
                
                // Step 3: Try Mail.gw
                currentAccount = await createHydraMailbox(MAIL_GW_API);
            }
        }

        await saveAccountToStorage(currentAccount);
        cachedMessages.clear();
        renderActiveState();
        fetchMessages();
        startPolling();
    } catch (err) {
        console.error("All providers failed to create mailbox:", err);
        showState(stateNoAccount);
        showError("Unable to create mailbox. Please check your internet connection and try again.");
    }
};

const deleteAccount = async () => {
    if (!currentAccount) return;
    showState(stateLoading);
    if (loadingText) loadingText.textContent = "Destroying mailbox...";
    stopPolling();

    try {
        if (currentAccount.provider === 'guerrilla') {
            await fetch(`${GUERRILLA_API}?f=del_email&email_ids%5B%5D=all&sid_token=${encodeURIComponent(currentAccount.token)}`).catch(() => {});
        } else if (currentAccount.provider === 'hydra' && currentAccount.apiBase) {
            await fetch(`${currentAccount.apiBase}/accounts/${encodeURIComponent(currentAccount.id)}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${currentAccount.token}` }
            }).catch(() => {});
        }
    } catch (err) {
        console.warn("Account deletion request failed", err);
    }

    await removeAccountFromStorage();
    currentAccount = null;
    cachedMessages.clear();
    try {
        chrome.action.setBadgeText({ text: "" });
    } catch {}
    clearError();
    showState(stateNoAccount);
};

const fetchMessages = async () => {
    if (!currentAccount) return;
    try {
        let activeMsgs = [];
        if (currentAccount.provider === 'guerrilla') {
            activeMsgs = await fetchGuerrillaMessages(currentAccount.token);
        } else if (currentAccount.provider === 'hydra' || currentAccount.token) {
            const apiBase = currentAccount.apiBase || MAIL_TM_API;
            activeMsgs = await fetchHydraMessages(apiBase, currentAccount.token);
        }

        // Cache message details in memory
        activeMsgs.forEach(m => cachedMessages.set(m.id, m));
        renderMessages(activeMsgs);
    } catch (err) {
        console.warn("Message fetch failed", err);
    }
};

const fetchMessageDetail = async (id) => {
    detailLoading.classList.remove("hidden");
    detailFrame.classList.add("hidden");
    showState(stateMessageDetail);

    try {
        let msg = null;
        if (currentAccount?.provider === 'guerrilla') {
            msg = await fetchGuerrillaDetail(currentAccount.token, id);
        } else if (currentAccount?.provider === 'hydra' || currentAccount?.token) {
            const apiBase = currentAccount.apiBase || MAIL_TM_API;
            msg = await fetchHydraDetail(apiBase, currentAccount.token, id);
        }

        if (!msg) throw new Error("No message data returned");

        detailFrom.textContent = `From: ${msg.from}`;
        detailSubject.textContent = msg.subject;

        const doc = detailFrame.contentDocument;
        if (!doc) throw new Error("Message frame unavailable");
        doc.open();
        doc.write(`<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline';"><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:12px;word-break:break-word;color:#111827;line-height:1.5}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font-family:inherit;}</style></head><body></body></html>`);
        doc.close();

        const bodyNode = doc.body;
        if (msg.html) {
            const template = doc.createElement('template');
            template.innerHTML = String(msg.html);
            template.content.querySelectorAll('script,iframe,object,embed,form,input,textarea,button').forEach(node => node.remove());
            template.content.querySelectorAll('*').forEach(node => {
                [...node.attributes].forEach(attr => {
                    if (/^on/i.test(attr.name) || /^(javascript|data|file|blob|chrome|resource):/i.test(attr.value.trim())) {
                        node.removeAttribute(attr.name);
                    }
                });
            });
            bodyNode.replaceChildren(template.content.cloneNode(true));
        } else {
            const pre = doc.createElement('pre');
            pre.textContent = msg.text || '';
            bodyNode.replaceChildren(pre);
        }

        detailLoading.classList.add("hidden");
        detailFrame.classList.remove("hidden");
    } catch (err) {
        console.error("Error loading message detail:", err);
        detailLoading.textContent = "Error loading message. Please go back and try again.";
    }
};

const renderActiveState = () => {
    showState(stateActive);
    emailAddressInput.value = currentAccount?.address || '';
};

const renderMessages = (activeMsgs) => {
    msgCount.textContent = String(activeMsgs.length);
    try {
        chrome.action.setBadgeText({ text: activeMsgs.length > 0 ? String(activeMsgs.length) : "" });
        chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    } catch {}

    messageList.replaceChildren();
    if (activeMsgs.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        empty.textContent = 'No emails yet. Waiting for incoming mail...';
        messageList.appendChild(empty);
        return;
    }

    activeMsgs.forEach(msg => {
        const li = document.createElement("li");
        li.className = "msg-item";
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';
        const textWrap = document.createElement('div');
        textWrap.style.cssText = 'flex:1;min-width:0;overflow:hidden;';
        const from = document.createElement('div');
        from.className = 'msg-from';
        from.textContent = msg.from?.name || msg.from?.address || 'Unknown sender';
        const subject = document.createElement('div');
        subject.className = 'msg-subject';
        subject.style.cssText = 'max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        subject.textContent = msg.subject || '(No subject)';
        textWrap.append(from, subject);
        row.appendChild(textWrap);

        const otpMatch = extractOTP(msg.subject) || extractOTP(msg.intro);
        if (otpMatch) {
            const copyButton = document.createElement('button');
            copyButton.className = 'btn-icon copy-otp-btn';
            copyButton.type = 'button';
            copyButton.textContent = `Copy ${otpMatch}`;
            copyButton.dataset.otp = otpMatch;
            copyButton.title = 'Copy OTP';
            copyButton.style.cssText = 'padding:4px 8px;border:1px solid var(--border-color);border-radius:6px;font-size:12px;font-weight:600;background:var(--bg-dark);color:var(--text-primary);transition:all .2s;cursor:pointer;';
            row.appendChild(copyButton);
        }
        li.appendChild(row);
        li.addEventListener('click', async (e) => {
            const copyBtn = e.target.closest('.copy-otp-btn');
            if (copyBtn) {
                e.stopPropagation();
                try { await navigator.clipboard.writeText(copyBtn.dataset.otp || ''); } catch {}
                const previous = copyBtn.textContent;
                copyBtn.textContent = 'Copied';
                copyBtn.style.color = '#22c55e';
                setTimeout(() => { copyBtn.textContent = previous; copyBtn.style.color = 'var(--text-primary)'; }, 1500);
                return;
            }
            fetchMessageDetail(msg.id);
        });
        messageList.appendChild(li);
    });
};

const startPolling = () => {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(fetchMessages, 4000);
};

const stopPolling = () => {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
};

btnCreate.addEventListener('click', createAccount);
btnDelete.addEventListener('click', deleteAccount);
btnBackToInbox.addEventListener('click', renderActiveState);

btnRefresh.addEventListener('click', () => {
    const icon = btnRefresh.querySelector("svg");
    icon?.classList.add("spinner");
    fetchMessages().finally(() => icon?.classList.remove("spinner"));
});

btnCopy.addEventListener('click', async () => {
    if (!currentAccount?.address) return;
    try { await navigator.clipboard.writeText(currentAccount.address); } catch {}
    const original = btnCopy.innerHTML;
    btnCopy.textContent = 'Copied';
    setTimeout(() => { btnCopy.innerHTML = original; }, 1500);
});

// Initialize on popup open
getAccountFromStorage().then(account => {
    if (account?.address && account?.token) {
        currentAccount = account;
        renderActiveState();
        fetchMessages();
        startPolling();
    } else {
        showState(stateNoAccount);
    }
}).catch(() => showState(stateNoAccount));
