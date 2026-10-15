'use strict';

/**
 * Backup and restore of all windows, tabs, groups, window names and stored
 * tabs as a JSON file.
 *
 * Import treats the file as untrusted: it is size-limited, every field is
 * type-checked and length-limited, and only web URLs (http, https, ftp) are
 * used, so a crafted file cannot plant javascript: bookmarklets or open
 * privileged pages. Restored tabs open unloaded, so large backups are quick.
 *
 * Format (version 1):
 * {
 *   "format": "tabcentral-backup", "version": 1, "created": "<ISO date>",
 *   "windows": [{ "name": "", "groups": [{ "title", "color", "collapsed" }],
 *                 "tabs": [{ "url", "title", "pinned", "muted", "group": <index into groups or -1> }] }],
 *   "stored": [{ "title", "items": [{ "type": "tab", "url", "title" } | { "type": "group", "title", "tabs": [...] }] }]
 * }
 */

const BACKUP_FORMAT = 'tabcentral-backup';
const BACKUP_VERSION = 1;
const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
const BACKUP_MAX_WINDOWS = 500;
const BACKUP_MAX_TABS = 25000;
const BACKUP_MAX_STORED = 2000;
const BACKUP_MAX_GROUPS = 1000;

/* Export */

async function exportBackup()
{
	const [tabs, groups] = await Promise.all([
		browser.tabs.query({ windowType: 'normal' }),
		HAS_GROUPS ? browser.tabGroups.query({}) : [],
	]);
	const groupsById = new Map(groups.map(group => [group.id, group]));
	const data = { format: BACKUP_FORMAT, version: BACKUP_VERSION, created: new Date().toISOString(), windows: [], stored: [] };
	let tabCount = 0;

	// Same window order as the page: current window first.
	for (const win of state.windows)
	{
		const windowTabs = tabs.filter(tab => tab.windowId === win.id && !(tab.url || '').startsWith(OWN_PREFIX)).sort((a, b) => a.index - b.index);
		if (!windowTabs.length)
		{
			continue;
		}
		const groupIndex = new Map();
		const windowGroups = [];
		const entries = windowTabs.map(tab =>
		{
			const groupId = groupIdOf(tab);
			if (groupId !== NO_GROUP && !groupIndex.has(groupId))
			{
				const group = groupsById.get(groupId);
				groupIndex.set(groupId, windowGroups.length);
				windowGroups.push({ title: group?.title || '', color: group?.color || 'grey', collapsed: !!group?.collapsed });
			}
			return {
				url: tab.url,
				title: tab.title || '',
				pinned: tab.pinned,
				muted: !!tab.mutedInfo?.muted,
				group: groupId === NO_GROUP ? -1 : groupIndex.get(groupId),
			};
		});
		tabCount += entries.length;
		data.windows.push({ name: win.name || '', groups: windowGroups, tabs: entries });
	}

	const storedTab = tab => ({ type: 'tab', url: tab.url, title: tab.title });
	data.stored = state.stored.map(set => ({
		title: set.title,
		items: set.items.map(item => item.type === 'group' ? { type: 'group', title: item.title, tabs: item.tabs.map(storedTab) } : storedTab(item)),
	}));

	const now = new Date();
	const pad = n => String(n).padStart(2, '0');
	const name = `tabcentral-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
	downloadFile(name, JSON.stringify(data, null, '\t'), 'application/json');
	showToast(`Backup of ${plural(data.windows.length, '1 window', '# windows')} and ${plural(tabCount, '1 tab', '# tabs')} downloaded`);
}

function downloadFile(name, text, type)
{
	const url = URL.createObjectURL(new Blob([text], { type }));
	const link = el('a', { href: url, download: name });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* Import */

// Must run synchronously from the click: browsers only open file pickers during a user action.
function pickBackupFile()
{
	const input = $('#backup-file');
	input.value = '';
	input.click();
}

async function importBackup(file)
{
	if (file.size > BACKUP_MAX_BYTES)
	{
		throw new Error('This file is too large to be a TabCentral backup.');
	}
	let raw;
	try
	{
		raw = JSON.parse(await file.text());
	}
	catch (err)
	{
		throw new Error('This file is not a TabCentral backup (it is not valid JSON).');
	}

	const backup = validateBackup(raw);
	const choice = await backupDialog(backup);
	if (!choice)
	{
		return;
	}

	const windows = backup.windows.filter((win, i) => choice.windows.has(i));
	const total = windows.reduce((sum, win) => sum + win.tabs.length, 0);
	let failed = 0;
	let done = 0;
	for (const win of windows)
	{
		failed += await restoreBackupWindow(win, () =>
		{
			done++;
			if (done % 25 === 0 || done === total)
			{
				setBusyText(`Restoring tabs… ${done} / ${total}`);
			}
		});
	}
	if (choice.stored)
	{
		setBusyText('Restoring stored tabs…');
		await restoreBackupStored(backup.stored);
	}
	setBusyText('');
	if (windows.length)
	{
		await refocusSelf();
	}

	const parts = [];
	if (windows.length)
	{
		parts.push(`${plural(windows.length, '1 window', '# windows')} with ${plural(total - failed, '1 tab', '# tabs')}`);
	}
	if (choice.stored)
	{
		parts.push(plural(backup.stored.length, '1 stored set', '# stored sets'));
	}
	showToast(`Restored ${parts.join(' and ')}` + (failed ? `; ${plural(failed, '1 tab', '# tabs')} could not be opened` : ''), failed > 0);
}

/**
 * Returns a clean copy of the backup with only known fields of the right type
 * and length, or throws with a readable message.
 */
function validateBackup(raw)
{
	const fail = reason =>
	{
		throw new Error(`This file is not a usable TabCentral backup: ${reason}.`);
	};
	if (!raw || typeof raw !== 'object' || raw.format !== BACKUP_FORMAT)
	{
		fail('unknown file format');
	}
	if (raw.version !== BACKUP_VERSION)
	{
		fail(`unsupported version "${String(raw.version).slice(0, 20)}"`);
	}

	const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
	let tabCount = 0;
	let skipped = 0;
	const cleanTab = value =>
	{
		const url = value && typeof value === 'object' ? text(value.url, 8192) : '';
		if (!canStore(url) || tabCount >= BACKUP_MAX_TABS)
		{
			skipped++;
			return null;
		}
		tabCount++;
		return { url, title: text(value.title, 1024) || url, pinned: value.pinned === true, muted: value.muted === true, group: Number.isInteger(value.group) ? value.group : -1 };
	};

	const windows = [];
	for (const win of Array.isArray(raw.windows) ? raw.windows.slice(0, BACKUP_MAX_WINDOWS) : [])
	{
		if (!win || typeof win !== 'object' || !Array.isArray(win.tabs))
		{
			continue;
		}
		const groups = (Array.isArray(win.groups) ? win.groups.slice(0, BACKUP_MAX_GROUPS) : []).map(group => ({
			title: text(group?.title, 256),
			color: GROUP_COLORS.includes(group?.color) ? group.color : 'grey',
			collapsed: group?.collapsed === true,
		}));
		const tabs = win.tabs.map(cleanTab).filter(Boolean);
		for (const tab of tabs)
		{
			// Pinned tabs cannot be grouped; unknown group indexes mean no group.
			if (tab.pinned || tab.group < 0 || tab.group >= groups.length)
			{
				tab.group = -1;
			}
		}
		if (tabs.length)
		{
			windows.push({ name: text(win.name, 100), groups, tabs });
		}
	}

	const stored = [];
	for (const set of Array.isArray(raw.stored) ? raw.stored.slice(0, BACKUP_MAX_STORED) : [])
	{
		if (!set || typeof set !== 'object' || !Array.isArray(set.items))
		{
			continue;
		}
		const items = [];
		for (const item of set.items)
		{
			if (item?.type === 'group' && Array.isArray(item.tabs))
			{
				const tabs = item.tabs.map(cleanTab).filter(Boolean).map(tab => ({ url: tab.url, title: tab.title }));
				if (tabs.length)
				{
					items.push({ type: 'group', title: text(item.title, 256), tabs });
				}
			}
			else
			{
				const tab = cleanTab(item);
				if (tab)
				{
					items.push({ type: 'tab', url: tab.url, title: tab.title });
				}
			}
		}
		if (items.length)
		{
			stored.push({ title: text(set.title, 200) || 'Imported tabs', items });
		}
	}

	if (!windows.length && !stored.length)
	{
		fail('it contains no tabs that can be restored');
	}
	const created = new Date(text(raw.created, 40));
	return { created: isNaN(created) ? null : created, windows, stored, skipped };
}

// Asks which windows (and whether the stored tabs) to restore. Resolves to {windows: Set<index>, stored} or null.
async function backupDialog(backup)
{
	const dialog = $('#backup-dialog');
	const list = $('#backup-windows');
	const tabTotal = backup.windows.reduce((sum, win) => sum + win.tabs.length, 0);

	$('#backup-summary').textContent = (backup.created ? `Backup from ${backup.created.toLocaleString()}: ` : '')
		+ `${plural(backup.windows.length, '1 window', '# windows')} with ${plural(tabTotal, '1 tab', '# tabs')}`
		+ (backup.stored.length ? `, ${plural(backup.stored.length, '1 stored set', '# stored sets')}` : '')
		+ (backup.skipped ? `. ${plural(backup.skipped, '1 entry', '# entries')} cannot be opened by an extension and will be skipped.` : '.');

	list.replaceChildren(...backup.windows.map((win, i) => el('label', { class: 'check-row' },
		el('input', { type: 'checkbox', checked: true, dataset: { index: i } }),
		el('span', { text: `${win.name || `Window ${i + 1}`} (${plural(win.tabs.length, '1 tab', '# tabs')})` }),
	)));
	const storedRow = $('#backup-stored-row');
	storedRow.hidden = !backup.stored.length || !HAS_BOOKMARKS;
	$('#backup-stored').checked = !storedRow.hidden;
	$('#backup-stored-label').textContent = `Stored tabs (${plural(backup.stored.length, '1 set', '# sets')}), added to your stored tabs`;

	dialog.returnValue = '';
	dialog.showModal();
	if (!await waitForClose(dialog))
	{
		return null;
	}
	const windows = new Set([...list.querySelectorAll('input:checked')].map(input => Number(input.dataset.index)));
	const stored = !storedRow.hidden && $('#backup-stored').checked;
	return windows.size || stored ? { windows, stored } : null;
}

// Restores one window; returns the number of tabs that could not be opened.
async function restoreBackupWindow(win, onTab)
{
	const created = await browser.windows.create({});
	const blankIds = (created.tabs || []).map(tab => tab.id);
	const opened = [];
	let failed = 0;

	for (const tab of win.tabs)
	{
		try
		{
			const newTab = await browser.tabs.create({ windowId: created.id, url: tab.url, title: tab.title, discarded: true, active: false });
			opened.push({ id: newTab.id, tab });
		}
		catch (err)
		{
			console.error(tab.url, err);
			failed++;
		}
		onTab();
	}

	// Pinning in the original order keeps the pinned tabs in that order.
	for (const { id, tab } of opened)
	{
		if (tab.pinned || tab.muted)
		{
			await browser.tabs.update(id, { pinned: tab.pinned, muted: tab.muted });
		}
	}
	if (HAS_GROUPS)
	{
		for (let i = 0; i < win.groups.length; i++)
		{
			const ids = opened.filter(entry => entry.tab.group === i).map(entry => entry.id);
			if (ids.length)
			{
				const groupId = await browser.tabs.group({ tabIds: ids, createProperties: { windowId: created.id } });
				await browser.tabGroups.update(groupId, win.groups[i]);
			}
		}
	}
	if (HAS_SESSIONS && win.name)
	{
		await setWindowName(created.id, win.name);
	}
	if (opened.length && blankIds.length)
	{
		await browser.tabs.remove(blankIds);
	}
	return failed;
}

// Adds the stored sets as new folders; the newest set of the backup ends up on top.
async function restoreBackupStored(sets)
{
	const rootId = await findStoredRoot(true);
	for (const set of [...sets].reverse())
	{
		const folder = await browser.bookmarks.create({ parentId: rootId, title: set.title, index: 0 });
		for (const item of set.items)
		{
			if (item.type === 'tab')
			{
				await browser.bookmarks.create({ parentId: folder.id, title: item.title, url: item.url });
				continue;
			}
			const groupFolder = await browser.bookmarks.create({ parentId: folder.id, title: item.title });
			for (const tab of item.tabs)
			{
				await browser.bookmarks.create({ parentId: groupFolder.id, title: tab.title, url: tab.url });
			}
		}
	}
}
