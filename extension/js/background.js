const GUERRILLA_API = "https://api.guerrillamail.com/ajax.php";
const MAIL_TM_API = "https://api.mail.tm";

chrome.runtime.onInstalled.addListener(() => {
    if (chrome.storage?.session?.setAccessLevel) {
        chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
    }
    chrome.contextMenus.create({
        id: "insert-mephisto",
        title: "Insert MephistoMail Address",
        contexts: ["editable"]
    });
    chrome.alarms.create("checkInbox", { periodInMinutes: 1 });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== "insert-mephisto" || !tab?.id) return;
    const [{ result: isAllowed }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Boolean(document.activeElement &&
            (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA") &&
            !document.activeElement.readOnly && !document.activeElement.disabled)
    }).catch(() => [{ result: false }]);
    if (!isAllowed) return;

    chrome.storage.session.get(["mephistoAccount"], (result) => {
        const account = result?.mephistoAccount;
        if (account?.address) {
            chrome.tabs.sendMessage(tab.id, { action: "insertEmail", email: account.address }).catch(() => {});
        } else {
            chrome.notifications.create({
                type: "basic",
                iconUrl: "icons/icon128.png",
                title: "MephistoMail",
                message: "Generate a temporary mailbox in the extension popup first."
            });
        }
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "checkInbox") checkNewEmails();
});

async function checkNewEmails() {
    chrome.storage.session.get(["mephistoAccount"], async (result) => {
        const acc = result?.mephistoAccount;
        if (!acc?.token) return;

        try {
            let unread = 0;
            if (acc.provider === 'guerrilla') {
                const res = await fetch(`${GUERRILLA_API}?f=get_email_list&offset=0&sid_token=${encodeURIComponent(acc.token)}`, { cache: 'no-store' });
                if (!res.ok) return;
                const data = await res.json();
                const list = Array.isArray(data?.list) ? data.list : [];
                unread = list.filter(m => m.mail_read === 0 || m.mail_read === '0').length;
            } else {
                const apiBase = acc.apiBase || MAIL_TM_API;
                const res = await fetch(`${apiBase}/messages`, {
                    headers: { "Authorization": `Bearer ${acc.token}`, "Accept": "application/ld+json" },
                    cache: 'no-store'
                });
                if (!res.ok) return;
                const data = await res.json();
                const messages = Array.isArray(data?.["hydra:member"]) ? data["hydra:member"] : [];
                unread = messages.filter(m => m.seen === false || m.seen === undefined).length;
            }
            chrome.action.setBadgeText({ text: unread > 0 ? String(Math.min(unread, 99)) : "" });
            chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
        } catch {}
    });
}
