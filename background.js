'use strict';

const PAGE_URL = browser.runtime.getURL('tabs.html');

// Open the manager, or bring an existing manager tab to the window the button was clicked in.
browser.action.onClicked.addListener(async (activeTab) =>
{
	const windowId = activeTab.windowId;
	const tabs = await browser.tabs.query({});
	const existing = tabs.find(tab => tab.url && tab.url.startsWith(PAGE_URL));

	if (!existing)
	{
		await browser.tabs.create({ url: PAGE_URL, windowId });
		return;
	}

	if (existing.windowId !== windowId)
	{
		await browser.tabs.move(existing.id, { windowId, index: -1 });
	}
	await browser.tabs.update(existing.id, { active: true });
	await browser.windows.update(windowId, { focused: true });
});

/**
 * Window names live in session data and survive a restart, but the title
 * preface that shows them in the OS window title does not. Reapply it after
 * startup; a second pass catches windows that session restore brings back late.
 */
async function applyTitlePreface(windowId)
{
	const name = await browser.sessions.getWindowValue(windowId, 'name');
	if (typeof name === 'string' && name)
	{
		await browser.windows.update(windowId, { titlePreface: `${name} — ` });
	}
}

async function applyTitlePrefaces()
{
	for (const win of await browser.windows.getAll({ windowTypes: ['normal'] }))
	{
		await applyTitlePreface(win.id).catch(console.error);
	}
}

browser.runtime.onStartup.addListener(() =>
{
	applyTitlePrefaces().catch(console.error);
	setTimeout(() => applyTitlePrefaces().catch(console.error), 10000);
});

// Windows restored later (session restore, "Reopen closed window") get their values a moment after they open.
browser.windows.onCreated.addListener(win =>
{
	for (const delay of [1000, 5000])
	{
		setTimeout(() => applyTitlePreface(win.id).catch(() => {}), delay);
	}
});
